import { get, run } from '../db.js';
import { authorizePatient } from '../auth.js';
import { need, str, nowIso, uid, today, isIsoDate } from '../util.js';
import * as O from '../ai/orchestrator.js';
import * as L from '../learning.js';
import { authorizeArtifact } from './patients.js';
import { all } from '../db.js';
import { resolveMediaPayload } from '../upload.js';
import { buildRoundBrief, prepareRoundBrief } from '../round_brief.js';
import * as T from '../teaching.js';

/** Replays the stored response when the client retries with the same Idempotency-Key (no duplicate AI calls). */
async function withIdempotency(ctx, fn) {
  const key = String(ctx.req.headers['idempotency-key'] || '').slice(0, 100);
  if (!key) return fn();
  const row = get('SELECT response FROM idempotency WHERE key=? AND user_id=?', key, ctx.user.id);
  if (row) return JSON.parse(row.response);
  const out = await fn();
  run('INSERT OR IGNORE INTO idempotency(key,user_id,response,created_at) VALUES(?,?,?,?)', key, ctx.user.id, JSON.stringify(out), nowIso());
  return out;
}

const dateOf = (body) => {
  const d = str(body?.date, 10) || today();
  need(isIsoDate(d), 400, 'bad_date', 'date must be YYYY-MM-DD');
  return d;
};

