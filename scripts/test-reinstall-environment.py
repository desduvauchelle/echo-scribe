import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class ReinstallEnvironmentTests(unittest.TestCase):
    def test_finds_local_runtime_and_cached_onnx_without_project_shell_setup(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            bun = home / '.bun/bin/bun'
            bun.parent.mkdir(parents=True)
            bun.write_text('#!/bin/bash\nprintf "%s\\n" "${ORT_LIB_PATH:-unset}" > "$TUCKY_TEST_ENV_OUTPUT"\nexit 42\n')
            bun.chmod(0o755)
            library = home / 'Library/Caches/ort.pyke.io/dfbin/aarch64-apple-darwin/fixture/libonnxruntime.a'
            library.parent.mkdir(parents=True)
            library.touch()
            output = home / 'environment.txt'
            env = dict(os.environ, HOME=str(home), PATH='/usr/bin:/bin:/usr/sbin:/sbin', TUCKY_TEST_ENV_OUTPUT=str(output))
            env.pop('ORT_LIB_PATH', None)
            result = subprocess.run(['/bin/bash', str(ROOT / 'reinstall.command')], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 42, result.stderr)
            self.assertEqual(output.read_text().strip(), str(library.parent))


if __name__ == '__main__':
    unittest.main()
