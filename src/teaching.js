import { all, get, run, audit } from './db.js';
import { uid, nowIso, today, need, str, isIsoDate, jsonParse } from './util.js';
import { searchEvidence, searchGuidelines, publicCard, assertQuerySafe } from './evidence/pubmed.js';
import { publicMcq, getMcq, topicKey } from './learning.js';

export { topicKey };

/** Generic topics from the clinician's team census — no patient ids stored. */
export function teachingPlan({ user, date }) {
  const day = str(date, 10) || today();
  need(isIsoDate(day), 400, 'bad_date', 'date must be YYYY-MM-DD');
  const rows = all(
    `SELECT p.label, p.state FROM problems p
     JOIN patients pt ON pt.id=p.patient_id
     JOIN team_members m ON m.team_id=pt.team_id
     WHERE m.user_id=? AND p.state IN ('confirmed','differential')`,
    user.id,
  );
  const map = new Map();
  for (const r of rows) {
    const key = topicKey(r.label);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { topic: r.label.trim().slice(0, 150), topic_key: key, count: 0, confirmed: 0, differential: 0 });
    const t = map.get(key);
    t.count += 1;
    if (r.state === 'confirmed') t.confirmed += 1;
    else t.differential += 1;
  }
  const topics = [...map.values()].sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
  audit(user.id, 'teaching_plan', { detail: { date: day, topics: topics.length } });
  return {
    date: day,
    topics,
    note: 'Topics are generic strings derived from confirmed/differential problems on your team census. No patient identifiers are stored with the teaching plan.',
  };
}

/**
 * Serve approved bank questions first (spaced-review due, then not recently seen).
 * Optionally generate ai_generated_unreviewed when bank is short and allow_generate=true.
 */
export async function teachingQuestions({ user, topic, count = 1, allowGenerate = false, generateMcqs }) {
  const t = str(topic, 150);
  need(t, 400, 'topic_required', 'topic is required');
  const key = topicKey(t);
  const n = Math.min(Math.max(Number(count) || 1, 1), 5);

  const due = all(
    `SELECT m.* FROM mcqs m
     JOIN attempts a ON a.mcq_id=m.id
     WHERE m.status='approved' AND m.topic_key=? AND a.user_id=?
       AND a.next_review_at IS NOT NULL AND a.next_review_at<=?
       AND a.created_at=(SELECT MAX(created_at) FROM attempts WHERE user_id=a.user_id AND mcq_id=a.mcq_id)
     ORDER BY a.next_review_at
     LIMIT ?`,
    key, user.id, nowIso(), n,
  );

  const seen = new Set(all('SELECT mcq_id FROM attempts WHERE user_id=?', user.id).map((r) => r.mcq_id));
  const dueIds = new Set(due.map((r) => r.id));

  const fresh = all(
    `SELECT * FROM mcqs WHERE status='approved' AND topic_key=? ORDER BY created_at DESC LIMIT 50`,
    key,
  ).filter((r) => !dueIds.has(r.id) && !seen.has(r.id));

  const rest = all(
    `SELECT * FROM mcqs WHERE status='approved' AND topic_key=? ORDER BY created_at DESC LIMIT 50`,
    key,
  ).filter((r) => !dueIds.has(r.id) && seen.has(r.id));

  const picked = [...due, ...fresh, ...rest].slice(0, n);
  const out = picked.map((row) => ({
    ...publicMcq(row),
    source: row.source || 'ai_generated',
    bank: true,
    learner_label: row.source === 'human' ? 'Approved bank question' : 'Approved bank question (originally AI-generated)',
  }));

  const generated = [];
  if (out.length < n && allowGenerate && typeof generateMcqs === 'function') {
    const needMore = n - out.length;
    const gen = await generateMcqs({ user, patient: null, input: { topic: t, count: needMore } });
    for (const id of gen.mcq_ids || []) {
      const row = getMcq(id);
      generated.push({
        ...publicMcq(row),
        source: row.source || 'ai_generated',
        bank: false,
        learner_label: 'AI-generated (unreviewed). For education only — report issues. Not yet approved for the bank.',
        admin_review_queue: true,
      });
    }
  }

  return {
    topic: t,
    topic_key: key,
    questions: [...out, ...generated].slice(0, n),
    bank_served: out.length,
    generated: generated.length,
    note: 'One question at a time. Answers are withheld until you submit. Attempts are stored at topic level only.',
  };
}

