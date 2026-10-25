import copy
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from publish_npm import check_existing, publish_command
from release_preview import validate, verify_acceptance, verify_archive, verify_source, write

PACKAGE = {'name': '@originchain/mcp-server', 'version': '0.3.0-rc.1',
           'repository': {'url': 'git+https://github.com/originchaindb/mcp-server.git'}}
HEAD = 'a' * 40
WORKFLOW = 'b' * 40


class GateTests(unittest.TestCase):
    def check(self, **overrides):
        args = dict(version=PACKAGE['version'], package=PACKAGE, ref='refs/heads/main',
                    repository='originchaindb/mcp-server')
        args.update(overrides)
        return validate(**args)

    def test_preview_always_uses_next(self):
        self.assertEqual(self.check()['dist_tag'], 'next')

    def test_stable_and_invalid_versions_are_not_promoted(self):
        for version in ('0.2.0', '0.2.0-beta.1', 'v0.3.0-rc.1', '0.2.0-rc.0', '../archive', '00.3.0-rc.1'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                self.check(version=version)

    def test_wrong_source_or_metadata_is_rejected(self):
        for changes in ({'ref': 'refs/heads/feature'}, {'repository': 'other/mcp-server'},
                        {'package': dict(PACKAGE, version='0.2.0-rc.2')},
                        {'package': dict(PACKAGE, name='other')},
                        {'package': dict(PACKAGE, repository={'url': 'https://example.com'})}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.check(**changes)

    def test_review_mode_is_explicit_and_cannot_authorize_publishing(self):
        self.check(ref='refs/pull/5/merge', allow_review=True)
        with self.assertRaises(ValueError):
            self.check(ref='refs/pull/5/merge')
        with self.assertRaises(ValueError):
            self.check(ref='refs/heads/arbitrary', allow_review=True)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.selected = validate(PACKAGE['version'], PACKAGE, 'refs/heads/main', 'originchaindb/mcp-server')
        self.selected.update(head=HEAD, workflow_sha=WORKFLOW)
        self.archive = self.directory / self.selected['archive']
        self.package_bytes = json.dumps(PACKAGE).encode()
        self.pack()
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.selected['sha256'] = digest
        self.proof = dict(head=HEAD, version=PACKAGE['version'], sha256=digest, passed=True,
                          ci_jobs=7, tests_per_runtime=62, source_runtimes=[20, 22, 24],
                          installed_runtimes=[20, 22, 24], readme_cases=17)
        self.save()

    def pack(self, extra=None):
        with tarfile.open(self.archive, 'w:gz') as archive:
            for name, data in [('package/package.json', self.package_bytes)] + (extra or []):
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))

    def save(self):
        write(self.directory / 'selected-preview.json', self.selected)
        write(self.directory / 'RELEASE-VERIFICATION.json', self.proof)

    def test_matching_archive_passes(self):
        self.assertEqual(verify_archive(self.directory, PACKAGE)[1], self.archive)

    def test_npm_dry_run_parses_the_archive_as_a_local_file(self):
        npm = shutil.which('npm.cmd') or shutil.which('npm')
        self.assertIsNotNone(npm)
        result = subprocess.run([npm, 'publish', str(self.archive.resolve()), '--dry-run', '--json',
                                 '--ignore-scripts', '--offline', '--access', 'public', '--tag', 'next',
                                 '--registry=https://registry.npmjs.org'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        metadata = json.loads(result.stdout)
        # npm 11.19+ wraps the report by package name; older npm emits it directly.
        if set(metadata) == {PACKAGE['name']}:
            metadata = metadata[PACKAGE['name']]
        self.assertEqual(metadata['name'], PACKAGE['name'])
        self.assertEqual(metadata['version'], PACKAGE['version'])

    def test_wrong_source_or_acceptance_proof_is_rejected(self):
        for key, value in [('head', 'c' * 40), ('version', '0.2.0-rc.2'), ('passed', False),
                           ('tests_per_runtime', 61), ('installed_runtimes', [20]), ('readme_cases', 0)]:
            original = self.proof[key]
            self.proof[key] = value
            self.save()
            with self.subTest(key=key), self.assertRaises(ValueError):
                verify_archive(self.directory, PACKAGE)
            self.proof[key] = original

    def test_archive_byte_tampering_is_rejected(self):
        with self.archive.open('ab') as stream:
            stream.write(b'changed')
        with self.assertRaises(ValueError):
            verify_archive(self.directory, PACKAGE)

    def test_archive_metadata_mismatch_is_rejected(self):
        with self.assertRaises(ValueError):
            verify_archive(self.directory, dict(PACKAGE, description='changed'))

    def test_extra_archive_is_rejected(self):
        (self.directory / 'other.tgz').write_bytes(self.archive.read_bytes())
        with self.assertRaises(ValueError):
            verify_archive(self.directory, PACKAGE)

    def test_unsafe_and_duplicate_members_are_rejected_even_with_matching_hash(self):
        for extra in ([('package/../../escape', b'bad')], [('package/package.json', self.package_bytes)]):
            self.pack(extra)
            self.selected['sha256'] = self.proof['sha256'] = hashlib.sha256(self.archive.read_bytes()).hexdigest()
            self.save()
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                verify_archive(self.directory, PACKAGE)

    @patch('release_preview.subprocess.check_output', return_value=HEAD)
    def test_built_source_files_must_match_every_member(self, _mock):
        source = self.directory / 'source'
        source.mkdir()
        (source / 'package.json').write_bytes(self.package_bytes)
        verify_source(self.directory, source)
        (source / 'package.json').write_text(json.dumps(PACKAGE, indent=2))
        with self.assertRaises(ValueError):
            verify_source(self.directory, source)

    @patch('release_preview.subprocess.check_output', return_value='c' * 40)
    def test_wrong_checkout_is_rejected(self, _mock):
        source = self.directory / 'source'
        source.mkdir()
        (source / 'package.json').write_bytes(self.package_bytes)
        with self.assertRaises(ValueError):
            verify_source(self.directory, source)

    def receipts(self):
        for runtime in ('20', '22', '24'):
            write(self.directory / ('acceptance-node' + runtime + '.json'),
                  dict(self.selected, runtime=runtime, passed=True, stdio_cases=62, readme_cases=17, direct_executable_cases=17,
                       workflow_sha=WORKFLOW))

    def test_all_three_runtime_receipts_bind_exact_archive_and_workflow(self):
        self.receipts()
        verify_acceptance(self.directory, PACKAGE, WORKFLOW)
        with self.assertRaises(ValueError):
            verify_acceptance(self.directory, PACKAGE, 'c' * 40)
        path = self.directory / 'acceptance-node22.json'
        receipt = json.loads(path.read_text())
        receipt['sha256'] = '0' * 64
        write(path, receipt)
        with self.assertRaises(ValueError):
            verify_acceptance(self.directory, PACKAGE, WORKFLOW)

    def test_missing_runtime_acceptance_is_rejected(self):
        self.receipts()
        (self.directory / 'acceptance-node24.json').unlink()
        with self.assertRaises(FileNotFoundError):
            verify_acceptance(self.directory, PACKAGE, WORKFLOW)


class PublicationTests(unittest.TestCase):
    def test_absolute_archive_path_cannot_be_npm_github_shorthand(self):
        command = publish_command(Path('release-dist') / 'package.tgz')
        self.assertTrue(Path(command[2]).is_absolute())
        self.assertEqual(command[command.index('--tag') + 1], 'next')
        self.assertIn('--ignore-scripts', command)
        self.assertIn('--provenance', command)

    def test_absent_registry_version_needs_publication(self):
        self.assertFalse(check_existing(None, 'hash', PACKAGE['version']))

    def test_wrong_registry_metadata_or_location_is_rejected(self):
        for metadata in ({'name': 'other'}, dict(PACKAGE, dist={'tarball': 'https://example.com/archive'})):
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                check_existing(metadata, 'hash', PACKAGE['version'])

    @patch('publish_npm.urlopen')
    def test_identical_version_can_resume_but_different_bytes_cannot(self, opened):
        opened.return_value.__enter__.return_value.read.return_value = b'public archive'
        metadata = dict(PACKAGE, dist={'tarball': 'https://registry.npmjs.org/@originchain/mcp-server/-/archive.tgz'})
        digest = hashlib.sha256(b'public archive').hexdigest()
        self.assertTrue(check_existing(metadata, digest, PACKAGE['version']))
        with self.assertRaises(ValueError):
            check_existing(metadata, '0' * 64, PACKAGE['version'])


if __name__ == '__main__':
    unittest.main()
