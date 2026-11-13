import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'resident', password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS team_members(team_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(team_id,user_id));
CREATE TABLE IF NOT EXISTS patients(
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, display_name TEXT NOT NULL, room TEXT,
  age_band TEXT, sex TEXT, sort_order INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  last_reviewed_revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS census_intakes(
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, created_by TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed',
  source_text TEXT NOT NULL, items TEXT NOT NULL,
  created_at TEXT NOT NULL, confirmed_at TEXT);
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT,
  event_time TEXT, uploaded_at TEXT NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS facts(
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, label TEXT NOT NULL, value TEXT NOT NULL, unit TEXT,
  event_time TEXT, source_id TEXT NOT NULL, source_passage TEXT NOT NULL,
  assertion TEXT NOT NULL DEFAULT 'present', reviewer_status TEXT NOT NULL DEFAULT 'pending',
  revision INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_facts_patient ON facts(patient_id);
CREATE TABLE IF NOT EXISTS plans(
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, plan_date TEXT NOT NULL, text TEXT NOT NULL,
  author_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts(
  id TEXT PRIMARY KEY, patient_id TEXT, team_id TEXT, operation TEXT NOT NULL, context_revision INTEGER,
  status TEXT NOT NULL, review_state TEXT NOT NULL DEFAULT 'draft', outdated INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL, requires_review INTEGER NOT NULL DEFAULT 1, provider TEXT, model TEXT,
  prompt_version TEXT, template_version TEXT, usage TEXT, generation_ms INTEGER,
  created_by TEXT, reviewed_by TEXT, reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_artifacts_patient ON artifacts(patient_id);
CREATE TABLE IF NOT EXISTS artifact_versions(
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
  edited_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS problems(
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL,
  fact_ids TEXT NOT NULL DEFAULT '[]', uncertainty TEXT, code_suggestion TEXT,
  decided_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, text TEXT NOT NULL, owner TEXT, due TEXT,
  plan_quote TEXT, state TEXT NOT NULL DEFAULT 'proposed', accepted_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evidence_cache(
  cache_key TEXT PRIMARY KEY, query TEXT NOT NULL, params TEXT, results TEXT NOT NULL, searched_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reading_list(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, pmid TEXT NOT NULL, title TEXT, url TEXT, created_at TEXT NOT NULL,
  UNIQUE(user_id, pmid));
CREATE TABLE IF NOT EXISTS mcqs(
  id TEXT PRIMARY KEY, topic TEXT NOT NULL, topic_key TEXT, difficulty TEXT, stage TEXT, content TEXT NOT NULL,
  validation TEXT, status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'ai_generated',
  created_by TEXT NOT NULL, approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS curated_reads(
  id TEXT PRIMARY KEY, topic TEXT NOT NULL, topic_key TEXT NOT NULL, title TEXT NOT NULL,
  citation TEXT, url TEXT, pmid TEXT, why_it_matters TEXT, added_by TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0, approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_curated_reads_topic ON curated_reads(topic_key, approved);
CREATE TABLE IF NOT EXISTS guideline_updates(
  id TEXT PRIMARY KEY, topic TEXT NOT NULL, topic_key TEXT NOT NULL, organization TEXT NOT NULL,
  title TEXT NOT NULL, published_date TEXT, url TEXT, summary_by_admin TEXT,
  status TEXT NOT NULL DEFAULT 'draft', added_by TEXT NOT NULL, approved_by TEXT, approved_at TEXT,
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_guideline_updates_topic ON guideline_updates(topic_key, status);
CREATE TABLE IF NOT EXISTS attempts(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mcq_id TEXT NOT NULL, topic TEXT NOT NULL, correct INTEGER NOT NULL,
  seconds INTEGER, confidence INTEGER, review_stage INTEGER, next_review_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issue_reports(
  id TEXT PRIMARY KEY, mcq_id TEXT NOT NULL, user_id TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS templates(
  id TEXT PRIMARY KEY, key TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL,
  sections TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE(key,version));
CREATE TABLE IF NOT EXISTS ai_usage(
  user_id TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS idempotency(
  key TEXT NOT NULL, user_id TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(key, user_id));
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL,
  patient_id TEXT, artifact_id TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS icd10cm(
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  billable INTEGER NOT NULL DEFAULT 1,
  fy TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_icd10cm_desc ON icd10cm(description);
CREATE TABLE IF NOT EXISTS check_rules(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  match_json TEXT NOT NULL,
  prompts_json TEXT NOT NULL,
  compare_json TEXT,
  created_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  ai_drafted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_check_rules_status ON check_rules(status);
CREATE TABLE IF NOT EXISTS reminder_acks(
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(patient_id, rule_id, day, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reminder_acks_patient_day ON reminder_acks(patient_id, day);
CREATE TABLE IF NOT EXISTS channels(
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL, patient_id TEXT, created_by TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_channels_team ON channels(team_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_patient ON channels(patient_id) WHERE patient_id IS NOT NULL AND type='patient';
CREATE TABLE IF NOT EXISTS channel_members(
  channel_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at TEXT NOT NULL,
  PRIMARY KEY(channel_id, user_id));
CREATE TABLE IF NOT EXISTS messages(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  parent_id TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages(channel_id, seq);
CREATE TABLE IF NOT EXISTS message_reads(
  user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, channel_id));
CREATE TABLE IF NOT EXISTS mentions(
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(user_id, created_at);
CREATE TABLE IF NOT EXISTS chat_devices(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT NOT NULL,
  token_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(user_id, token_hash));
CREATE TABLE IF NOT EXISTS chat_hold_history(
  id TEXT PRIMARY KEY, at TEXT NOT NULL, actor_id TEXT,
  hold INTEGER NOT NULL, reason TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chat_hold_history_at ON chat_hold_history(at);
CREATE TABLE IF NOT EXISTS chat_export_requests(
  id TEXT PRIMARY KEY, at TEXT NOT NULL, actor_id TEXT NOT NULL,
  reason TEXT NOT NULL, team_id TEXT,
  channel_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  format TEXT NOT NULL DEFAULT 'json');
CREATE INDEX IF NOT EXISTS idx_chat_export_requests_at ON chat_export_requests(at);
`;

let db;

function migrate(database) {
  // Additive columns for DBs created before M2b / M4.
  const cols = database.prepare('PRAGMA table_info(patients)').all().map((c) => c.name);
  if (!cols.includes('sort_order')) database.exec('ALTER TABLE patients ADD COLUMN sort_order INTEGER');
  const userCols = database.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('last_login_at')) database.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
  const mcqCols = database.prepare('PRAGMA table_info(mcqs)').all().map((c) => c.name);
  if (!mcqCols.includes('topic_key')) database.exec('ALTER TABLE mcqs ADD COLUMN topic_key TEXT');
  if (!mcqCols.includes('source')) database.exec("ALTER TABLE mcqs ADD COLUMN source TEXT NOT NULL DEFAULT 'ai_generated'");
  if (!mcqCols.includes('approved_by')) database.exec('ALTER TABLE mcqs ADD COLUMN approved_by TEXT');
  if (!mcqCols.includes('approved_at')) database.exec('ALTER TABLE mcqs ADD COLUMN approved_at TEXT');
  // Backfill topic_key for older rows, then create index (must run after ALTER on pre-M4 DBs).
  try {
    database.exec(`UPDATE mcqs SET topic_key = lower(trim(topic)) WHERE topic_key IS NULL OR topic_key=''`);
  } catch { /* ignore */ }
  try {
    database.exec('CREATE INDEX IF NOT EXISTS idx_mcqs_topic_status ON mcqs(topic_key, status)');
  } catch { /* ignore */ }
  // FTS5 for ICD search when the SQLite build includes it; otherwise LIKE fallback.
  try {
    database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS icd10cm_fts USING fts5(code, description, content='icd10cm', content_rowid='rowid')`);
    database.exec(`CREATE TABLE IF NOT EXISTS _icd_fts_meta(ok INTEGER)`);
  } catch {
    /* FTS5 unavailable — searchIcd uses LIKE */
  }
}

/** Production must use the Fly volume at /data — otherwise every machine stop wipes SQLite. */
function assertPersistentVolume(file) {
  if (process.env.NODE_ENV !== 'production' || file === ':memory:') return;
  if (!file.startsWith('/data/')) {
    throw new Error(`Production DB_PATH must be under /data (got ${file})`);
  }
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8');
    const hasData = mounts.split('\n').some((line) => {
      const parts = line.split(/\s+/);
      return parts[1] === '/data';
    });
    if (!hasData) {
      throw new Error('FATAL: /data is not a mounted Fly volume. Attach volume roundsal_data → /data, then redeploy.');
    }
  } catch (e) {
    if (e && String(e.message || e).includes('FATAL')) throw e;
    // /proc/mounts missing (non-Linux): skip mount check
  }
}

export function openDb(file = config.dbPath) {
  assertPersistentVolume(file);
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function hasIcdFts() {
  try {
    return !!get("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='icd10cm_fts'");
  } catch { return false; }
}

const getDb = () => db ?? openDb();
const norm = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? Number(x) : x));

export const all = (sql, ...p) => getDb().prepare(sql).all(...norm(p));
export const get = (sql, ...p) => getDb().prepare(sql).get(...norm(p));
export const run = (sql, ...p) => getDb().prepare(sql).run(...norm(p));

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; }
}

export function getSetting(key, fallback) {
  const row = get('SELECT value FROM settings WHERE key=?', key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}

/** Audit rows hold IDs and codes only, never clinical text. */
export function audit(actorId, action, { patient_id = null, artifact_id = null, detail = null } = {}) {
  run('INSERT INTO audit_log(at,actor_id,action,patient_id,artifact_id,detail) VALUES(?,?,?,?,?,?)',
    new Date().toISOString(), actorId, action, patient_id, artifact_id, detail ? JSON.stringify(detail) : null);
}
