# Publishing

A release reaches users in two places:

1. **npm**, as the package `@originchain-db/mcp-server`.
2. **The MCP Registry** (`registry.modelcontextprotocol.io`), as the server
   `io.github.originchaindb/mcp-server`. The registry stores only the metadata
   in [`server.json`](server.json), which points at the npm version; it does not
   host the package.

Nothing in this repository's CI publishes to the MCP Registry. A maintainer runs
the steps below by hand. The registry is in preview, so its rules can change:
check its [quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)
and [authentication](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx)
pages before a release.

## Before a release: set the version everywhere

The version appears in `package.json`, `package-lock.json`, both `version`
fields of `server.json`, the README's install commands and links,
`test/readme-fixture.mjs` (`VERSION`) and the archive name in
`.github/workflows/test.yml`.

```sh
npm version 0.4.0 --no-git-tag-version   # package.json and package-lock.json
npm run install-links                    # paste the new links into the README
npm test                                 # fails on any version left behind
npm run check:server-json -- --live      # server.json against the live registry schema
```

`npm test` includes `test/registry-metadata.test.mjs`, which validates
`server.json` against the registry's published schema (vendored as
`scripts/server.schema.json`) and against `package.json`, and
`test/install-links.test.mjs`, which decodes every README install link. The
`--live` check also reports whether the schema at `server.json`'s `$schema` URL
still matches the vendored copy. To move to a newer schema version, replace
`scripts/server.schema.json` with the published file, and update
`SCHEMA_SHA256` in `scripts/server-json.mjs` and `$schema` in `server.json`
together.

## 1. Publish the npm package first

The registry proves that the package belongs to this server by reading
`mcpName` from the **published** npm package's `package.json`, so the npm
version must exist, with `"mcpName": "io.github.originchaindb/mcp-server"`,
before the registry will accept `server.json`. Publish the version to npm, then
confirm:

```sh
npm view @originchain-db/mcp-server@0.4.0 mcpName
# io.github.originchaindb/mcp-server
```

## 2. Install `mcp-publisher`

Use a pinned release and verify it. This is the procedure the registry
documents for CI, with release `v1.8.9` (the latest on 2026-11-10); it needs
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/):

```sh
version=v1.8.9
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
archive="mcp-publisher_${os}_${arch}.tar.gz"
base="https://github.com/modelcontextprotocol/registry/releases/download/${version}"
curl --fail --location --silent --show-error --output "$archive" "$base/$archive"
curl --fail --location --silent --show-error --output "$archive.sigstore.json" "$base/$archive.sigstore.json"
cosign verify-blob --bundle "$archive.sigstore.json" \
  --certificate-identity "https://github.com/modelcontextprotocol/registry/.github/workflows/release.yml@refs/tags/${version}" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "$archive"
tar xzf "$archive" mcp-publisher
./mcp-publisher --help
```

On Windows the archive is `mcp-publisher_windows_amd64.tar.gz` (or `_arm64`)
and contains `mcp-publisher.exe`; Homebrew users can run
`brew install mcp-publisher`.

## 3. Validate

From the repository root, at the commit that was published to npm:

```sh
./mcp-publisher validate server.json
```

## 4. Log in with GitHub: an organization Owner, with a token

`io.github.originchaindb/*` is an **organization** namespace. The registry
grants it only to a GitHub account that is an **Owner** of the `originchaindb`
organization; ordinary membership is not enough.

Do not use the browser login (`mcp-publisher login github` without a token).
That device flow currently cannot publish to an organization namespace: its
GitHub App token cannot read organization memberships, so the registry grants
only the personal namespace `io.github.<your-username>/*`
([registry issue #1468](https://github.com/modelcontextprotocol/registry/issues/1468)).

Instead, an Owner of `originchaindb` creates a GitHub personal access token that
lets the registry read their organization role, and nothing else:

- **Classic token:** only the `read:org` scope.
- **Fine-grained token:** resource owner `originchaindb`, permission
  **Organization permissions → Members → Read-only**, and no repository access.

Without that permission the login still succeeds, but only for the personal
namespace, and `publish` then fails with "You do not have permission to
publish this server". Log in without leaving the token in your shell history:

```sh
read -rs GITHUB_PAT && ./mcp-publisher login github --token "$GITHUB_PAT"; unset GITHUB_PAT
```

The registry session this creates can publish, and overwrite, **any** server
under `io.github.originchaindb/*`. Log out when you are done, and delete the
personal access token if you will not use it again.

The other way to prove the organization role is GitHub Actions OIDC
(`mcp-publisher login github-oidc` in a workflow of this repository with
`permissions: id-token: write`). This repository has no such workflow; adding
one is a separate decision.

## 5. Publish and check

```sh
./mcp-publisher publish server.json
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.originchaindb/mcp-server"
./mcp-publisher logout
```

The search result must list `io.github.originchaindb/mcp-server` with the new
version. A published version cannot be changed; to withdraw one, use
`mcp-publisher status --status deprecated` (see the registry's
[CLI reference](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/cli/commands.md)).
