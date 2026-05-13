import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import("better-sqlite3").Database | null} */
let db = null;

export function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}

/**
 * @param {string} rootDir
 */
export function initDatabase(rootDir) {
  const dir = path.join(rootDir, "data");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "app.db");
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages(group_id, ts);
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

    CREATE TABLE IF NOT EXISTS oauth_identities (
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (provider, subject)
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_identities(user_id);
  `);

  const msgCols = database.prepare("PRAGMA table_info(messages)").all();
  if (!msgCols.some((c) => c.name === "attachments_json")) {
    database.exec(
      "ALTER TABLE messages ADD COLUMN attachments_json TEXT DEFAULT '[]'"
    );
  }

  const lobbyId = "g_lobby";
  const lobby = database.prepare("SELECT id FROM groups WHERE id = ?").get(lobbyId);
  if (!lobby) {
    database
      .prepare(
        "INSERT INTO groups (id, name, created_by, created_at) VALUES (?, ?, NULL, ?)"
      )
      .run(lobbyId, "Lobby", Date.now());
  }

  db = database;
  return database;
}

export function newId(prefix) {
  return (
    prefix +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36)
  );
}
