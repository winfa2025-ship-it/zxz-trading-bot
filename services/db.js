const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'zxz.db');

let db;

function getDb() {
  if (db) return db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema();
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      invite_code TEXT,
      kyc_status TEXT DEFAULT 'unverified',
      kyc_name TEXT,
      kyc_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT PRIMARY KEY,
      traffic_gold REAL DEFAULT 0,
      usd REAL DEFAULT 0,
      hkd REAL DEFAULT 0,
      btc REAL DEFAULT 0,
      eth REAL DEFAULT 0,
      usdt REAL DEFAULT 0,
      fio REAL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      type TEXT,
      amount REAL,
      currency TEXT,
      status TEXT DEFAULT 'completed',
      hash TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS fee_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      amount REAL,
      currency TEXT DEFAULT 'FIO',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      to_address TEXT,
      amount REAL,
      currency TEXT DEFAULT 'FIO',
      fee REAL DEFAULT 0.01,
      status TEXT DEFAULT 'pending',
      txid TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS mining_sessions (
      user_id TEXT PRIMARY KEY,
      started_at TEXT,
      paused_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      plan TEXT NOT NULL,
      price REAL NOT NULL,
      status TEXT DEFAULT 'active',
      started_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
}

function ensureWallet(userId) {
  const stmt = getDb().prepare('INSERT OR IGNORE INTO wallets (user_id) VALUES (?)');
  stmt.run(userId);
}

module.exports = { getDb, ensureWallet };
