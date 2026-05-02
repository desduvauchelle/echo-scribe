import { Database } from 'bun:sqlite';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';

const dbDir = join(homedir(), 'Library', 'Application Support', 'EchoScribe');
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, 'echo.db');

export const db = new Database(dbPath, { create: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    visibility TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS items_fts
    USING fts5(content, content='items', content_rowid='rowid');

  CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO items_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
`);

export interface ItemRow {
  id: string;
  content: string;
  source: string;
  visibility: string;
  captured_at: string;
  created_at: string;
  deleted_at: string | null;
}

export function insertItem(row: Omit<ItemRow, 'deleted_at'>): void {
  db.query(`
    INSERT INTO items (id, content, source, visibility, captured_at, created_at)
    VALUES ($id, $content, $source, $visibility, $captured_at, $created_at)
  `).run({
    $id: row.id,
    $content: row.content,
    $source: row.source,
    $visibility: row.visibility,
    $captured_at: row.captured_at,
    $created_at: row.created_at,
  });
}
