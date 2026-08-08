import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const DB_FILE = process.env.DB_FILE || './data/helpdesk.sqlite';

let db = null;

async function initDb() {
  const SQL = await initSqlJs();
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(DB_FILE)) {
    const buf = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON;');
  db.run('PRAGMA journal_mode = WAL;');

  // Schema
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','agent')),
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      session_token_hash TEXT,
      requirement TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );
  `);
  // Existing prototype databases predate authenticated customer sessions.
  // Keep their records, but require those customers to start a fresh verified
  // session before they can access a conversation again.
  const customerColumns = db.exec('PRAGMA table_info(customers)')[0]?.values.map(row => row[1]) || [];
  if (!customerColumns.includes('session_token_hash')) {
    db.run('ALTER TABLE customers ADD COLUMN session_token_hash TEXT;');
  }
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_session_token ON customers(session_token_hash);');
  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'AI_ACTIVE',
      mode TEXT NOT NULL DEFAULT 'ai',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      assigned_agent_id TEXT,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(assigned_agent_id) REFERENCES users(id)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_type TEXT NOT NULL CHECK(sender_type IN ('CUSTOMER','AI','AGENT','SYSTEM')),
      sender_id TEXT,
      message TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ringing','in_queue','active','ended','rejected','missed','cancelled')),
      queue_position INTEGER DEFAULT 0,
      started_at INTEGER NOT NULL,
      answered_at INTEGER,
      ended_at INTEGER,
      duration INTEGER DEFAULT 0,
      handled_by TEXT,
      end_reason TEXT,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(conversation_id) REFERENCES conversations(id),
      FOREIGN KEY(handled_by) REFERENCES users(id)
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, timestamp);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_customers_last ON customers(last_active_at);`);

  // Bootstrap the first Owner only from explicitly configured credentials.
  // There are no default passwords, and credentials are never written to logs.
  const userCount = db.exec('SELECT COUNT(*) AS c FROM users')[0]?.values[0]?.[0] || 0;
  if (userCount === 0) {
    const { nanoid } = await import('nanoid');
    const name = (process.env.OWNER_NAME || '').trim();
    const email = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
    const password = process.env.OWNER_PASSWORD || '';
    if (!name || !email || !email.includes('@')) {
      throw new Error('OWNER_NAME and a valid OWNER_EMAIL are required to bootstrap the first Owner account.');
    }
    if (password.length < 12 || password.length > 128) {
      throw new Error('OWNER_PASSWORD must be explicitly configured with 12 to 128 characters for first startup.');
    }
    const hash = bcrypt.hashSync(password, 12);
    const id = 'u_' + nanoid(12);
    const createdAt = Date.now();
    const stmt = db.prepare('INSERT INTO users (id,name,email,password_hash,role,status,created_at) VALUES (?,?,?,?,?,?,?)');
    stmt.run([id, name, email, hash, 'owner', 'active', createdAt]);
    stmt.free();
    console.log(`[db] Bootstrapped Owner account for ${email}.`);
  }

  persist();
  return db;
}

function persist() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buffer);
}

// Helper: run a statement, persist, return info
function run(sql, params = []) {
  // sql.js is strict about undefined — convert to null
  const cleaned = params.map(p => (p === undefined ? null : p));
  const stmt = db.prepare(sql);
  try {
    stmt.run(cleaned);
  } catch (e) {
    console.error('[db] SQL error:', e.message, '\n  SQL:', sql, `\n  parameter count: ${cleaned.length}`);
    throw e;
  } finally {
    stmt.free();
    persist();
  }
}

function get(sql, params = []) {
  const cleaned = params.map(p => (p === undefined ? null : p));
  const stmt = db.prepare(sql);
  try {
    stmt.bind(cleaned);
    if (!stmt.step()) return null;
    return stmt.getAsObject();
  } catch (e) {
    console.error('[db] GET error:', e.message, '\n  SQL:', sql, `\n  parameter count: ${cleaned.length}`);
    throw e;
  } finally {
    stmt.free();
  }
}

function all(sql, params = []) {
  const cleaned = params.map(p => (p === undefined ? null : p));
  const stmt = db.prepare(sql);
  try {
    const rows = [];
    stmt.bind(cleaned);
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } catch (e) {
    console.error('[db] ALL error:', e.message, '\n  SQL:', sql, `\n  parameter count: ${cleaned.length}`);
    throw e;
  } finally {
    stmt.free();
  }
}

export { initDb, db, run, get, all, persist };
