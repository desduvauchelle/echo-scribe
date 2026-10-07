#!/usr/bin/env python3
"""Check CI credential gates, tag versioning, and release artifact wiring."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import shutil

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = json.loads(subprocess.check_output(
    ['bun', '-e', 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))',
     str(ROOT / '.github/workflows/release.yml')], text=True))


class ReleaseTests(unittest.TestCase):
    def test_setup_records_success_and_apple_failure_without_password(self):
        for apple_status, expected in [(0, 'complete'), (12, 'stopped:validating_with_apple:exit=12')]:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'scripts').mkdir()
                helper = root / 'scripts/configure-apple-notarization.command'
                shutil.copyfile(ROOT / 'scripts/configure-apple-notarization.command', helper)
                shell = '''
gh() { if [[ "$1" == auth ]]; then return 0; fi; cat >/dev/null; }
xcrun() { return "$TEST_APPLE_STATUS"; }
export -f gh xcrun
bash "$1"
'''
                result = subprocess.run(['bash', '-c', shell, 'test', str(helper)],
                    env=dict(os.environ, TUCKY_APPLE_ID='test@example.com', TEST_APPLE_STATUS=str(apple_status)),
                    input='fixture-secret-password\n\n', text=True, capture_output=True)
                status = (root / 'output/apple-signing/notarization-setup.status').read_text().strip()
                self.assertEqual(status, expected)
                self.assertEqual(result.returncode, apple_status)
                self.assertNotIn('fixture-secret-password', status + result.stdout + result.stderr)

    def test_all_workflow_shell_steps_parse(self):
        for job in WORKFLOW['jobs'].values():
            for step in job['steps']:
                if 'run' in step:
                    subprocess.run(['bash', '-n'], input=step['run'], text=True, check=True)

    def test_version_tag_updates_package_bundle_and_crate(self):
        step = next(step for step in WORKFLOW['jobs']['build']['steps']
                    if step.get('name') == 'Bake version from tag')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'src-tauri').mkdir()
            for file in ['package.json', 'src-tauri/tauri.conf.json']:
                (root / file).write_text('{"version":"1.0.0"}')
            (root / 'src-tauri/Cargo.toml').write_text('[package]\nversion = "1.0.0"\n')
            # macOS sed -i "" is used in this real workflow.
            subprocess.run(['bash', '-eu', '-c', step['run']], cwd=root,
                           env=dict(os.environ, RELEASE_TAG='v1.2.3'), check=True)
            for file in ['package.json', 'src-tauri/tauri.conf.json']:
                self.assertEqual(json.loads((root / file).read_text())['version'], '1.2.3')
            self.assertIn('version = "1.2.3"', (root / 'src-tauri/Cargo.toml').read_text())
            result = subprocess.run(['bash', '-eu', '-c', step['run']], cwd=root,
                                    env=dict(os.environ, RELEASE_TAG='bad-tag'), capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads((root / 'package.json').read_text())['version'], '1.2.3')

    def test_missing_credentials_fail_before_import(self):
        names = ['TUCKY_APPLE_CERTIFICATE_P12_BASE64', 'TUCKY_APPLE_CERTIFICATE_PASSWORD', 'TUCKY_APPLE_ID',
                 'TUCKY_APPLE_APP_SPECIFIC_PASSWORD', 'TUCKY_APPLE_TEAM_ID']
        for missing in names:
            env = dict(os.environ, GITHUB_ACTIONS='true')
            env.update({name: 'test-secret-value' for name in names})
            env.pop(missing)
            result = subprocess.run(['bash', str(ROOT / 'scripts/setup-ci-signing.sh')],
                                    env=env, text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Missing GitHub Actions secret: ' + missing, result.stderr)
            self.assertNotIn('test-secret-value', result.stdout + result.stderr)

    def test_publish_requires_verified_build_and_all_artifacts(self):
        build = WORKFLOW['jobs']['build']['steps']
        release = WORKFLOW['jobs']['release']
        self.assertEqual(release['needs'], 'build')
        publish = next(step for step in release['steps'] if step.get('name') == 'Publish GitHub Release')
        self.assertTrue(publish['with']['fail_on_unmatched_files'])
        self.assertIn('Tucky-*.dmg', publish['with']['files'])
        self.assertIn('EchoScribe-*.tar.gz', publish['with']['files'])
        self.assertTrue(any(step.get('run') == 'bun run release:mac' for step in build))
        cleanup = next(step for step in build if step.get('name') == 'Remove temporary signing credentials')
        self.assertEqual(cleanup['if'], 'always()')


if __name__ == '__main__':
    unittest.main()
