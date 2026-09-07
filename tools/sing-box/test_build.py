"""Regression tests for build subprocess output on non-UTF-8 hosts."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fluxy_build', Path(__file__).with_name('build.py'))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BuildOutputTests(unittest.TestCase):
    def test_go_json_is_utf8_even_with_windows_legacy_locale(self):
        text = '{"Doc":"Unicode right quote: ”; 中文"}'
        command = [sys.executable, '-c',
                   f'import sys; sys.stdout.buffer.write(bytes.fromhex("{text.encode("utf-8").hex()}"))']
        with patch('subprocess._text_encoding', return_value='cp1252'):
            self.assertEqual(build.output(command), text)

    def test_subprocess_failure_is_not_swallowed(self):
        with self.assertRaises(subprocess.CalledProcessError):
            build.output([sys.executable, '-c', 'raise SystemExit(7)'])


if __name__ == '__main__':
    unittest.main()