export function aiRoutes(r) {
  r.post('/patients/:id/sources/:sid/extract', (ctx) => withIdempotency(ctx, () => {
    const patient = authorizePatient(ctx.user, ctx.params.id);
    const source = get('SELECT * FROM sources WHERE id=? AND patient_id=?', ctx.params.sid, patient.id);
    need(source, 404, 'not_found', 'Source not found');
    return O.extractFacts({ user: ctx.user, patient, source });
  }));

  // Scribe intake: audio|image -> source text -> pending facts (raw bytes discarded by default).
  r.post('/patients/:id/intake', (ctx) => withIdempotency(ctx, () => {
    const patient = authorizePatient(ctx.user, ctx.params.id);
    const media = resolveMediaPayload({ body: ctx.body, upload: ctx.upload });
    need(!media.eventTime || isIsoDate(media.eventTime), 400, 'bad_time', 'event_time must be ISO date/time');
    return O.intakeMedia({ user: ctx.user, patient, media });
  }));

  // Dictate into note fields only (no chart source / facts).
  r.post('/transcribe', (ctx) => withIdempotency(ctx, () => {
    const media = resolveMediaPayload({ body: ctx.body, upload: ctx.upload, defaultKind: 'audio' });
    need(media.kind === 'audio', 400, 'bad_kind', 'POST /transcribe accepts audio only');
    return O.transcribeOnly({ user: ctx.user, media });
  }));

  // Census by photo or voice: propose only (nothing created until confirm).
  r.post('/census/intake', (ctx) => withIdempotency(ctx, () => {
    const teamId = str(ctx.body.team_id, 64)
      || get('SELECT team_id FROM team_members WHERE user_id=? LIMIT 1', ctx.user.id)?.team_id;
    need(teamId, 400, 'team_required', 'team_id is required (or join a team)');
    const media = resolveMediaPayload({ body: ctx.body, upload: ctx.upload });
    return O.censusIntake({ user: ctx.user, teamId, media });
  }));

  r.post('/census/intake/:id/confirm', ({ user, params, body }) =>
    O.censusConfirm({ user, intakeId: params.id, body }));

  r.get('/census/export', ({ user, query }) =>
    O.censusExport({ user, teamId: query.team_id ? str(query.team_id, 64) : null }));

  r.post('/patients/:id/summary', (ctx) => withIdempotency(ctx, () =>
    O.summarizePatient({ user: ctx.user, patient: authorizePatient(ctx.user, ctx.params.id), date: dateOf(ctx.body) })));

  r.post('/patients/:id/present', (ctx) => withIdempotency(ctx, () =>
    O.presentPatient({ user: ctx.user, patient: authorizePatient(ctx.user, ctx.params.id), date: dateOf(ctx.body) })));

  r.get('/round/brief', ({ user, query }) =>
    buildRoundBrief({ user, date: query.date, teamId: query.team_id ? str(query.team_id, 64) : null }));

  r.post('/round/brief/prepare', (ctx) => withIdempotency(ctx, () =>
    prepareRoundBrief({ user: ctx.user, body: ctx.body || {}, presentPatient: O.presentPatient })));

  r.post('/patients/:id/notes', (ctx) => withIdempotency(ctx, () =>
    O.draftNote({ user: ctx.user, patient: authorizePatient(ctx.user, ctx.params.id), input: ctx.body })));

  r.post('/artifacts/:id/sections/:key/rewrite', (ctx) => {
    const artifact = authorizeArtifact(ctx.user, ctx.params.id);
    return O.rewriteSection({ user: ctx.user, artifact, key: ctx.params.key, mode: ctx.body.mode });
  });

  r.post('/patients/:id/problems/suggest', (ctx) => withIdempotency(ctx, () =>
    O.suggestProblems({ user: ctx.user, patient: authorizePatient(ctx.user, ctx.params.id), date: dateOf(ctx.body) })));

  r.post('/patients/:id/coding/suggest', (ctx) => withIdempotency(ctx, () =>
    O.suggestCoding({ user: ctx.user, patient: authorizePatient(ctx.user, ctx.params.id), input: ctx.body || {} })));

  r.post('/patients/:id/problems/:pid/coding/accept', ({ user, params, body }) => {
    const patient = authorizePatient(user, params.id);
    return O.acceptCodingSuggestion({ user, patient, problemId: params.pid, body: body || {} });
  });

  r.post('/patients/:id/evidence', (ctx) => withIdempotency(ctx, () =>
    O.runEvidence({ user: ctx.user, patient: authorizePatient(ctx.user, ctx.params.id), input: ctx.body })));

  r.post('/patients/:id/mcq', (ctx) => withIdempotency(ctx, () =>
    O.generateMcqs({ user: ctx.user, patient: authorizePatient(ctx.user, ctx.params.id), input: ctx.body })));

  r.post('/learning/generate', (ctx) => withIdempotency(ctx, () =>
    O.generateMcqs({ user: ctx.user, patient: null, input: ctx.body })));

  r.post('/patients/:id/tasks/propose', (ctx) => withIdempotency(ctx, () =>
    O.extractTasks({ user: ctx.user, patient: authorizePatient(ctx.user, ctx.params.id), date: dateOf(ctx.body) })));

  r.post('/patients/:id/signout', (ctx) => withIdempotency(ctx, () =>
    O.draftSignout({ user: ctx.user, patient: authorizePatient(ctx.user, ctx.params.id), input: ctx.body })));

  r.post('/patients/:id/considerations', (ctx) => withIdempotency(ctx, () =>
    O.exploreConsiderations({ user: ctx.user, patient: authorizePatient(ctx.user, ctx.params.id), date: dateOf(ctx.body) })));

  r.post('/patients/:id/ask', (ctx) =>
    O.ask({ user: ctx.user, patient: authorizePatient(ctx.user, ctx.params.id), input: ctx.body }));

  /* ---------- learning ---------- */
  r.get('/mcq/:id', ({ params }) => L.publicMcq(L.getMcqForLearner(params.id)));
  r.post('/mcq/:id/answer', ({ user, params, body }) =>
    L.answerMcq({ user, mcqId: params.id, choice: body.choice, seconds: Number(body.seconds), confidence: Number(body.confidence) }));
  r.post('/mcq/:id/report', ({ user, params, body }) => L.reportIssue({ user, mcqId: params.id, note: body.note }));
  r.get('/learning/review-queue', ({ user }) => L.reviewQueue(user));
  r.get('/learning/stats', ({ user }) => L.topicStats(user));

  /* ---------- teaching (M4) ---------- */
  r.get('/teaching/plan', ({ user, query }) => T.teachingPlan({ user, date: query.date }));
  r.get('/teaching/questions', (ctx) => withIdempotency(ctx, () => T.teachingQuestions({
    user: ctx.user,
    topic: ctx.query.topic,
    count: Number(ctx.query.count) || 1,
    allowGenerate: ctx.query.allow_generate === '1' || ctx.query.allow_generate === 'true',
    generateMcqs: O.generateMcqs,
  })));
  r.get('/teaching/reads', ({ query }) => T.teachingReads({ topic: query.topic }));
  r.get('/teaching/guideline-updates', ({ user }) => T.censusGuidelineUpdates({ user }));

  /* ---------- reading list (per user; URL always built from PMID by the server) ---------- */
  r.get('/reading-list', ({ user }) => all('SELECT pmid,title,url,created_at FROM reading_list WHERE user_id=? ORDER BY created_at DESC', user.id));
  r.post('/reading-list', ({ user, body }) => {
    const pmid = str(body.pmid, 12);
    need(/^\d{1,9}$/.test(pmid), 400, 'bad_pmid', 'pmid must be numeric');
    run('INSERT OR IGNORE INTO reading_list(id,user_id,pmid,title,url,created_at) VALUES(?,?,?,?,?,?)', uid(), user.id, pmid, str(body.title, 300), `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, nowIso());
    return { ok: true };
  });
}
