#!/usr/bin/env python3
"""Exercise the real signer against a fake bundle without using private keys."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class SigningTests(unittest.TestCase):
    def run_signer(self, identity, missing_worker=False):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            app = work / 'Tucky.app'
            executables = app / 'Contents/MacOS'
            executables.mkdir(parents=True)
            for name in ['Tucky', 'echo-scribe-syscap', 'echo-scribe-screenrec',
                         'tucky-wakeword', 'tucky-whisper']:
                path = executables / name
                path.write_text('fixture')
                path.chmod(0o755)
            library = app / 'Contents/Frameworks/runtime.dylib'
            library.parent.mkdir()
            library.write_text('fixture')
            if missing_worker:
                (executables / 'tucky-whisper').unlink()
            log = work / 'signing.jsonl'
            binary = work / 'codesign'
            binary.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['SIGNING_TEST_LOG'], 'a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
''')
            binary.chmod(0o755)
            environment = dict(os.environ, PATH=str(work) + ':' + os.environ['PATH'],
                               SIGNING_TEST_LOG=str(log), APPLE_SIGNING_IDENTITY=identity)
            environment.pop('CODESIGN_IDENTITY', None)
            result = subprocess.run(['bash', str(ROOT / 'scripts/sign-macos-bundle.sh'),
                                     str(app)], env=environment, capture_output=True, text=True)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            alias = (executables / 'echo-scribe').is_symlink()
            return result, calls, alias

    def test_developer_id_signs_inside_out_with_timestamp_and_worker_entitlements(self):
        identity = 'Developer ID Application: Example (TESTTEAM)'
        result, calls, alias = self.run_signer(identity)
        self.assertEqual(result.returncode, 0, result.stderr)
        signing = [call for call in calls if '--sign' in call]
        self.assertTrue(signing[0][-1].endswith('runtime.dylib'))
        self.assertTrue(signing[-1][-1].endswith('Tucky.app'))
        self.assertEqual(len(signing), 6)
        for call in signing:
            self.assertEqual(call[call.index('--sign') + 1], identity)
            self.assertIn('--timestamp', call)
            self.assertIn('runtime', call)
        for call in signing[1:]:
            self.assertIn('--entitlements', call)
        self.assertTrue(alias)
        self.assertEqual(calls[-1][:3], ['--verify', '--deep', '--strict'])

    def test_ad_hoc_signing_does_not_request_apple_timestamp(self):
        result, calls, alias = self.run_signer('-')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(alias)
        self.assertFalse(any('--timestamp' in call for call in calls))

    def test_missing_sidecar_blocks_bundle_signing(self):
        result, calls, alias = self.run_signer('-', missing_worker=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('sidecar not found', result.stderr)
        self.assertFalse(alias)
        self.assertFalse(any('--verify' in call for call in calls))


if __name__ == '__main__':
    unittest.main()
