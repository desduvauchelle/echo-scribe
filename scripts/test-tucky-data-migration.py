import importlib.util
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('migration', Path(__file__).with_name('migrate-tucky-data.py'))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def test_preserves_database_models_recordings_and_legacy_absolute_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            support = home / 'Library/Application Support/EchoScribe'
            support.mkdir(parents=True)
            recording = support / 'recordings/saved.wav'
            recording.parent.mkdir()
            recording.write_bytes(b'audio fixture')
            model = support / 'models/fixture.bin'
            model.parent.mkdir()
            model.write_bytes(b'model fixture')
            with sqlite3.connect(support / 'echo.db') as conn:
                conn.execute('PRAGMA journal_mode=WAL')
                conn.execute('CREATE TABLE recordings (path TEXT)')
                conn.execute('INSERT INTO recordings VALUES (?)', (str(recording),))
            conn.close()
            for parent in ('Library/Logs', ''):
                folder = home / parent / 'EchoScribe'
                folder.mkdir(parents=True)
                (folder / 'keep.txt').write_text('preserved')
            migration.migrate(home, check_open=False)
            canonical = support.with_name('Tucky')
            self.assertTrue(support.is_symlink())
            self.assertEqual(model.read_bytes(), b'model fixture')
            with sqlite3.connect(canonical / 'tucky.db') as conn:
                saved = conn.execute('SELECT path FROM recordings').fetchone()[0]
                self.assertEqual(Path(saved).read_bytes(), b'audio fixture')
                self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            conn.close()
            with sqlite3.connect(canonical / 'rebrand-backup/echo.db') as conn:
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM recordings').fetchone()[0], 1)
            conn.close()
            self.assertFalse((canonical / 'echo.db').exists())
            migration.migrate(home, check_open=False)
            self.assertEqual((home / 'Tucky/keep.txt').read_text(), 'preserved')
            self.assertEqual((home / 'Library/Logs/Tucky/keep.txt').read_text(), 'preserved')

    def test_conflicting_directories_leave_all_data_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            old = home / 'Library/Application Support/EchoScribe'
            old.mkdir(parents=True)
            (old / 'sentinel').write_text('keep')
            (home / 'EchoScribe').mkdir()
            (home / 'Tucky').mkdir()
            with self.assertRaisesRegex(RuntimeError, 'refusing to merge'):
                migration.migrate(home, check_open=False)
            self.assertFalse(old.is_symlink())
            self.assertEqual((old / 'sentinel').read_text(), 'keep')

    def test_two_databases_are_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            old = home / 'Library/Application Support/EchoScribe'
            old.mkdir(parents=True)
            for name in ('echo.db', 'tucky.db'):
                (old / name).write_bytes(b'keep')
            with self.assertRaisesRegex(RuntimeError, 'refusing to overwrite'):
                migration.migrate(home, check_open=False)
            self.assertEqual((old / 'echo.db').read_bytes(), b'keep')

    def test_recovers_committed_wal_after_interrupted_shutdown(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            old = home / 'Library/Application Support/EchoScribe'
            old.mkdir(parents=True)
            db = old / 'echo.db'
            subprocess.run([sys.executable, '-c',
                "import sqlite3,sys,os; c=sqlite3.connect(sys.argv[1]); "
                "c.execute('PRAGMA journal_mode=WAL'); "
                "c.execute('CREATE TABLE keep (value TEXT)'); "
                "c.execute(\"INSERT INTO keep VALUES ('committed')\"); "
                "c.commit(); os._exit(0)", str(db)], check=True)
            self.assertGreater(Path(str(db) + '-wal').stat().st_size, 0)
            migration.migrate(home)
            for path in (old / 'tucky.db', old / 'rebrand-backup/echo.db'):
                conn = sqlite3.connect(path)
                try:
                    self.assertEqual(conn.execute('SELECT value FROM keep').fetchone()[0], 'committed')
                finally:
                    conn.close()

    def test_open_database_is_not_renamed(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            old = home / 'Library/Application Support/EchoScribe'
            old.mkdir(parents=True)
            conn = sqlite3.connect(old / 'echo.db')
            try:
                conn.execute('CREATE TABLE keep (value TEXT)')
                with self.assertRaisesRegex(RuntimeError, 'still open'):
                    migration.migrate(home)
                self.assertFalse(old.is_symlink())
                self.assertFalse((old / 'tucky.db').exists())
            finally:
                conn.close()

    def test_empty_home_stays_empty(self):
        with tempfile.TemporaryDirectory() as temp:
            migration.migrate(Path(temp), check_open=False)
            self.assertEqual(list(Path(temp).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
