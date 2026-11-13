import { all, get, getSetting } from './db.js';
import { jsonParse, need } from './util.js';

/** Paginated audit query. Rows are IDs/codes only — never clinical text. */
export function queryAudit({ actor_id, action, patient_id, from, to, limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const where = [];
  const args = [];
  if (actor_id) { where.push('actor_id=?'); args.push(actor_id); }
  if (action) { where.push('action=?'); args.push(action); }
  if (patient_id) { where.push('patient_id=?'); args.push(patient_id); }
  if (from) { where.push('at>=?'); args.push(from); }
  if (to) { where.push('at<=?'); args.push(to); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS n FROM audit_log ${clause}`, ...args)?.n || 0;
  const rows = all(
    `SELECT id, at, actor_id, action, patient_id, artifact_id, detail FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...args, lim, off,
  ).map((x) => ({ ...x, detail: jsonParse(x.detail) }));
  return { rows, total, limit: lim, offset: off };
}

export function auditCsv(query) {
  const { rows } = queryAudit({ ...query, limit: Math.min(Number(query.limit) || 5000, 10000), offset: 0 });
  const esc = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'id,at,actor_id,action,patient_id,artifact_id,detail';
  const lines = rows.map((r) => [r.id, r.at, r.actor_id, r.action, r.patient_id, r.artifact_id, r.detail].map(esc).join(','));
  return [header, ...lines].join('\n') + '\n';
}

export function listUsersAdmin() {
  return all('SELECT id,email,name,role,active,created_at,last_login_at FROM users ORDER BY created_at').map((u) => {
    const last = get('SELECT MAX(at) AS at FROM audit_log WHERE actor_id=?', u.id)?.at || null;
    return {
      ...u,
      active: !!u.active,
      last_activity_at: last,
      teams: all('SELECT team_id FROM team_members WHERE user_id=?', u.id).map((t) => t.team_id),
    };
  });
}

/** Aggregated AI usage (already exposed via /admin/usage). */
export function usageByUserDay({ since } = {}) {
  const day = since || new Date().toISOString().slice(0, 8) + '01';
  return all(
    `SELECT u.id AS user_id, u.email, a.day, a.calls, a.input_tokens, a.output_tokens
     FROM ai_usage a JOIN users u ON u.id=a.user_id WHERE a.day>=? ORDER BY a.day DESC, a.calls DESC`,
    day,
  );
}

/** Activity counts per user by action type from audit (no clinical text). */
export function activityByAction({ since, until, user_id } = {}) {
  const where = [];
  const args = [];
  if (since) { where.push('at>=?'); args.push(since); }
  if (until) { where.push('at<=?'); args.push(until); }
  if (user_id) { where.push('actor_id=?'); args.push(user_id); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return all(
    `SELECT actor_id, action, COUNT(*) AS count FROM audit_log ${clause}
     GROUP BY actor_id, action ORDER BY count DESC`,
    ...args,
  );
}

/**
 * Question analytics per topic (attempts, % correct, reported count, avg time).
 * Individual learner rows only when setting show_individual_learner_analytics is true.
 */
export function questionAnalytics({ includeIndividuals = false } = {}) {
  const byTopic = all(`
    SELECT a.topic,
      COUNT(*) AS attempts,
      ROUND(100.0 * SUM(a.correct) / COUNT(*), 1) AS pct_correct,
      ROUND(AVG(a.seconds), 1) AS avg_seconds,
      (SELECT COUNT(*) FROM issue_reports i JOIN mcqs m ON m.id=i.mcq_id WHERE m.topic=a.topic OR m.topic_key=lower(trim(a.topic))) AS reported_count
    FROM attempts a
    GROUP BY a.topic
    ORDER BY a.topic
  `);
  const out = { by_topic: byTopic, individuals: null };
  if (includeIndividuals) {
    out.individuals = all(`
      SELECT u.id AS user_id, u.email, a.topic,
        COUNT(*) AS attempts,
        ROUND(100.0 * SUM(a.correct) / COUNT(*), 1) AS pct_correct,
        ROUND(AVG(a.seconds), 1) AS avg_seconds
      FROM attempts a JOIN users u ON u.id=a.user_id
      GROUP BY u.id, a.topic
      ORDER BY u.email, a.topic
    `);
  }
  return out;
}

export function individualLearnerAllowed() {
  return !!getSetting('show_individual_learner_analytics', false);
}

/** Who edited/approved/retired and when — derived from audit (IDs only). */
const HISTORY_ACTIONS = {
  'check-rule': ['check_rule_create', 'check_rule_update', 'check_rule_approve', 'check_rule_retire'],
  mcq: ['admin_mcq_status', 'mcq_report'],
  'curated-read': ['curated_read_create', 'curated_read_approve'],
  'guideline-update': ['guideline_update_create', 'guideline_update_approve'],
  template: ['admin_template_publish'],
};

export function contentHistory({ type, id }) {
  const actions = HISTORY_ACTIONS[type];
  need(actions, 400, 'bad_type', `type must be one of: ${Object.keys(HISTORY_ACTIONS).join(', ')}`);
  need(id, 400, 'id_required', 'id is required');
  const placeholders = actions.map(() => '?').join(',');
  const rows = all(
    `SELECT id, at, actor_id, action, detail FROM audit_log
     WHERE action IN (${placeholders}) ORDER BY id DESC LIMIT 200`,
    ...actions,
  );
  return rows
    .map((r) => ({ ...r, detail: jsonParse(r.detail) }))
    .filter((r) => {
      const d = r.detail || {};
      if (type === 'template') return d.key === id;
      if (type === 'check-rule') return d.rule_id === id;
      if (type === 'mcq') return d.mcq_id === id;
      return d.id === id;
    });
}

export function adminHealth({ providerName, config, icdStats }) {
  let db_ok = false;
  try {
    get('SELECT 1 AS x');
    db_ok = true;
  } catch { db_ok = false; }
  const icd = icdStats();
  return {
    status: db_ok ? 'ok' : 'degraded',
    time: new Date().toISOString(),
    provider: providerName(),
    model: config.provider === 'openai' ? config.openai.model : 'mock-1',
    prompt_version: config.versions.prompt,
    db_ok,
    icd_loaded: (icd.count || 0) > 0,
    icd,
    ai_enabled: getSetting('ai_enabled', true),
  };
}
