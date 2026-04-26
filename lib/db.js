const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "jarvis.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    title TEXT,
    agent_id TEXT,
    provider TEXT NOT NULL,
    model TEXT,
    system_prompt TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    last_event TEXT,
    kind TEXT NOT NULL DEFAULT 'worker',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_worker
    ON messages(worker_id, created_at);
`);

// Column migrations (idempotent) — rodam antes de indexes que dependem das novas colunas
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col);
}
if (!hasColumn("workers", "kind")) {
  db.exec("ALTER TABLE workers ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker'");
}
if (!hasColumn("messages", "metadata")) {
  db.exec("ALTER TABLE messages ADD COLUMN metadata TEXT");
}

db.exec("CREATE INDEX IF NOT EXISTS idx_workers_kind ON workers(kind, updated_at)");

module.exports = db;
