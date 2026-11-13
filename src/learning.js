import { all, get, run, getSetting, audit } from './db.js';
import { HttpError, uid, nowIso, jsonParse, need } from './util.js';

export const reviewIntervals = () => getSetting('review_intervals_days', [1, 3, 7]);

export function topicKey(topic) {
  return String(topic || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function saveMcq({ user, topic, difficulty, stage, content, validation, model, source = 'ai_generated' }) {
  const id = uid();
  const key = topicKey(topic);
  const src = source === 'human' ? 'human' : 'ai_generated';
  run(
    `INSERT INTO mcqs(id,topic,topic_key,difficulty,stage,content,validation,status,source,created_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id, topic, key, difficulty, stage, JSON.stringify({ ...content, model }), JSON.stringify(validation),
    'ai_generated_unreviewed', src, user.id, nowIso(),
  );
  return id;
}

/** What the learner sees BEFORE answering: no key, no explanations. */
export function publicMcq(row) {
  const c = jsonParse(row.content, {});
  return {
    mcq_id: row.id, topic: row.topic, topic_key: row.topic_key || topicKey(row.topic),
    difficulty: row.difficulty, stage: row.stage, status: row.status, source: row.source || 'ai_generated',
    vignette: c.vignette, question: c.question, options: c.options,
    notice: row.status === 'approved'
      ? 'Educational question. Report any issue with the button provided.'
      : 'AI-generated educational question (unreviewed). Report any issue with the button provided.',
  };
}

export function getMcq(id) {
  const row = get('SELECT * FROM mcqs WHERE id=?', id);
  if (!row) throw new HttpError(404, 'not_found', 'Question not found');
  return row;
}

/**
 * Learners may open approved bank questions, or unreviewed ones they already hold an id for
 * (from /learning/generate or teaching allow_generate). Retired/reported are not served.
 * The teaching bank itself never lists unreviewed unless allow_generate creates new ones.
 */
export function getMcqForLearner(id) {
  const row = getMcq(id);
  if (row.status === 'approved' || row.status === 'ai_generated_unreviewed') return row;
  if (row.status === 'retired') throw new HttpError(404, 'not_found', 'Question not found');
  throw new HttpError(403, 'not_approved', 'This question is not approved for learners yet.');
}

export function answerMcq({ user, mcqId, choice, seconds, confidence }) {
  const row = getMcqForLearner(mcqId);
  const c = jsonParse(row.content, {});
  need(['A', 'B', 'C', 'D', 'E'].includes(choice), 400, 'bad_choice', 'choice must be A-E');
  const correct = choice === c.answer ? 1 : 0;
  const prev = get('SELECT * FROM attempts WHERE user_id=? AND mcq_id=? ORDER BY created_at DESC LIMIT 1', user.id, mcqId);
  const intervals = reviewIntervals();
  let stage = null;
  let next = null;
  const addDays = (d) => new Date(Date.now() + d * 86400_000).toISOString();
  if (!correct) { stage = 0; next = addDays(intervals[0]); }
  else if (prev && prev.next_review_at !== null && prev.review_stage !== null) {
    stage = prev.review_stage + 1;
    next = stage < intervals.length ? addDays(intervals[stage]) : null;
  }
  // Topic-level attempt only — no patient_id column by design.
  run('INSERT INTO attempts(id,user_id,mcq_id,topic,correct,seconds,confidence,review_stage,next_review_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    uid(), user.id, mcqId, row.topic, correct, Number.isFinite(seconds) ? Math.round(seconds) : null, Number.isFinite(confidence) ? confidence : null, stage, next, nowIso());
  return {
    correct: !!correct, correct_answer: c.answer, explanation: c.explanation, option_explanations: c.option_explanations,
    learning_objective: c.learning_objective, evidence: c.evidence, next_review_at: next,
  };
}

/** Questions the user missed (or is mid-way through) whose review date has arrived. Latest attempt per question wins. */
export function reviewQueue(user) {
  const rows = all(
    `SELECT a.mcq_id, a.next_review_at, a.review_stage, m.topic FROM attempts a
     JOIN mcqs m ON m.id=a.mcq_id
     WHERE a.user_id=? AND a.next_review_at IS NOT NULL AND m.status='approved'
       AND a.created_at=(SELECT MAX(created_at) FROM attempts WHERE user_id=a.user_id AND mcq_id=a.mcq_id)
       AND a.next_review_at<=?
     ORDER BY a.next_review_at`, user.id, nowIso());
  return rows;
}

export function reportIssue({ user, mcqId, note }) {
  getMcq(mcqId);
  run('INSERT INTO issue_reports(id,mcq_id,user_id,note,created_at) VALUES(?,?,?,?,?)', uid(), mcqId, user.id, String(note || '').slice(0, 1000), nowIso());
  run("UPDATE mcqs SET status='reported' WHERE id=?", mcqId);
  audit(user.id, 'mcq_report', { detail: { mcq_id: mcqId } });
  return { ok: true };
}

export function topicStats(user) {
  return all(
    `SELECT topic, COUNT(*) AS attempts, SUM(correct) AS correct FROM attempts WHERE user_id=? GROUP BY topic ORDER BY topic`, user.id);
}
