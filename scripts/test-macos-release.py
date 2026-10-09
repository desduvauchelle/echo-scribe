#!/usr/bin/env python3
"""Exercise release gates with fixture bundles, without credentials or Apple access."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['RELEASE_TEST_LOG'], 'a') as log:
    log.write(json.dumps([name, *args]) + '\n')
if name == 'security':
    print('1) 000000 "Developer ID Application: Fixture (TESTTEAM)"')
elif name == 'bun':
    app = pathlib.Path('src-tauri/target/release/bundle/macos/Tucky.app/Contents/MacOS')
    app.mkdir(parents=True)
    for binary in ['Tucky', 'echo-scribe-syscap', 'echo-scribe-screenrec', 'tucky-wakeword', 'tucky-whisper']:
        path = app / binary
        path.write_text('fixture')
        path.chmod(0o755)
elif name == 'xcrun':
    if args[:2] == ['notarytool', 'history']:
        if os.environ.get('RELEASE_TEST_FAILURE') == 'auth':
            sys.exit(1)
        print('{"history":[]}')
    elif args[:2] == ['notarytool', 'submit']:
        stage = 'dmg' if args[2].endswith('.dmg') else 'app'
        status = 'Invalid' if os.environ.get('RELEASE_TEST_FAILURE') == stage else 'Accepted'
        print(json.dumps({'status': status, 'id': 'fixture-' + stage}))
elif name == 'ditto':
    if '-c' in args:
        pathlib.Path(args[-1]).touch()
    else:
        shutil.copytree(args[0], args[1], symlinks=True)
elif name == 'hdiutil':
    pathlib.Path(args[-1]).touch()
elif name == 'spctl' and os.environ.get('RELEASE_TEST_FAILURE') == 'gatekeeper':
    sys.exit(1)
'''


class ReleaseGateTests(unittest.TestCase):
    def run_release(self, failure=''):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'src-tauri').mkdir()
            (root / 'package.json').write_text('{"version":"1.2.3"}')
            (root / 'src-tauri/tauri.conf.json').write_text('{}')
            for script in ['release-macos.sh', 'sign-macos-bundle.sh', 'package-release.sh']:
                shutil.copyfile(ROOT / 'scripts' / script, root / 'scripts' / script)
            binaries = root / 'bin'
            binaries.mkdir()
            for command in ['security', 'bun', 'xcrun', 'codesign', 'ditto', 'hdiutil', 'spctl']:
                path = binaries / command
                path.write_text(MOCK)
                path.chmod(0o755)
            log = root / 'calls.jsonl'
            env = dict(os.environ, PATH=str(binaries) + ':' + os.environ['PATH'],
                       RELEASE_TEST_LOG=str(log), RELEASE_TEST_FAILURE=failure,
                       APPLE_SIGNING_IDENTITY='Developer ID Application: Fixture (TESTTEAM)')
            result = subprocess.run(['bash', 'scripts/release-macos.sh'], cwd=root,
                                    env=env, capture_output=True, text=True)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            outputs = [p.name for p in (root / 'output/mac-release').glob('*')]
            return result, calls, outputs

    def test_auth_failure_stops_before_build(self):
        result, calls, outputs = self.run_release('auth')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[0] == 'bun' for call in calls))
        self.assertEqual(outputs, [])

    def test_rejected_app_and_gatekeeper_stop_before_packaging(self):
        for failure in ['app', 'gatekeeper']:
            with self.subTest(failure=failure):
                result, calls, outputs = self.run_release(failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(call[0] == 'hdiutil' for call in calls))
                self.assertEqual(outputs, [])

    def test_rejected_dmg_is_not_exposed_as_verified_installer(self):
        result, calls, outputs = self.run_release('dmg')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(name.endswith('.dmg') for name in outputs))
        self.assertIn('Notarization failed: Invalid', result.stderr)

    def test_success_requires_both_approvals_staples_and_assessments(self):
        result, calls, outputs = self.run_release()
        self.assertEqual(result.returncode, 0, result.stderr)
        submissions = [i for i, c in enumerate(calls) if c[:3] == ['xcrun', 'notarytool', 'submit']]
        staples = [i for i, c in enumerate(calls) if c[:3] == ['xcrun', 'stapler', 'staple']]
        validations = [i for i, c in enumerate(calls) if c[:3] == ['xcrun', 'stapler', 'validate']]
        assessments = [i for i, c in enumerate(calls) if c[0] == 'spctl']
        self.assertEqual([len(submissions), len(staples), len(validations), len(assessments)], [2, 2, 2, 2])
        for n in range(2):
            self.assertLess(submissions[n], staples[n])
            self.assertLess(staples[n], validations[n])
            self.assertLess(validations[n], assessments[n])
        self.assertLess(assessments[0], submissions[1])
        self.assertIn('Tucky-aarch64.tar.gz', outputs)
        self.assertIn('EchoScribe-aarch64.tar.gz', outputs)
        self.assertTrue(any(name.startswith('Tucky-1.2.3-') and name.endswith('.dmg') for name in outputs))


if __name__ == '__main__':
    unittest.main()
