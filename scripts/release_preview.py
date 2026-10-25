"""Select an existing GitHub preview and verify the same bytes for npm promotion."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
from urllib.request import Request, urlopen

REPOSITORY = 'originchaindb/mcp-server'
PACKAGE = '@originchain/mcp-server'


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def validate(version, package, ref, repository, allow_review=False):
    source_allowed = ref == 'refs/heads/main' or (allow_review and re.fullmatch(r'refs/pull/[1-9][0-9]*/merge', ref or ''))
    if not source_allowed or repository != REPOSITORY:
        raise ValueError('Promotion must run on the canonical main branch')
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rc\.[1-9][0-9]*', version):
        raise ValueError('Only existing X.Y.Z-rc.N previews can be promoted')
    if package.get('name') != PACKAGE or package.get('version') != version:
        raise ValueError('Requested version must match current source package metadata')
    if package.get('repository', {}).get('url') != 'git+https://github.com/' + REPOSITORY + '.git':
        raise ValueError('Repository metadata must match the trusted publisher')
    return {'version': version, 'tag': 'v' + version, 'dist_tag': 'next',
            'archive': 'originchain-mcp-server-' + version + '.tgz'}


def verify_archive(directory, package):
    directory = Path(directory)
    selected = load(directory / 'selected-preview.json')
    proof = load(directory / 'RELEASE-VERIFICATION.json')
    expected = validate(selected['version'], package, 'refs/heads/main', REPOSITORY)
    if any(selected.get(key) != value for key, value in expected.items()):
        raise ValueError('Selected preview metadata changed')
    if not re.fullmatch('[0-9a-f]{40}', selected.get('head', '')):
        raise ValueError('Preview source commit is invalid')
    if proof.get('head') != selected['head'] or proof.get('version') != selected['version']:
        raise ValueError('GitHub proof identifies another source/version')
    for key, value in {'passed': True, 'ci_jobs': 7, 'tests_per_runtime': 62,
                       'source_runtimes': [20, 22, 24], 'installed_runtimes': [20, 22, 24],
                       'readme_cases': 17}.items():
        if proof.get(key) != value:
            raise ValueError('GitHub proof lacks required acceptance: ' + key)
    archives = list(directory.glob('*.tgz'))
    if len(archives) != 1 or archives[0].name != selected['archive']:
        raise ValueError('Expected exactly the selected archive')
    archive = archives[0]
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != proof.get('sha256') or digest != selected.get('sha256'):
        raise ValueError('Archive differs from verified GitHub bytes')
    with tarfile.open(archive) as packed:
        members = packed.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)):
            raise ValueError('Duplicate package members')
        for member in members:
            parts = Path(member.name).parts
            if not member.isfile() or not member.name.startswith('package/') or '..' in parts:
                raise ValueError('Unsafe package member')
        if json.load(packed.extractfile('package/package.json')) != package:
            raise ValueError('Archive package metadata differs from source')
    return selected, archive


def verify_source(directory, source):
    source = Path(source)
    selected, archive = verify_archive(directory, load(source / 'package.json'))
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    if commit != selected['head']:
        raise ValueError('Checkout is not the tagged release source')
    with tarfile.open(archive) as packed:
        for member in packed.getmembers():
            relative = member.name.removeprefix('package/')
            file = source / relative
            if not file.is_file() or packed.extractfile(member).read() != file.read_bytes():
                raise ValueError('Released package differs from built tagged source: ' + relative)
    return selected


def attest(directory, runtime):
    directory = Path(directory)
    selected, _ = verify_archive(directory, load('package.json'))
    log = (directory / ('tests-node' + runtime + '.log')).read_text(encoding='utf-8')
    for summary in ('tests 62', 'pass 62', 'fail 0', 'cancelled 0', 'skipped 0'):
        if not re.search(r'(?:#|ℹ) ' + summary + r'(?:\r?\n|$)', log):
            raise ValueError('Missing passing test summary: ' + summary)
    readme = load(directory / ('readme-node' + runtime + '.json'))
    if not readme.get('all_passed') or len(readme.get('cases', [])) != 17:
        raise ValueError('README fixture did not pass all cases')
    if readme.get('package_version') != selected['version']:
        raise ValueError('README fixture used another package version')
    executable = load(directory / ('installed-executable-node' + runtime + '.json'))
    if not executable.get('all_passed') or len(executable.get('cases', [])) != 17 or executable.get('package_version') != selected['version']:
        raise ValueError('Fresh installed executable did not pass all cases')
    audit = load(directory / ('audit-node' + runtime + '.json'))
    if audit.get('metadata', {}).get('vulnerabilities', {}).get('total') != 0:
        raise ValueError('Installed dependency audit is not clean')
    receipt = dict(selected, runtime=runtime, passed=True, stdio_cases=62, readme_cases=17, direct_executable_cases=17,
                   workflow_sha=os.environ['GITHUB_SHA'])
    write(directory / ('acceptance-node' + runtime + '.json'), receipt)


def verify_acceptance(directory, package, workflow_sha):
    directory = Path(directory)
    selected, archive = verify_archive(directory, package)
    if selected.get('workflow_sha') != workflow_sha:
        raise ValueError('Candidate was selected by another workflow source')
    for runtime in ('20', '22', '24'):
        receipt = load(directory / ('acceptance-node' + runtime + '.json'))
        expected = dict(selected, runtime=runtime, passed=True, stdio_cases=62, readme_cases=17, direct_executable_cases=17,
                        workflow_sha=workflow_sha)
        if receipt != expected:
            raise ValueError('Missing or mismatched packed acceptance for Node ' + runtime)
    return selected, archive


def prepare(directory):
    package = load('package.json')
    selected = validate(os.environ['RELEASE_VERSION'], package, os.environ['GITHUB_REF'], os.environ['GITHUB_REPOSITORY'],
                        allow_review=os.environ.get('PREVIEW_VERIFY_ONLY') == '1')
    def api(path):
        return json.loads(subprocess.check_output(['gh', 'api', 'repos/' + REPOSITORY + path], text=True))
    release = api('/releases/tags/' + selected['tag'])
    if release.get('draft') or not release.get('prerelease') or release.get('tag_name') != selected['tag']:
        raise ValueError('Expected a public GitHub prerelease')
    tag = api('/git/ref/tags/' + selected['tag'])['object']
    if tag['type'] != 'commit' or not re.fullmatch('[0-9a-f]{40}', tag['sha']):
        raise ValueError('Expected a direct commit tag')
    selected.update(head=tag['sha'], workflow_sha=os.environ['GITHUB_SHA'])
    subprocess.run(['git', 'merge-base', '--is-ancestor', selected['head'], 'HEAD'], check=True)
    subprocess.run(['git', 'diff', '--exit-code', selected['head'], 'HEAD', '--',
                    'src', 'package.json', 'package-lock.json', 'tsconfig.json'], check=True)
    directory = Path(directory)
    directory.mkdir()
    required = {selected['archive'], 'RELEASE-VERIFICATION.json'}
    assets = {asset['name']: asset for asset in release['assets']}
    if not required <= assets.keys():
        raise ValueError('GitHub release lacks required package/proof assets')
    for name in required:
        url = 'https://github.com/' + REPOSITORY + '/releases/download/' + selected['tag'] + '/' + name
        if assets[name]['browser_download_url'] != url:
            raise ValueError('Unexpected release asset URL')
        with urlopen(Request(url, headers={'User-Agent': 'OriginChain-MCP-release-verifier'}), timeout=60) as response:
            (directory / name).write_bytes(response.read())
    selected['sha256'] = load(directory / 'RELEASE-VERIFICATION.json')['sha256']
    write(directory / 'selected-preview.json', selected)
    verify_archive(directory, package)
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        for key in ('version', 'head', 'archive'):
            output.write(key + '=' + selected[key] + '\n')
    print(json.dumps(selected))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'verify-source', 'attest'])
    parser.add_argument('directory')
    parser.add_argument('value', nargs='?')
    args = parser.parse_args()
    if args.action == 'prepare':
        prepare(args.directory)
    elif args.action == 'verify-source':
        print(json.dumps(verify_source(args.directory, args.value)))
    else:
        attest(args.directory, args.value)
