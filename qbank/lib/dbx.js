'use strict';
// 資料庫轉接層：同一套程式同時跑在
//   (a) 本機 Node（node:sqlite，同步 API）與
//   (b) Cloudflare Workers（D1，非同步 API）。
// 介面：get(sql, ...args) / all(sql, ...args) / run(sql, ...args) → {changes, lastInsertRowid} / exec(sql) / tx(fn)
// 所有方法皆回傳 Promise。

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  new_versions INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  report_json TEXT
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  identity_key TEXT NOT NULL UNIQUE,
  source_bank TEXT NOT NULL,
  set_name TEXT NOT NULL,
  item_no TEXT NOT NULL,
  week TEXT,
  source_grade TEXT,
  topic TEXT,
  course_ref TEXT,
  current_version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  source_file TEXT,
  source_row INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS question_versions (
  question_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  source_file TEXT,
  source_row INTEGER,
  batch_id INTEGER,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (question_id, version)
);
CREATE TABLE IF NOT EXISTS question_flags (
  question_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  flag TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (question_id, version, flag)
);
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL,
  question_version INTEGER NOT NULL,
  analysis_no INTEGER NOT NULL,
  source TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  validation_json TEXT,
  review_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  UNIQUE (question_id, analysis_no)
);
CREATE INDEX IF NOT EXISTS idx_analyses_q ON analyses(question_id, review_status);
CREATE TABLE IF NOT EXISTS review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  reviewer TEXT,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vocab_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  term TEXT NOT NULL,
  context TEXT,
  status TEXT NOT NULL DEFAULT 'suggested',
  created_at TEXT NOT NULL,
  UNIQUE (kind, term)
);
CREATE TABLE IF NOT EXISTS course_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL,
  project TEXT NOT NULL,
  lesson TEXT NOT NULL,
  position INTEGER,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (question_id, project, lesson)
);
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL,
  question_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  variant_no INTEGER NOT NULL,
  text TEXT NOT NULL,
  answer TEXT,
  solution_json TEXT,
  verify_status TEXT NOT NULL,
  verify_json TEXT,
  options_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (question_id, kind, variant_no)
);
CREATE TABLE IF NOT EXISTS ai_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  question_ids_json TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  result_json TEXT
);
`;

const SCHEMA_STATEMENTS = SCHEMA.split(';').map(s => s.trim()).filter(Boolean);

function cleanArgs(args) { return args.map(a => (a === undefined ? null : a)); }

// (a) node:sqlite
class SqliteAdapter {
  constructor(database) { this.db = database; this.kind = 'sqlite'; }
  async get(sql, ...args) { return this.db.prepare(sql).get(...cleanArgs(args)) ?? null; }
  async all(sql, ...args) { return this.db.prepare(sql).all(...cleanArgs(args)); }
  async run(sql, ...args) { const r = this.db.prepare(sql).run(...cleanArgs(args)); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; }
  async exec(sql) { this.db.exec(sql); }
  async tx(fn) {
    this.db.exec('BEGIN');
    try { const r = await fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async ensureSchema() { for (const s of SCHEMA_STATEMENTS) this.db.exec(s); }
}

// (b) Cloudflare D1
class D1Adapter {
  constructor(d1) { this.d1 = d1; this.kind = 'd1'; this.ready = null; }
  async get(sql, ...args) { return (await this.d1.prepare(sql).bind(...cleanArgs(args)).first()) ?? null; }
  async all(sql, ...args) { return (await this.d1.prepare(sql).bind(...cleanArgs(args)).all()).results; }
  async run(sql, ...args) { const r = await this.d1.prepare(sql).bind(...cleanArgs(args)).run(); return { changes: Number(r.meta && r.meta.changes || 0), lastInsertRowid: Number(r.meta && r.meta.last_row_id || 0) }; }
  async exec(sql) { const stmts = sql.split(';').map(s => s.trim()).filter(Boolean); if (stmts.length) await this.d1.batch(stmts.map(s => this.d1.prepare(s))); }
  // D1 沒有互動式交易：此處只是依序執行。匯入等流程每一列各自完整，失敗時可能留下已完成的列，重新匯入會視為「不變」而不重複。
  async tx(fn) { return fn(); }
  async ensureSchema() {
    if (!this.ready) this.ready = this.d1.batch(SCHEMA_STATEMENTS.map(s => this.d1.prepare(s)));
    await this.ready;
  }
}

module.exports = { SqliteAdapter, D1Adapter, SCHEMA, SCHEMA_STATEMENTS };