export function adminMcqReviewQueue({ status, topic, source, limit = 100 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  let sql = 'SELECT id, topic, topic_key, difficulty, stage, status, source, created_by, approved_by, approved_at, created_at FROM mcqs WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND status=?'; args.push(status); }
  else { sql += " AND status IN ('ai_generated_unreviewed','reported')"; }
  if (topic) { sql += ' AND topic_key=?'; args.push(topicKey(topic)); }
  if (source) { sql += ' AND source=?'; args.push(source); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(lim);
  return all(sql, ...args);
}

/** Full MCQ for admin review (includes answer key / explanations). Never for learners. */
export function adminMcqDetail(id) {
  const row = get('SELECT * FROM mcqs WHERE id=?', id);
  need(row, 404, 'not_found', 'MCQ not found');
  return {
    id: row.id,
    topic: row.topic,
    topic_key: row.topic_key,
    difficulty: row.difficulty,
    stage: row.stage,
    status: row.status,
    source: row.source,
    created_by: row.created_by,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    created_at: row.created_at,
    content: jsonParse(row.content, {}),
    validation: jsonParse(row.validation, null),
  };
}

export function approveMcq({ user, id, status = 'approved' }) {
  need(['approved', 'retired', 'ai_generated_unreviewed'].includes(status), 400, 'bad_status', 'Invalid status');
  const row = get('SELECT * FROM mcqs WHERE id=?', id);
  need(row, 404, 'not_found', 'MCQ not found');
  const approved_by = status === 'approved' ? user.id : null;
  const approved_at = status === 'approved' ? nowIso() : null;
  run('UPDATE mcqs SET status=?, approved_by=?, approved_at=? WHERE id=?', status, approved_by, approved_at, id);
  audit(user.id, 'admin_mcq_status', { detail: { mcq_id: id, status } });
  return { id, status, approved_by, approved_at };
}

/** Recommended reads with honest labels. "high-yield" only for admin-curated approved items. */
export async function teachingReads({ topic }) {
  const t = str(topic, 150);
  need(t, 400, 'topic_required', 'topic is required');
  assertQuerySafe(t, null);
  const key = topicKey(t);

  let recent = [];
  let older = [];
  let guidelines = [];
  let retrieval_error = null;
  try {
    const ev = await searchEvidence({ topic: t, months: 24, includeOlder: true });
    recent = (ev.recent || []).slice(0, 5).map((r) => ({
      ...publicCard(r),
      label: 'Recent',
      high_yield: false,
      curated: false,
    }));
    older = (ev.older || []).slice(0, 5).map((r) => ({
      ...publicCard(r),
      label: 'Older high-design-level evidence',
      high_yield: false,
      curated: false,
      note: 'Selected by study-design filters outside the recent window. Not a curated landmark list.',
    }));
  } catch (e) {
    retrieval_error = 'evidence_retrieval_failed';
  }
  try {
    const g = await searchGuidelines({ topic: t, months: 12 });
    guidelines = (g.records || []).slice(0, 5).map((r) => ({
      ...publicCard(r),
      label: 'Guideline',
      high_yield: false,
      curated: false,
      published_window: 'last_12_months',
    }));
  } catch {
    /* guidelines optional if PubMed fails */
  }

  const curated = all(
    `SELECT id, topic, title, citation, url, pmid, why_it_matters, created_at
     FROM curated_reads WHERE topic_key=? AND approved=1 ORDER BY created_at DESC LIMIT 20`,
    key,
  ).map((r) => ({
    curated_id: r.id,
    title: r.title,
    citation: r.citation,
    url: r.url || (r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` : null),
    pmid: r.pmid,
    why_it_matters: r.why_it_matters,
    label: 'Curated high-yield',
    high_yield: true, // only admin-curated may use this label
    curated: true,
  }));

  const updates = all(
    `SELECT id, topic, organization, title, published_date, url, summary_by_admin, approved_at
     FROM guideline_updates WHERE topic_key=? AND status='approved'
     ORDER BY COALESCE(published_date,'' ) DESC, created_at DESC LIMIT 20`,
    key,
  ).map((r) => ({
    ...r,
    label: 'Guideline update (admin-entered)',
    verify: 'Verify against the source before applying to care.',
    high_yield: false,
  }));

  return {
    topic: t,
    topic_key: key,
    recent,
    older_high_design: older,
    guidelines_pubmed: guidelines,
    curated_high_yield: curated,
    guideline_updates: updates,
    retrieval_error,
    note: '"High-yield" is shown only for admin-curated entries. Retrieved PubMed items are labeled Recent / Guideline / Older high-design-level — never landmark by model opinion.',
  };
}

/* ---------------- admin curated reads / guideline updates ---------------- */

export function createCuratedRead({ user, body }) {
  const topic = str(body.topic, 150);
  need(topic, 400, 'topic_required', 'topic is required');
  const title = str(body.title, 300);
  need(title, 400, 'title_required', 'title is required');
  const id = uid();
  run(
    `INSERT INTO curated_reads(id,topic,topic_key,title,citation,url,pmid,why_it_matters,added_by,approved,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,0,?)`,
    id, topic, topicKey(topic), title, str(body.citation, 500) || null, str(body.url, 500) || null,
    str(body.pmid, 12) || null, str(body.why_it_matters, 1000) || null, user.id, nowIso(),
  );
  audit(user.id, 'curated_read_create', { detail: { id } });
  return get('SELECT * FROM curated_reads WHERE id=?', id);
}

export function approveCuratedRead({ user, id }) {
  const row = get('SELECT * FROM curated_reads WHERE id=?', id);
  need(row, 404, 'not_found', 'Curated read not found');
  run('UPDATE curated_reads SET approved=1, approved_by=?, approved_at=? WHERE id=?', user.id, nowIso(), id);
  audit(user.id, 'curated_read_approve', { detail: { id } });
  return get('SELECT * FROM curated_reads WHERE id=?', id);
}

export function listCuratedReads({ approved } = {}) {
  if (approved === undefined) return all('SELECT * FROM curated_reads ORDER BY created_at DESC LIMIT 200');
  return all('SELECT * FROM curated_reads WHERE approved=? ORDER BY created_at DESC LIMIT 200', Number(!!approved));
}

export function createGuidelineUpdate({ user, body }) {
  const topic = str(body.topic, 150);
  const organization = str(body.organization, 120);
  const title = str(body.title, 300);
  need(topic && organization && title, 400, 'fields_required', 'topic, organization, and title are required');
  const id = uid();
  run(
    `INSERT INTO guideline_updates(id,topic,topic_key,organization,title,published_date,url,summary_by_admin,status,added_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,'draft',?,?)`,
    id, topic, topicKey(topic), organization, title,
    body.published_date ? str(body.published_date, 10) : null,
    str(body.url, 500) || null, str(body.summary_by_admin, 2000) || null, user.id, nowIso(),
  );
  audit(user.id, 'guideline_update_create', { detail: { id } });
  return get('SELECT * FROM guideline_updates WHERE id=?', id);
}

export function approveGuidelineUpdate({ user, id }) {
  const row = get('SELECT * FROM guideline_updates WHERE id=?', id);
  need(row, 404, 'not_found', 'Guideline update not found');
  run("UPDATE guideline_updates SET status='approved', approved_by=?, approved_at=? WHERE id=?", user.id, nowIso(), id);
  audit(user.id, 'guideline_update_approve', { detail: { id } });
  return get('SELECT * FROM guideline_updates WHERE id=?', id);
}

export function listGuidelineUpdates({ status } = {}) {
  if (status) return all('SELECT * FROM guideline_updates WHERE status=? ORDER BY created_at DESC LIMIT 200', status);
  return all('SELECT * FROM guideline_updates ORDER BY created_at DESC LIMIT 200');
}

export function censusGuidelineUpdates({ user }) {
  const plan = teachingPlan({ user, date: today() });
  const keys = plan.topics.map((t) => t.topic_key);
  if (!keys.length) return { updates: [], note: 'No census topics yet.' };
  const placeholders = keys.map(() => '?').join(',');
  const updates = all(
    `SELECT * FROM guideline_updates WHERE status='approved' AND topic_key IN (${placeholders})
     ORDER BY COALESCE(published_date,'') DESC, created_at DESC LIMIT 50`,
    ...keys,
  ).map((r) => ({
    id: r.id, topic: r.topic, organization: r.organization, title: r.title,
    published_date: r.published_date, url: r.url, summary_by_admin: r.summary_by_admin,
    verify: 'Verify against the source before applying to care.',
  }));
  return { updates, note: 'Admin-entered guideline updates for topics on your census. Newest first. Verify against the source.' };
}
