#!/usr/bin/env python3
"""Offline local rebrand. Stop all Tucky/Echo Scribe processes before running."""
import argparse
import os
from pathlib import Path
import sqlite3
import subprocess


def migrate(home: Path, check_open=True):
    pairs = [(home / parent / 'EchoScribe', home / parent / 'Tucky')
             for parent in ('Library/Application Support', 'Library/Logs', '')]
    # Validate every location before moving anything. Never merge two datasets.
    for old, new in pairs:
        if old.is_symlink():
            if old.resolve() != new.resolve() or not new.is_dir():
                raise RuntimeError(f'Unexpected legacy alias: {old}')
        elif old.exists() and new.exists():
            raise RuntimeError(f'Both {old} and {new} exist; refusing to merge')
        elif new.is_symlink():
            raise RuntimeError(f'Unexpected destination alias: {new}')
    support = pairs[0][0] if pairs[0][0].exists() else pairs[0][1]
    old_db, new_db = support / 'echo.db', support / 'tucky.db'
    if old_db.exists() and new_db.exists():
        raise RuntimeError('Both echo.db and tucky.db exist; refusing to overwrite')
    if old_db.exists():
        if check_open:
            result = subprocess.run(['lsof', '-t', str(old_db)], capture_output=True, text=True)
            if result.returncode not in (0, 1):
                raise RuntimeError('Could not check whether the database is open')
            if result.stdout.strip():
                raise RuntimeError('Database is still open; quit Tucky and its MCP processes first')
        backup = support / 'rebrand-backup' / 'echo.db'
        backup.parent.mkdir(exist_ok=True)
        if backup.exists():
            raise RuntimeError(f'Backup already exists: {backup}; review before retrying')
        with sqlite3.connect(old_db, timeout=0) as conn:
            if conn.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('Database integrity check failed')
            if conn.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0] != 0:
                raise RuntimeError('Database is busy; refusing to rename')
            with sqlite3.connect(backup) as dest:
                conn.backup(dest)
        # Connections must close before renaming a WAL database.
        conn.close()
        dest.close()
        for suffix in ('-wal', '-shm'):
            sidecar = Path(str(old_db) + suffix)
            if sidecar.exists():
                raise RuntimeError(f'Database sidecar is still present: {sidecar}')
        old_db.rename(new_db)
    for old, new in pairs:
        if old.is_symlink() or not old.exists():
            continue
        old.rename(new)
        try:
            old.symlink_to('Tucky', target_is_directory=True)
        except OSError:
            new.rename(old)
            raise
        print(f'{old} -> {new} (legacy alias retained)')
    print('Tucky data migration verified; database backup retained in rebrand-backup/echo.db.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home())
    args = parser.parse_args()
    migrate(args.home)
