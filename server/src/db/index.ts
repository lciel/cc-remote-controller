import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';
import { CREATE_TABLES } from './schema.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(config.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function initDb(): void {
  const database = getDb();
  database.exec(CREATE_TABLES);

  // Reset stale states from unclean shutdown
  database.prepare("UPDATE projects SET state = 'IDLE' WHERE state IN ('RUNNING', 'STOPPING')").run();
  database.prepare("UPDATE jobs SET state = 'FAILED', ended_at = datetime('now') WHERE state IN ('QUEUED', 'RUNNING')").run();
  console.log('Database initialized');
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
