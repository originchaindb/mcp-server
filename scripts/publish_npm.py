"""Promote the verified GitHub archive to npm's next tag through OIDC."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import urlopen

from release_preview import load, validate, verify_acceptance, write

REGISTRY = 'https://registry.npmjs.org/@originchain%2fmcp-server'


def read_json(url):
    try:
        with urlopen(url, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code == 404:
            return None
        raise


def check_existing(metadata, digest, version):
    if metadata is None:
        return False
    if metadata.get('name') != '@originchain/mcp-server' or metadata.get('version') != version:
        raise ValueError('Registry metadata mismatch')
    url = metadata.get('dist', {}).get('tarball', '')
    if not url.startswith('https://registry.npmjs.org/@originchain/mcp-server/-/'):
        raise ValueError('Unexpected registry archive location')
    with urlopen(url, timeout=30) as response:
        public = hashlib.sha256(response.read()).hexdigest()
    if public != digest:
        raise ValueError('Existing npm version has different bytes; refusing publication')
    return True


def publish_command(archive):
    # A relative path without ./ can be parsed by npm as a GitHub shorthand.
    return ['npm', 'publish', str(Path(archive).resolve()), '--ignore-scripts', '--access', 'public',
            '--provenance', '--tag', 'next', '--registry=https://registry.npmjs.org']


def main(directory):
    directory = Path(directory)
    package = load('package.json')
    validate(package['version'], package, os.environ['GITHUB_REF'], os.environ['GITHUB_REPOSITORY'])
    selected, archive = verify_acceptance(directory, package, os.environ['GITHUB_SHA'])
    before = (read_json(REGISTRY) or {}).get('dist-tags', {})
    resumed = check_existing(read_json(REGISTRY + '/' + selected['version']), selected['sha256'], selected['version'])
    if not resumed:
        subprocess.run(publish_command(archive), check=True)
    for _ in range(12):
        metadata = read_json(REGISTRY + '/' + selected['version'])
        if metadata is not None:
            break
        time.sleep(5)
    else:
        raise RuntimeError('Published version is not yet visible')
    check_existing(metadata, selected['sha256'], selected['version'])
    after = read_json(REGISTRY)['dist-tags']
    if after.get('next') != selected['version'] or after.get('latest') != before.get('latest'):
        raise ValueError('Unexpected npm dist-tags after preview publication')
    receipt = dict(selected, registry_tarball=metadata['dist']['tarball'], public_bytes_match=True,
                   resumed_existing_version=resumed, tags_before=before, tags_after=after)
    write(directory / 'npm-publication.json', receipt)
    print(json.dumps(receipt))


if __name__ == '__main__':
    main(sys.argv[1])
