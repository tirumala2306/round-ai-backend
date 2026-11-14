process.env.DB_PATH = ':memory:';
process.env.AI_PROVIDER = 'mock';
process.env.AUTH_SECRET = 'test-secret';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/server.js');
const { seedDemo, DEMO_PASSWORD } = await import('../src/seed.js');
const { setEvidenceFetch } = await import('../src/evidence/pubmed.js');
const { validateExtractFacts, validateSummary } = await import('../src/ai/validators.js');
const { get } = await import('../src/db.js');

let server; let base; let seed;
let resident; let admin; let other;

async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}
const login = async (email) => (await api('POST', '/auth/login', { body: { email, password: DEMO_PASSWORD } })).json.token;

const xml = (pmid, { title, types, year = '2025', month = '03', retraction = false, abstract = 'Background: test. Results: mortality was 12% versus 18%. Conclusions: benefit seen.' }) => `
<PubmedArticle><MedlineCitation><PMID Version="1">${pmid}</PMID><Article><Journal><Title>Test Journal</Title></Journal>
<ArticleTitle>${title}</ArticleTitle><Abstract><AbstractText Label="RESULTS">${abstract}</AbstractText></Abstract>
<PublicationTypeList>${types.map((t) => `<PublicationType>${t}</PublicationType>`).join('')}</PublicationTypeList>
<ArticleDate DateType="Electronic"><Year>${year}</Year><Month>${month}</Month><Day>01</Day></ArticleDate></Article>
${retraction ? '<CommentsCorrectionsList><CommentsCorrections RefType="RetractionIn"/></CommentsCorrectionsList>' : ''}</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/${pmid}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`;

const fakeNcbi = async (url) => {
  const u = String(url);
  if (u.includes('esearch')) {
    // Match teaching guidelines query only — not the older-evidence design filter that mentions practice guideline PT.
    const decoded = decodeURIComponent(u);
    const ids = /"Guideline"\[pt\]/i.test(decoded)
      ? ['555', '111']
      : ['111', '222', '333', '444'];
    return { ok: true, status: 200, json: async () => ({ esearchresult: { idlist: ids } }) };
  }
  const wanted = new Set((decodeURIComponent(u).match(/[?&]id=([^&]+)/) || [])[1]?.split(',') || []);
  const articles = [
    xml('111', { title: 'Trial of therapy X', types: ['Randomized Controlled Trial'] }),
    xml('222', { title: 'Retracted study', types: ['Journal Article'], retraction: true }),
    xml('333', { title: 'An editorial', types: ['Editorial'] }),
    xml('444', { title: 'Meta-analysis of X', types: ['Meta-Analysis'], year: '2024' }),
    xml('555', { title: 'Practice guideline for therapy X', types: ['Practice Guideline'] }),
  ].filter((a) => !wanted.size || [...wanted].some((id) => a.includes(`>${id}</PMID>`)));
  const body = `<PubmedArticleSet>${articles.join('')}</PubmedArticleSet>`;
  return { ok: true, status: 200, text: async () => body };
};

before(async () => {
  server = createApp();
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  seed = await seedDemo();
  setEvidenceFetch(fakeNcbi, { gapMs: 0 });
  resident = await login('resident@rounds.test');
  admin = await login('admin@rounds.test');
  other = await login('other@rounds.test');
});
after(() => server.close());

test('health and auth', async () => {
  assert.equal((await api('GET', '/health')).status, 200);
  assert.equal((await api('GET', '/patients')).status, 401);
  assert.equal((await api('POST', '/auth/login', { body: { email: 'resident@rounds.test', password: 'wrong-password' } })).status, 401);
  assert.equal((await api('GET', '/me', { token: resident })).json.role, 'resident');
});

test('team isolation: other team cannot read the patient; admin role does not bypass', async () => {
  assert.equal((await api('GET', `/patients/${seed.patientId}`, { token: other })).status, 403);
  assert.equal((await api('GET', '/patients', { token: other })).json.length, 0);
  const logged = get("SELECT COUNT(*) AS n FROM audit_log WHERE action='access_denied'").n;
  assert.ok(logged >= 1);
});

test('summary only cites known facts; every claim has fact_ids; no direct identifiers sent to the model', async () => {
  const r = await api('POST', `/patients/${seed.patientId}/summary`, { token: resident, body: { date: '2026-08-31' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.requires_review, true);
  const claims = [r.json.content.one_liner, ...r.json.content.sections.flatMap((s) => s.claims)].filter(Boolean);
  assert.ok(claims.length > 0);
  for (const c of claims) assert.ok(c.fact_ids.length > 0);
  const { buildContext } = await import('../src/context.js');
  const ctx = buildContext(get('SELECT * FROM patients WHERE id=?', seed.patientId));
  assert.ok(!JSON.stringify(ctx).includes('Rosa'));
  assert.ok(!JSON.stringify(ctx).includes('509A'));
  assert.ok(ctx.trends.find((t) => /creatinine/i.test(t.label) && t.delta === '1.2'));
});

test('review baseline -> new fact -> artifact becomes Outdated and cannot be reviewed; changes are computed in code', async () => {
  const s = (await api('POST', `/patients/${seed.patientId}/summary`, { token: resident, body: { date: '2026-08-31' } })).json;
  assert.equal((await api('GET', `/patients/${seed.patientId}/changes`, { token: resident })).json.status, 'no_baseline');
  assert.equal((await api('POST', `/artifacts/${s.artifact_id}/review`, { token: resident })).status, 200);
  await api('POST', `/patients/${seed.patientId}/facts`, { token: resident, body: { label: 'Creatinine', value: '2.6', unit: 'mg/dL', event_time: '2026-09-01T06:00' } });
  const old = (await api('GET', `/artifacts/${s.artifact_id}`, { token: resident })).json;
  assert.equal(old.outdated, true);
  assert.equal((await api('POST', `/artifacts/${s.artifact_id}/review`, { token: resident })).status, 409);
  const ch = (await api('GET', `/patients/${seed.patientId}/changes`, { token: resident })).json;
  assert.equal(ch.computed_in_code, true);
  assert.equal(ch.new_facts.length, 1);
  assert.equal(ch.trends[0].delta, '1.7');
});

test('note: plan never invented; placeholders block review; editing resolves; export only after review', async () => {
  const n = await api('POST', `/patients/${seed.patientId}/notes`, { token: resident, body: { note_type: 'progress', note_date: '2026-09-02', subjective: 'Feels slightly better, less short of breath.' } });
  assert.equal(n.status, 200);
  const plan = n.json.content.sections.find((s) => s.key === 'assessment_plan');
  assert.match(plan.text, /not entered/);
  assert.ok(n.json.content.missing_information.includes('clinician_plan'));
  assert.equal((await api('POST', `/artifacts/${n.json.artifact_id}/review`, { token: resident })).status, 409);
  assert.equal((await api('GET', `/artifacts/${n.json.artifact_id}/export`, { token: resident })).status, 409);
  const fixed = (await api('PATCH', `/artifacts/${n.json.artifact_id}`, { token: resident, body: { sections: [{ key: 'assessment_plan', text: 'Continue antibiotics. Recheck creatinine in the morning.' }] } })).json;
  assert.equal(fixed.review_state, 'draft');
  const rv = await api('POST', `/artifacts/${n.json.artifact_id}/review`, { token: resident });
  assert.equal(rv.status, 200);
  const ex = await api('GET', `/artifacts/${n.json.artifact_id}/export`, { token: resident });
  assert.match(ex.json.text, /ASSESSMENT AND PLAN/);
  assert.equal((await api('GET', `/artifacts/${n.json.artifact_id}`, { token: other })).status, 403);
});

test('problems: AI suggestions are never confirmed; rejected labels are not re-suggested', async () => {
  const r = await api('POST', `/patients/${seed.patientId}/problems/suggest`, { token: resident, body: {} });
  assert.equal(r.status, 200);
  const list = (await api('GET', `/patients/${seed.patientId}/problems`, { token: resident })).json;
  assert.ok(list.length >= 1);
  assert.ok(list.every((p) => p.state !== 'confirmed'));
  const aki = list.find((p) => /kidney/.test(p.label));
  assert.ok(aki);
  await api('POST', `/patients/${seed.patientId}/problems/${aki.id}/decision`, { token: resident, body: { action: 'reject' } });
  await api('POST', `/patients/${seed.patientId}/problems/suggest`, { token: resident, body: {} });
  const again = (await api('GET', `/patients/${seed.patientId}/problems`, { token: resident })).json;
  assert.equal(again.filter((p) => /kidney/.test(p.label) && p.state !== 'rejected').length, 0);
});

test('evidence: needs a confirmed problem or topic; identifiers blocked; retracted/editorial excluded; URLs built from PMID', async () => {
  const noTopic = await api('POST', `/patients/${seed.patientId}/evidence`, { token: resident, body: {} });
  assert.equal(noTopic.status, 422);
  const leak = await api('POST', `/patients/${seed.patientId}/evidence`, { token: resident, body: { topic: 'pneumonia Rosa 509A' } });
  assert.equal(leak.status, 422);
  assert.equal(leak.json.error.code, 'query_not_safe');
  const ok = await api('POST', `/patients/${seed.patientId}/evidence`, { token: resident, body: { topic: 'community acquired pneumonia' } });
  assert.equal(ok.status, 200);
  const all = [...ok.json.content.top, ...ok.json.content.more];
  assert.deepEqual(all.map((c) => c.pmid).sort(), ['111', '444']);
  assert.equal(ok.json.content.excluded_retracted, 1);
  for (const c of all) { assert.equal(c.url, `https://pubmed.ncbi.nlm.nih.gov/${c.pmid}/`); assert.equal(c.abstract, undefined); }
  assert.ok(ok.json.content.search_date);
});

test('evidence failure shows nothing from memory', async () => {
  setEvidenceFetch(async () => ({ ok: false, status: 500 }), { gapMs: 0 });
  const r = await api('POST', `/patients/${seed.patientId}/evidence`, { token: resident, body: { topic: 'sepsis bundle', force: true } });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'evidence_retrieval_failed');
  setEvidenceFetch(fakeNcbi, { gapMs: 0 });
});

test('MCQ: generated from evidence packet, answer hidden until answered, spaced review scheduled on a miss', async () => {
  const g = await api('POST', '/learning/generate', { token: resident, body: { topic: 'community acquired pneumonia', count: 2 } });
  assert.equal(g.status, 200);
  assert.equal(g.json.generated, 2);
  const id = g.json.mcq_ids[0];
  const q = await api('GET', `/mcq/${id}`, { token: resident });
  assert.equal(q.json.answer, undefined);
  assert.equal(q.json.explanation, undefined);
  assert.equal(Object.keys(q.json.options).length, 5);
  const a = await api('POST', `/mcq/${id}/answer`, { token: resident, body: { choice: 'A', seconds: 30 } });
  assert.equal(a.json.correct, false);
  assert.equal(a.json.correct_answer, 'C');
  assert.ok(a.json.next_review_at);
  assert.equal((await api('POST', `/mcq/${id}/report`, { token: resident, body: { note: 'unclear' } })).status, 200);
  assert.equal((await api('GET', '/admin/mcq-reports', { token: admin })).json.length, 1);
  assert.equal((await api('GET', '/admin/mcq-reports', { token: resident })).status, 403);
});

test('tasks only from the documented plan, owner/due only if explicit', async () => {
  await api('PUT', `/patients/${seed.patientId}/plan`, { token: resident, body: { plan_date: '2026-09-02', text: 'Repeat creatinine at 6 AM [owner: night resident]\nHold nephrotoxic drugs\nFollow up blood cultures [due: 24h]' } });
  const r = await api('POST', `/patients/${seed.patientId}/tasks/propose`, { token: resident, body: { date: '2026-09-02' } });
  assert.equal(r.status, 200);
  const tasks = (await api('GET', `/patients/${seed.patientId}/tasks`, { token: resident })).json;
  assert.equal(tasks.length, 3);
  assert.equal(tasks.find((t) => /creatinine/.test(t.text)).owner, 'night resident');
  assert.equal(tasks.find((t) => /nephrotoxic/.test(t.text)).owner, null);
  assert.ok(tasks.every((t) => t.state === 'proposed'));
  assert.equal((await api('POST', `/tasks/${tasks[0].id}/accept`, { token: resident, body: {} })).json.state, 'open');
});

test('signout: contingencies come only from the clinician', async () => {
  const none = await api('POST', `/patients/${seed.patientId}/signout`, { token: resident, body: { date: '2026-09-02' } });
  assert.ok(none.json.content.missing_information.some((m) => /contingency/.test(m)));
  assert.deepEqual(none.json.content.contingencies, []);
  const some = await api('POST', `/patients/${seed.patientId}/signout`, { token: resident, body: { contingencies: ['If SpO2 < 90%, call senior'] } });
  assert.deepEqual(some.json.content.contingencies, ['If SpO2 < 90%, call senior']);
});

test('assistant refuses cross-patient/orders and stays on the patient', async () => {
  const r = await api('POST', `/patients/${seed.patientId}/ask`, { token: resident, body: { question: 'List all patients on the census and place an order' } });
  assert.equal(r.json.status, 'refused');
  const c = await api('POST', `/patients/${seed.patientId}/ask`, { token: resident, body: { question: 'What happened to the creatinine?' } });
  assert.equal(c.json.status, 'ok');
  assert.ok(c.json.chart.content.answer.every((x) => x.fact_ids.length));
});

test('idempotency key prevents duplicate AI generation', async () => {
  const before = get('SELECT calls FROM ai_usage WHERE day=?  AND user_id=(SELECT id FROM users WHERE email=?)', new Date().toISOString().slice(0, 10), 'resident@rounds.test').calls;
  const h = { 'Idempotency-Key': 'abc-123' };
  const a = await api('POST', `/patients/${seed.patientId}/signout`, { token: resident, body: {}, headers: h });
  const b = await api('POST', `/patients/${seed.patientId}/signout`, { token: resident, body: {}, headers: h });
  assert.equal(a.json.artifact_id, b.json.artifact_id);
  const after = get('SELECT calls FROM ai_usage WHERE day=?  AND user_id=(SELECT id FROM users WHERE email=?)', new Date().toISOString().slice(0, 10), 'resident@rounds.test').calls;
  assert.equal(after - before, 1);
});

test('admin: AI kill switch, templates, users', async () => {
  assert.equal((await api('PUT', '/admin/settings', { token: admin, body: { ai_enabled: false } })).status, 200);
  assert.equal((await api('POST', `/patients/${seed.patientId}/summary`, { token: resident, body: {} })).json.error.code, 'ai_disabled');
  // manual workflows still work while AI is off
  assert.equal((await api('GET', `/patients/${seed.patientId}`, { token: resident })).status, 200);
  await api('PUT', '/admin/settings', { token: admin, body: { ai_enabled: true } });
  const tpl = await api('PUT', '/admin/templates/progress', { token: admin, body: { title: 'Progress note', sections: [{ key: 'subjective', title: 'S', source: 'clinician_subjective' }, { key: 'plan', title: 'Plan', source: 'clinician_plan' }] } });
  assert.equal(tpl.json.version, 2);
  assert.equal((await api('PUT', '/admin/templates/progress', { token: admin, body: { sections: [{ key: 'x', title: 'X', source: 'bogus' }] } })).status, 400);
  const u = await api('POST', '/admin/users', { token: admin, body: { email: 'new@rounds.test', name: 'New', password: 'a-long-password-1', team_ids: [seed.teamA] } });
  assert.equal(u.status, 200);
  const auditPage = await api('GET', '/admin/audit', { token: admin });
  assert.ok(auditPage.json.rows.length > 0);
  assert.ok(auditPage.json.total >= auditPage.json.rows.length);
  assert.equal((await api('GET', '/admin/audit', { token: resident })).status, 403);
});

test('admin P0: audit filters/csv, users last login, health, analytics gated', async () => {
  const users = await api('GET', '/admin/users', { token: admin });
  assert.equal(users.status, 200);
  const adminRow = users.json.find((u) => u.email === 'admin@rounds.test');
  assert.ok(adminRow.last_login_at);
  assert.ok(adminRow.last_activity_at);

  const filtered = await api('GET', `/admin/audit?actor_id=${adminRow.id}&action=login&limit=10`, { token: admin });
  assert.equal(filtered.status, 200);
  assert.ok(filtered.json.rows.every((r) => r.actor_id === adminRow.id && r.action === 'login'));

  const csvRes = await fetch(`${base}/admin/audit.csv?limit=20`, {
    headers: { Authorization: `Bearer ${admin}` },
  });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type') || '', /text\/csv/);
  const csvText = await csvRes.text();
  assert.match(csvText, /^id,at,actor_id,action/);

  const health = await api('GET', '/admin/health', { token: admin });
  assert.equal(health.status, 200);
  assert.equal(health.json.db_ok, true);
  assert.equal(health.json.icd_loaded, true);
  assert.ok(health.json.provider);
  assert.ok(health.json.prompt_version);
  assert.equal((await api('GET', '/admin/health', { token: resident })).status, 403);

  const activity = await api('GET', '/admin/analytics/activity', { token: admin });
  assert.equal(activity.status, 200);
  assert.ok(Array.isArray(activity.json.rows));

  const qOff = await api('GET', '/admin/analytics/questions', { token: admin });
  assert.equal(qOff.status, 200);
  assert.equal(qOff.json.individual_learner_analytics, false);
  assert.equal(qOff.json.individuals, null);

  await api('PUT', '/admin/settings', { token: admin, body: { show_individual_learner_analytics: true } });
  const qOn = await api('GET', '/admin/analytics/questions', { token: admin });
  assert.equal(qOn.json.individual_learner_analytics, true);
  assert.ok(Array.isArray(qOn.json.individuals));
  await api('PUT', '/admin/settings', { token: admin, body: { show_individual_learner_analytics: false } });

  const hist = await api('GET', '/admin/content/template/progress/history', { token: admin });
  assert.equal(hist.status, 200);
  assert.ok(Array.isArray(hist.json));
});

test('validators: invented passages and numbers are rejected', () => {
  const source = { text: 'Creatinine 2.1 mg/dL. Blood cultures pending.', event_time: '2026-08-31' };
  const v = validateExtractFacts({ facts: [
    { label: 'Creatinine', value: '2.1', unit: 'mg/dL', source_passage: 'Creatinine 2.1 mg/dL' },
    { label: 'Creatinine', value: '3.4', unit: 'mg/dL', source_passage: 'Creatinine 2.1 mg/dL' },
    { label: 'Fever', value: 'yes', source_passage: 'Patient is febrile' },
  ] }, source);
  assert.equal(v.output.facts.length, 1);
  assert.equal(v.issues.length, 2);
  const ctx = { facts: [{ fact_id: 'f1', label: 'Creatinine', value: '2.1', unit: 'mg/dL', event_time: '2026-08-31' }], trends: [], conflicts: [], missing_information: [], selected_date: '2026-08-31' };
  const s = validateSummary({ one_liner: { text: 'Creatinine 9.9', fact_ids: ['f1'] }, sections: [{ key: 'key_findings', claims: [{ text: 'Creatinine 2.1 mg/dL', fact_ids: ['f1'] }, { text: 'Made up', fact_ids: ['nope'] }] }] }, ctx);
  assert.equal(s.output.one_liner, null);
  assert.equal(s.output.sections[0].claims.length, 1);
  assert.equal(s.issues.length, 2);
});

/* ------------------------------------------------------------------ M1: templates and Admission H&P */

const HISTORY_KEYS = ['chief_complaint', 'hpi', 'pmh', 'medications', 'allergies', 'family_history', 'social_history', 'ros'];

test('M1: GET /templates includes admit_hp with clinician_history sections', async () => {
  const t = (await api('GET', '/templates', { token: resident })).json;
  assert.deepEqual(t.map((x) => x.key), ['admit_hp', 'progress', 'icu']);
  const hp = t.find((x) => x.key === 'admit_hp');
  assert.deepEqual(hp.sections.map((s) => s.title), ['Chief complaint', 'HPI', 'PMH', 'Medications', 'Allergies', 'Family history', 'Social history', 'ROS', 'Exam', 'Data', 'Assessment and Plan']);
  assert.deepEqual(hp.sections.filter((s) => s.source === 'clinician_history').map((s) => s.key), HISTORY_KEYS);
  assert.equal(hp.sections.find((s) => s.key === 'exam').source, 'clinician_exam');
  assert.equal(hp.sections.find((s) => s.key === 'data').source, 'facts');
});

test('M1: admit_hp with no history entered -> [X not entered] placeholders and review is blocked', async () => {
  const n = await api('POST', `/patients/${seed.patientId}/notes`, { token: resident, body: { note_type: 'admit_hp', note_date: '2026-09-10' } }); // a date with no saved clinician plan
  assert.equal(n.status, 200);
  assert.equal(n.json.operation, 'draft_note:admit_hp');
  assert.equal(n.json.requires_review, true);
  const by = Object.fromEntries(n.json.content.sections.map((s) => [s.key, s]));
  assert.equal(by.hpi.text, '[HPI not entered]');
  assert.equal(by.chief_complaint.text, '[Chief complaint not entered]');
  assert.equal(by.exam.text, '[Exam not entered]');
  assert.equal(by.assessment_plan.text, '[Assessment and Plan not entered]');
  for (const k of HISTORY_KEYS) assert.ok(n.json.content.missing_information.includes(`clinician_history_${k}`), k);
  assert.ok(by.data.fact_ids.length > 0, 'Data section cites confirmed facts');
  const rv = await api('POST', `/artifacts/${n.json.artifact_id}/review`, { token: resident });
  assert.equal(rv.status, 409);
  assert.equal(rv.json.error.code, 'placeholders_remaining');
  assert.equal((await api('GET', `/artifacts/${n.json.artifact_id}/export`, { token: resident })).status, 409);
});

test('M1: history text comes only from the clinician, per section; partial entry keeps remaining placeholders', async () => {
  const n = await api('POST', `/patients/${seed.patientId}/notes`, { token: resident, body: {
    note_type: 'admit_hp', note_date: '2026-09-02',
    history: { hpi: 'Three days of productive cough. Denies chest pain.', allergies: 'No known drug allergies.', bogus_section: 'ignored' },
  } });
  const by = Object.fromEntries(n.json.content.sections.map((s) => [s.key, s]));
  assert.equal(by.hpi.text, 'Three days of productive cough. Denies chest pain.');
  assert.equal(by.allergies.text, 'No known drug allergies.');
  assert.equal(by.pmh.text, '[PMH not entered]');
  assert.deepEqual(by.hpi.fact_ids, []);
  assert.deepEqual(n.json.content.ignored_history_keys, ['bogus_section']);
  assert.ok(!n.json.content.missing_information.includes('clinician_history_hpi'));
  assert.ok(n.json.content.missing_information.includes('clinician_history_pmh'));
  assert.equal((await api('POST', `/artifacts/${n.json.artifact_id}/review`, { token: resident })).status, 409);
});

test('M1: fully entered admit_hp can be reviewed and exported', async () => {
  const history = Object.fromEntries(HISTORY_KEYS.map((k) => [k, `Entered ${k} text.`]));
  const n = await api('POST', `/patients/${seed.patientId}/notes`, { token: resident, body: {
    note_type: 'admit_hp', note_date: '2026-09-02', history, exam: 'Alert, lungs clear.', plan: 'Continue antibiotics.',
  } });
  assert.equal(n.json.status, 'draft');
  assert.equal(n.json.content.unresolved_flags, 0);
  assert.equal((await api('POST', `/artifacts/${n.json.artifact_id}/review`, { token: resident })).status, 200);
  const ex = (await api('GET', `/artifacts/${n.json.artifact_id}/export`, { token: resident })).json.text;
  assert.match(ex, /^CHIEF COMPLAINT\nEntered chief_complaint text\./);
  assert.match(ex, /ASSESSMENT AND PLAN\nContinue antibiotics\./);
});

test('M1: validateNote flags invented numbers in history/exam/data and discards model text for empty history', async () => {
  const { validateNote } = await import('../src/ai/validators.js');
  const { DEFAULT_TEMPLATES } = await import('../src/templates.js');
  const tpl = DEFAULT_TEMPLATES.find((t) => t.key === 'admit_hp');
  const ctx = {
    facts: [{ fact_id: 'f1', label: 'Creatinine', value: '2.1', unit: 'mg/dL', event_time: '2026-08-31' }],
    trends: [], conflicts: [], missing_information: [], selected_date: '2026-09-02',
  };
  const inputs = { exam: 'Temp 37.5, lungs clear', plan: 'Continue antibiotics', history: { hpi: 'Cough for 3 days.', medications: '' } };
  const raw = { sections: [
    { key: 'hpi', text: 'Cough for 3 days with fever of 39.5 C.' },          // 39.5 invented
    { key: 'pmh', text: 'Hypertension, diabetes.' },                          // nothing entered: discard
    { key: 'medications', text: 'Metformin 500 mg twice daily.' },           // nothing entered: discard
    { key: 'exam', text: 'Temp 37.5, lungs clear, HR 110.' },                // 110 invented
    { key: 'data', text: 'Creatinine 2.1 mg/dL on 2026-08-31. Potassium 6.2.', fact_ids: ['f1'] }, // 6.2 invented
    { key: 'assessment_plan', text: 'Continue antibiotics for 7 days.' },     // 7 invented
  ] };
  const { output, issues } = validateNote(raw, ctx, tpl, inputs, '2026-09-02');
  const by = Object.fromEntries(output.sections.map((s) => [s.key, s]));
  assert.deepEqual(by.hpi.flags, [{ code: 'unsupported_number', numbers: ['39.5'] }]);
  assert.equal(by.pmh.text, '[PMH not entered]');
  assert.equal(by.medications.text, '[Medications not entered]');
  assert.deepEqual(by.exam.flags, [{ code: 'unsupported_number', numbers: ['110'] }]);
  assert.deepEqual(by.data.flags, [{ code: 'unsupported_number', numbers: ['6.2'] }]);
  assert.deepEqual(by.assessment_plan.flags, [{ code: 'unsupported_number', numbers: ['7'] }]);
  assert.ok(issues.some((i) => i.code === 'model_text_discarded' && i.where === 'pmh'));
  assert.ok(issues.some((i) => i.code === 'model_text_discarded' && i.where === 'medications'));
  // numbers that DO exist in the clinician input / cited facts are not flagged
  const ok = validateNote({ sections: [{ key: 'hpi', text: 'Cough for 3 days.' }, { key: 'data', text: 'Creatinine 2.1 mg/dL.', fact_ids: ['f1'] }] }, ctx, tpl, inputs, '2026-09-02');
  assert.deepEqual(ok.output.sections.find((s) => s.key === 'hpi').flags, []);
  assert.deepEqual(ok.output.sections.find((s) => s.key === 'data').flags, []);
});

test('M1: a flagged history section blocks review until the clinician edits it', async () => {
  // Craft a flagged note directly: the mock never invents numbers, so tamper with the stored artifact content.
  const n = (await api('POST', `/patients/${seed.patientId}/notes`, { token: resident, body: { note_type: 'admit_hp', note_date: '2026-09-02', history: { hpi: 'Cough.' }, exam: 'Clear.', plan: 'Rest.' } })).json;
  const { run } = await import('../src/db.js');
  const content = JSON.parse(get('SELECT content FROM artifacts WHERE id=?', n.artifact_id).content);
  content.sections.find((s) => s.key === 'hpi').flags = [{ code: 'unsupported_number', numbers: ['39.5'] }];
  run('UPDATE artifacts SET content=? WHERE id=?', JSON.stringify(content), n.artifact_id);
  const blocked = await api('POST', `/artifacts/${n.artifact_id}/review`, { token: resident });
  assert.equal(blocked.json.error.code, 'unresolved_flags');
});

test('M1: admin can publish an admit_hp version using clinician_history; other teams cannot read the note', async () => {
  const sections = [
    { key: 'hpi', title: 'HPI', source: 'clinician_history' },
    { key: 'plan', title: 'Plan', source: 'clinician_plan' },
  ];
  assert.equal((await api('PUT', '/admin/templates/admit_hp', { token: admin, body: { title: 'Admission H&P', sections } })).json.version, 2);
  assert.equal((await api('PUT', '/admin/templates/admit_hp', { token: resident, body: { sections } })).status, 403);
  const t = (await api('GET', '/templates', { token: resident })).json.find((x) => x.key === 'admit_hp');
  assert.equal(t.version, 2);
  const n = await api('POST', `/patients/${seed.patientId}/notes`, { token: resident, body: { note_type: 'admit_hp', history: { hpi: 'Cough.', pmh: 'dropped: not in template v2' } } });
  assert.deepEqual(n.json.content.ignored_history_keys, ['pmh']);
  assert.equal((await api('GET', `/artifacts/${n.json.artifact_id}`, { token: other })).status, 403);
});

/* ------------------------------------------------------------------ M2a: voice and photo intake */

const tinyWavB64 = Buffer.from('RIFF....WAVEfmt mock-audio').toString('base64');
const okImageB64 = Buffer.from('fake-png-bytes').toString('base64');
const lowImageB64 = Buffer.from('note with LOW_LEGIBILITY marker').toString('base64');

test('M2a: POST /transcribe returns text only (mock), rejects non-audio and bad mime', async () => {
  const ok = await api('POST', '/transcribe', { token: resident, body: { kind: 'audio', mime_type: 'audio/wav', file_base64: tinyWavB64 } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.text.length > 10);
  assert.equal(ok.json.provider, 'mock');
  assert.equal(ok.json.text.includes('Creatinine'), true);
  assert.equal((await api('POST', '/transcribe', { token: resident, body: { kind: 'image', mime_type: 'image/png', file_base64: okImageB64 } })).status, 400);
  assert.equal((await api('POST', '/transcribe', { token: resident, body: { kind: 'audio', mime_type: 'application/pdf', file_base64: tinyWavB64 } })).json.error.code, 'mime_not_allowed');
});

test('M2a: audio intake creates dictation source + pending facts; other team blocked', async () => {
  const before = (await api('GET', `/patients/${seed.patientId}/facts?status=pending`, { token: resident })).json.length;
  const r = await api('POST', `/patients/${seed.patientId}/intake`, { token: resident, body: {
    kind: 'audio', mime_type: 'audio/wav', file_base64: tinyWavB64, event_time: '2026-09-03T08:00',
  }});
  assert.equal(r.status, 200);
  assert.ok(r.json.source_id);
  assert.ok(r.json.fact_ids.length >= 1);
  assert.match(r.json.transcript_or_text, /Creatinine/);
  const src = (await api('GET', `/patients/${seed.patientId}/sources`, { token: resident })).json.find((s) => s.id === r.json.source_id);
  assert.equal(src.kind, 'dictation');
  const pending = (await api('GET', `/patients/${seed.patientId}/facts?status=pending`, { token: resident })).json;
  assert.ok(pending.length > before);
  assert.ok(pending.every((f) => f.reviewer_status === 'pending'));
  assert.equal((await api('POST', `/patients/${seed.patientId}/intake`, { token: other, body: { kind: 'audio', mime_type: 'audio/wav', file_base64: tinyWavB64 } })).status, 403);
});

test('M2a: image intake stores image_extract; low-legibility lines are missing_information not facts', async () => {
  const ok = await api('POST', `/patients/${seed.patientId}/intake`, { token: resident, body: {
    kind: 'image', mime_type: 'image/png', file_base64: okImageB64,
  }});
  assert.equal(ok.status, 200);
  assert.equal(ok.json.confidence, 'ok');
  assert.deepEqual(ok.json.low_legibility_lines, []);
  const src = (await api('GET', `/patients/${seed.patientId}/sources`, { token: resident })).json.find((s) => s.id === ok.json.source_id);
  assert.equal(src.kind, 'image_extract');

  const low = await api('POST', `/patients/${seed.patientId}/intake`, { token: resident, body: {
    kind: 'image', mime_type: 'image/jpeg', file_base64: lowImageB64,
  }});
  assert.equal(low.status, 200);
  assert.equal(low.json.confidence, 'partial');
  assert.ok(low.json.low_legibility_lines.some((l) => /illegible|LOW_LEGIBILITY|BP/i.test(l)));
  assert.ok(low.json.artifact.content.missing_information.some((m) => /low_legibility/i.test(m)));
  // No pending fact may cite the low-legibility passage
  const facts = (await api('GET', `/patients/${seed.patientId}/facts?status=pending`, { token: resident })).json;
  const lowPassages = low.json.low_legibility_lines.map((l) => l.toLowerCase());
  for (const id of low.json.fact_ids) {
    const drawer = (await api('GET', `/facts/${id}/source`, { token: resident })).json;
    assert.ok(!lowPassages.some((p) => drawer.passage.toLowerCase().includes(p.slice(0, 20))));
  }
  assert.ok(facts.length >= 0);
});

test('M2a: validateExtractFacts still requires verbatim passage; low-legibility exclusions work in unit test', async () => {
  const { validateExtractFacts, validateImageExtract } = await import('../src/ai/validators.js');
  const source = { text: 'Creatinine 2.1 mg/dL. BP reading illegible on photocopy.', event_time: '2026-09-03' };
  const v = validateExtractFacts({ facts: [
    { label: 'Creatinine', value: '2.1', unit: 'mg/dL', source_passage: 'Creatinine 2.1 mg/dL' },
    { label: 'BP', value: '120/80', source_passage: 'BP reading illegible on photocopy.' },
    { label: 'Invented', value: 'yes', source_passage: 'Patient is febrile' },
  ] }, source, { lowLegibilityLines: ['BP reading illegible on photocopy.'] });
  assert.equal(v.output.facts.length, 1);
  assert.equal(v.output.facts[0].label, 'Creatinine');
  assert.ok(v.output.missing_information.some((m) => /low_legibility/.test(m)));
  assert.ok(v.issues.some((i) => i.code === 'low_legibility_excluded'));
  assert.ok(v.issues.some((i) => i.code === 'passage_not_in_source'));

  const img = validateImageExtract({ text: 'A', lines: [{ text: 'blur', legibility: 'low' }], confidence: 'partial' });
  assert.deepEqual(img.output.low_legibility_lines, ['blur']);
  assert.equal(validateImageExtract({ text: '' }).output, null);
});

test('M2a: oversized and empty uploads are rejected without creating a source', async () => {
  const before = (await api('GET', `/patients/${seed.patientId}/sources`, { token: resident })).json.length;
  const empty = await api('POST', `/patients/${seed.patientId}/intake`, { token: resident, body: {
    kind: 'image', mime_type: 'image/png', file_base64: '',
  }});
  assert.ok([400, 413].includes(empty.status));
  // ~11 MiB of base64 payload marked as image (limit 10 MiB decoded)
  const big = Buffer.alloc(11 * 1024 * 1024, 1).toString('base64');
  const tooBig = await api('POST', `/patients/${seed.patientId}/intake`, { token: resident, body: {
    kind: 'image', mime_type: 'image/png', file_base64: big,
  }});
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.json.error.code, 'too_large');
  assert.equal((await api('GET', `/patients/${seed.patientId}/sources`, { token: resident })).json.length, before);
});

test('M2a: multipart octet-stream still accepted when mime_type field or JPEG magic present', async () => {
  const { resolveMediaPayload, sniffMime } = await import('../src/upload.js');
  // Minimal JPEG SOI is enough for sniffMime
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  assert.equal(sniffMime(jpegMagic), 'image/jpeg');

  const viaField = resolveMediaPayload({
    body: {},
    upload: {
      fields: { kind: 'image', mime_type: 'image/jpeg' },
      file: { buffer: jpegMagic, mimeType: 'application/octet-stream', filename: 'photo.jpg' },
    },
  });
  assert.equal(viaField.mimeType, 'image/jpeg');

  const viaSniff = resolveMediaPayload({
    body: {},
    upload: {
      fields: { kind: 'image' },
      file: { buffer: jpegMagic, mimeType: 'application/octet-stream', filename: 'photo.jpg' },
    },
  });
  assert.equal(viaSniff.mimeType, 'image/jpeg');

  assert.throws(
    () => resolveMediaPayload({
      body: {},
      upload: {
        fields: { kind: 'image' },
        file: { buffer: Buffer.from('not-an-image'), mimeType: 'application/octet-stream', filename: 'x.bin' },
      },
    }),
    (e) => e.code === 'mime_not_allowed',
  );
});

/* ------------------------------------------------------------------ M2b: census by photo or voice */

const censusImageB64 = Buffer.from('CENSUS ward list').toString('base64');
const censusAudioB64 = Buffer.from('RIFF census-audio').toString('base64');

test('M2b: census intake from image returns proposed patients; nothing created yet', async () => {
  const before = (await api('GET', '/patients', { token: resident })).json.length;
  const r = await api('POST', '/census/intake', { token: resident, body: {
    kind: 'image', mime_type: 'image/png', file_base64: censusImageB64, team_id: seed.teamA,
  }});
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'proposed');
  assert.equal(r.json.requires_review, true);
  assert.ok(r.json.patients.length >= 2);
  assert.ok(r.json.patients.every((p) => p.status === 'proposed' && p.display_name && p.source_text));
  assert.equal((await api('GET', '/patients', { token: resident })).json.length, before);
  assert.equal((await api('POST', '/census/intake', { token: other, body: {
    kind: 'image', mime_type: 'image/png', file_base64: censusImageB64, team_id: seed.teamA,
  }})).status, 403);
});

test('M2b: confirm creates patients with edits; one_line_reason is a pending fact; re-confirm blocked', async () => {
  const intake = (await api('POST', '/census/intake', { token: resident, body: {
    kind: 'image', mime_type: 'image/png', file_base64: censusImageB64, team_id: seed.teamA,
  }})).json;
  const conf = await api('POST', `/census/intake/${intake.id}/confirm`, { token: resident, body: {
    items: [
      { index: 0, edits: { display_name: 'Alex Rivera (fictional)', room: '401B', one_line_reason: 'community-acquired pneumonia' } },
      { index: 1, skip: true },
    ],
  }});
  assert.equal(conf.status, 200);
  assert.equal(conf.json.created.length, 1);
  const pid = conf.json.created[0].patient_id;
  const p = (await api('GET', `/patients/${pid}`, { token: resident })).json;
  assert.equal(p.display_name, 'Alex Rivera (fictional)');
  assert.equal(p.room, '401B');
  assert.ok(Number.isInteger(p.sort_order));
  const facts = (await api('GET', `/patients/${pid}/facts?status=pending`, { token: resident })).json;
  assert.ok(facts.some((f) => /pneumonia/i.test(f.value)));
  assert.equal((await api('POST', `/census/intake/${intake.id}/confirm`, { token: resident, body: { items: [{ index: 0 }] } })).status, 409);
  assert.equal((await api('GET', `/patients/${pid}`, { token: other })).status, 403);
});

test('M2b: audio census intake proposes patients; PATCH sort_order; export is room/sort ordered with plain text', async () => {
  const intake = await api('POST', '/census/intake', { token: resident, body: {
    kind: 'audio', mime_type: 'audio/wav', file_base64: censusAudioB64, team_id: seed.teamA,
  }});
  assert.equal(intake.status, 200);
  assert.ok(intake.json.patients.length >= 1);
  await api('POST', `/census/intake/${intake.json.id}/confirm`, { token: resident, body: {
    items: intake.json.patients.map((p) => ({ index: p.index })),
  }});

  const list = (await api('GET', '/patients', { token: resident })).json;
  const target = list.find((p) => /Jordan Lee|Alex Rivera|Rosa Martinez/.test(p.display_name));
  assert.ok(target);
  const patched = await api('PATCH', `/patients/${seed.patientId}`, { token: resident, body: { sort_order: 0 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.sort_order, 0);
  const ordered = (await api('GET', '/patients', { token: resident })).json;
  assert.equal(ordered[0].id, seed.patientId);

  const exp = await api('GET', '/census/export', { token: resident });
  assert.equal(exp.status, 200);
  assert.equal(exp.json.ordered_by, 'sort_order_then_room');
  assert.ok(exp.json.patients.length >= 1);
  assert.match(exp.json.text, /Rosa Martinez|Alex Rivera|Jordan Lee/);
  assert.ok(!('urgency' in exp.json));
  assert.ok(exp.json.patients.every((p) => !('urgency' in p)));
  assert.equal((await api('GET', `/census/export?team_id=${seed.teamA}`, { token: other })).status, 403);
});

test('M2b: validateCensusPropose drops invented numbers and passages not in extract', async () => {
  const { validateCensusPropose } = await import('../src/ai/validators.js');
  const src = '401 | Alex Rivera (fictional) | 50s | male | pneumonia\n402 | Jordan Lee (fictional) | cough';
  const v = validateCensusPropose({ patients: [
    { display_name: 'Alex Rivera (fictional)', room: '401', one_line_reason: 'pneumonia', source_text: '401 | Alex Rivera (fictional) | 50s | male | pneumonia' },
    { display_name: 'Ghost', room: '999', one_line_reason: 'sepsis', source_text: 'not on the list' },
    { display_name: 'Jordan Lee (fictional)', room: '402', one_line_reason: 'EF 15%', source_text: '402 | Jordan Lee (fictional) | cough' },
  ] }, src);
  assert.equal(v.output.patients.length, 1);
  assert.equal(v.output.patients[0].display_name, 'Alex Rivera (fictional)');
  assert.ok(v.issues.some((i) => i.code === 'source_text_not_in_extract'));
  assert.ok(v.issues.some((i) => i.code === 'unsupported_number'));
});

/* ------------------------------------------------------------------ M2c: ICD-10-CM suggestions */

test('M2c: coding suggest uses local candidates; bogus model codes dropped; accept stores on problem', async () => {
  // Ensure a confirmed problem whose label hits demo ICD rows
  const suggested = await api('POST', `/patients/${seed.patientId}/problems/suggest`, { token: resident, body: {} });
  assert.equal(suggested.status, 200);
  let problems = (await api('GET', `/patients/${seed.patientId}/problems`, { token: resident })).json
    .filter((p) => p.state !== 'rejected');
  let target = problems.find((p) => /pneumonia|kidney|aki/i.test(p.label)) || problems[0];
  assert.ok(target);
  await api('POST', `/patients/${seed.patientId}/problems/${target.id}/decision`, { token: resident, body: { action: 'accept' } });

  const r = await api('POST', `/patients/${seed.patientId}/coding/suggest`, { token: resident, body: { problem_id: target.id } });
  assert.equal(r.status, 200);
  assert.equal(r.json.requires_review, true);
  assert.match(r.json.content.label, /Not a billing determination/);
  const block = r.json.content.problems.find((p) => p.problem_id === target.id);
  assert.ok(block.candidates.length >= 1);
  assert.ok(block.suggestions.length >= 1);
  assert.ok(block.suggestions.every((s) => block.candidates.some((c) => c.code === s.code)));
  assert.ok(!block.suggestions.some((s) => s.code === 'ZZ99.99'));
  assert.ok(r.json.content.validation_issues.some((i) => i.code === 'code_not_in_candidates'));
  assert.equal(r.json.content.stored_on_problem, false);

  const before = (await api('GET', `/patients/${seed.patientId}/problems`, { token: resident })).json.find((p) => p.id === target.id);
  assert.equal(before.code_suggestion, null);

  const acc = await api('POST', `/patients/${seed.patientId}/problems/${target.id}/coding/accept`, {
    token: resident, body: { code: block.suggestions[0].code, artifact_id: r.json.artifact_id },
  });
  assert.equal(acc.status, 200);
  assert.equal(acc.json.code_suggestion.code, block.suggestions[0].code);
  assert.match(acc.json.code_suggestion.label, /Not a billing determination/);
  const after = (await api('GET', `/patients/${seed.patientId}/problems`, { token: resident })).json.find((p) => p.id === target.id);
  assert.equal(after.code_suggestion.code, block.suggestions[0].code);
  assert.equal((await api('POST', `/patients/${seed.patientId}/coding/suggest`, { token: other, body: { problem_id: target.id } })).status, 403);
});

test('M2c: uncertain / differential problem is flagged and never coding_status confirmed', async () => {
  const list = (await api('GET', `/patients/${seed.patientId}/problems`, { token: resident })).json;
  let unc = list.find((p) => p.state === 'differential' || /possible|suspected|kidney/i.test(p.label));
  if (!unc) {
    // Create via suggest then mark differential
    await api('POST', `/patients/${seed.patientId}/problems/suggest`, { token: resident, body: {} });
    unc = (await api('GET', `/patients/${seed.patientId}/problems`, { token: resident })).json.find((p) => p.state === 'suggested' || p.state === 'documented');
  }
  assert.ok(unc);
  await api('POST', `/patients/${seed.patientId}/problems/${unc.id}/decision`, { token: resident, body: { action: 'differential' } });
  // Stamp uncertainty text for the validator
  const { run } = await import('../src/db.js');
  run('UPDATE problems SET uncertainty=? WHERE id=?', 'Documented as possible / suspected in source', unc.id);

  const r = await api('POST', `/patients/${seed.patientId}/coding/suggest`, { token: resident, body: { problem_id: unc.id } });
  assert.equal(r.status, 200);
  const block = r.json.content.problems.find((p) => p.problem_id === unc.id);
  assert.equal(block.uncertain, true);
  assert.ok(block.reviewer_notes.some((n) => /uncertain|inpatient|outpatient/i.test(n)));
  assert.ok(block.suggestions.every((s) => s.coding_status === 'uncertain_not_confirmed'));
  assert.ok(!block.suggestions.some((s) => s.coding_status === 'confirmed'));
});

test('M2c: validateIcdSuggest unit — foreign codes dropped; admin icd status works', async () => {
  const { validateIcdSuggest } = await import('../src/ai/validators.js');
  const candidates = [{ code: 'J18.9', description: 'Pneumonia, unspecified organism', billable: 1 }];
  const v = validateIcdSuggest({
    suggestions: [
      { code: 'J18.9', fact_ids: ['f1'], missing_for_specificity: ['organism'], rationale: 'ok' },
      { code: 'A00.0', fact_ids: ['f1'], missing_for_specificity: [], rationale: 'invented' },
    ],
  }, { candidates, problem: { id: 'p1', label: 'pneumonia', state: 'confirmed', uncertainty: '' }, facts: [{ fact_id: 'f1' }] });
  assert.equal(v.output.suggestions.length, 1);
  assert.equal(v.output.suggestions[0].code, 'J18.9');
  assert.ok(v.issues.some((i) => i.code === 'code_not_in_candidates'));

  const adm = await api('GET', '/admin/icd', { token: admin });
  assert.equal(adm.status, 200);
  assert.ok(adm.json.count >= 1);
  assert.equal((await api('GET', '/admin/icd', { token: resident })).status, 403);

  const { parseOrderLine, formatIcdCode } = await import('../scripts/import-icd.js');
  assert.equal(formatIcdCode('J189'), 'J18.9');
  // CDC order layout: order(5) + sp + code(7) + sp + flag(1) + sp + short(60) + long
  const padded = `12345 ${'J189'.padEnd(7)} 1 ${'Pneumonia, unspecified organism'.padEnd(60)}Pneumonia, unspecified organism`;
  const parsed = parseOrderLine(padded);
  assert.equal(parsed.code, 'J18.9');
  assert.equal(parsed.billable, 1);
});

/* ------------------------------------------------------------------ W4: scribe note from dictation */

test('W4: from-dictation cleans messy transcript into sections; ambiguity → needs_clarification; no plan → placeholder', async () => {
  // Earlier admin tests may have published a slim progress template — restore defaults.
  await api('PUT', '/admin/templates/progress', { token: admin, body: {
    title: 'Progress note',
    sections: [
      { key: 'subjective', title: 'Subjective', source: 'clinician_subjective' },
      { key: 'objective', title: 'Objective', source: 'facts_and_exam' },
      { key: 'assessment_plan', title: 'Assessment and Plan', source: 'clinician_plan' },
    ],
  }});

  const messy = 'uh patient says um had a had a fever last night no chest pain maybe some chills creatinine was two point one this morning';
  const r = await api('POST', `/patients/${seed.patientId}/notes/from-dictation`, {
    token: resident,
    body: { note_type: 'progress', note_date: '2026-09-12', transcript: messy },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.content.scribe_mode, 'from_dictation');
  const subj = r.json.content.sections.find((s) => s.key === 'subjective');
  assert.ok(subj.sentences?.length >= 1);
  assert.match(subj.text, /fever|chest pain|chills/i);
  assert.ok(subj.sentences.every((s) => Array.isArray(s.spans) && s.spans.length));
  const plan = r.json.content.sections.find((s) => s.key === 'assessment_plan');
  assert.match(plan.text, /not entered/i);

  const amb = await api('POST', `/patients/${seed.patientId}/notes/from-dictation`, {
    token: resident,
    body: {
      note_type: 'icu',
      note_date: '2026-09-12',
      transcript: 'overnight the ICU console was placed and urine output was low',
    },
  });
  assert.equal(amb.status, 200);
  assert.ok(amb.json.content.needs_clarification.some((c) => /placed|console/i.test(c.phrase) || /What was placed/i.test(c.question)));
});

test('W4: invented number in scribe sentence is dropped; negation preserved', async () => {
  const { validateNoteFromDictation } = await import('../src/ai/validators.js');
  const template = {
    key: 'progress',
    sections: [
      { key: 'subjective', title: 'Subjective', source: 'clinician_subjective' },
      { key: 'objective', title: 'Objective', source: 'facts_and_exam' },
      { key: 'assessment_plan', title: 'Assessment and Plan', source: 'clinician_plan' },
    ],
  };
  const transcript = 'Patient reports fever. Denies chest pain. INVENT_BP_99 marker.';
  const feverStart = transcript.indexOf('Patient reports fever');
  const denyStart = transcript.indexOf('Denies chest pain');
  const ctx = {
    facts: [{ fact_id: 'f1', label: 'Creatinine', value: '2.1', unit: 'mg/dL', event_time: '2026-09-12', assertion: 'present' }],
    trends: [],
    conflicts: [],
    missing_information: [],
  };
  const raw = {
    sections: [
      {
        key: 'subjective',
        sentences: [
          { text: 'Patient reports fever.', spans: [{ start: feverStart, end: feverStart + 'Patient reports fever'.length }] },
          { text: 'Denies chest pain.', spans: [{ start: denyStart, end: denyStart + 'Denies chest pain'.length }] },
          { text: 'Blood pressure was 180/110.', spans: [{ start: transcript.indexOf('fever'), end: transcript.indexOf('fever') + 5 }] },
        ],
      },
      { key: 'objective', sentences: [] },
      { key: 'assessment_plan', sentences: [] },
    ],
    needs_clarification: [],
  };

  const v = validateNoteFromDictation(raw, ctx, template, transcript, '2026-09-12');
  assert.ok(v.output.sections.find((s) => s.key === 'subjective').text.includes('Denies chest pain'));
  assert.ok(!/180/.test(v.output.sections.find((s) => s.key === 'subjective').text));
  assert.ok(v.issues.some((i) => i.code === 'invented_number'));
  assert.match(v.output.sections.find((s) => s.key === 'assessment_plan').text, /not entered/i);
});

/* ------------------------------------------------------------------ M2d: notes from dictation */

test('M2d: dictation source feeds progress subjective; explicit text wins; other patient source blocked', async () => {
  // Save a dictation-like source (same path the app uses after /transcribe)
  const src = await api('POST', `/patients/${seed.patientId}/sources`, { token: resident, body: {
    kind: 'dictation', title: 'HPI dictation', text: 'Feels better today. Denies chest pain. Cough for 3 days.',
  }});
  assert.equal(src.status, 200);

  const n = await api('POST', `/patients/${seed.patientId}/notes`, { token: resident, body: {
    note_type: 'progress', note_date: '2026-09-11',
    inputs_from_source_ids: [src.json.id],
    plan: 'Continue current care.',
  }});
  assert.equal(n.status, 200);
  const subj = n.json.content.sections.find((s) => s.key === 'subjective');
  assert.match(subj.text, /Denies chest pain/);
  assert.ok(n.json.content.fed_from_sources.some((f) => f.source_id === src.json.id && f.field === 'subjective'));
  assert.equal(n.json.content.unresolved_flags, 0);

  const override = await api('POST', `/patients/${seed.patientId}/notes`, { token: resident, body: {
    note_type: 'progress', note_date: '2026-09-11',
    subjective: 'Clinician typed override — no fever.',
    inputs_from_source_ids: [src.json.id],
    plan: 'Continue current care.',
  }});
  assert.match(override.json.content.sections.find((s) => s.key === 'subjective').text, /Clinician typed override/);
  assert.ok(!/Denies chest pain/.test(override.json.content.sections.find((s) => s.key === 'subjective').text));

  // Create a second patient and ensure cross-patient source ids are rejected
  const otherPt = await api('POST', '/patients', { token: resident, body: { team_id: seed.teamA, display_name: 'Sam Test (fictional)', room: '101' } });
  const foreign = await api('POST', `/patients/${otherPt.json.id}/sources`, { token: resident, body: { kind: 'dictation', text: 'Foreign dictation.' } });
  const blocked = await api('POST', `/patients/${seed.patientId}/notes`, { token: resident, body: {
    note_type: 'progress', inputs_from_source_ids: [foreign.json.id], plan: 'x',
  }});
  assert.equal(blocked.status, 404);
  assert.equal(blocked.json.error.code, 'source_not_found');
});

test('M2d: admit_hp history map + icu update from sources; apply_to selects fields', async () => {
  // Restore full admit_hp (an earlier admin test may have published a slim v2).
  await api('PUT', '/admin/templates/admit_hp', { token: admin, body: {
    title: 'Admission H&P',
    sections: [
      { key: 'chief_complaint', title: 'Chief complaint', source: 'clinician_history' },
      { key: 'hpi', title: 'HPI', source: 'clinician_history' },
      { key: 'pmh', title: 'PMH', source: 'clinician_history' },
      { key: 'medications', title: 'Medications', source: 'clinician_history' },
      { key: 'allergies', title: 'Allergies', source: 'clinician_history' },
      { key: 'family_history', title: 'Family history', source: 'clinician_history' },
      { key: 'social_history', title: 'Social history', source: 'clinician_history' },
      { key: 'ros', title: 'ROS', source: 'clinician_history' },
      { key: 'exam', title: 'Exam', source: 'clinician_exam' },
      { key: 'data', title: 'Data', source: 'facts' },
      { key: 'assessment_plan', title: 'Assessment and Plan', source: 'clinician_plan' },
    ],
  }});

  const hpiSrc = await api('POST', `/patients/${seed.patientId}/sources`, { token: resident, body: {
    kind: 'dictation', text: 'Three days of productive cough. No known drug allergies mentioned here.',
  }});
  const examSrc = await api('POST', `/patients/${seed.patientId}/sources`, { token: resident, body: {
    kind: 'dictation', text: 'Lungs clear bilaterally. Temp 37.0.',
  }});

  const hp = await api('POST', `/patients/${seed.patientId}/notes`, { token: resident, body: {
    note_type: 'admit_hp', note_date: '2026-09-11',
    inputs_from_source_ids: {
      history: { hpi: [hpiSrc.json.id], allergies: [hpiSrc.json.id] },
      exam: [examSrc.json.id],
    },
    plan: 'Supportive care.',
  }});
  assert.equal(hp.status, 200);
  const by = Object.fromEntries(hp.json.content.sections.map((s) => [s.key, s]));
  assert.match(by.hpi.text, /productive cough/);
  assert.match(by.allergies.text, /allergies/i);
  assert.match(by.exam.text, /Lungs clear/);
  assert.equal(by.pmh.text, '[PMH not entered]');
  assert.ok(hp.json.content.fed_from_sources.some((f) => f.field === 'history.hpi'));

  const icuSrc = await api('POST', `/patients/${seed.patientId}/sources`, { token: resident, body: {
    kind: 'dictation', text: 'Weaned to 2 L nasal cannula overnight. Pressors off.',
  }});
  const icu = await api('POST', `/patients/${seed.patientId}/notes`, { token: resident, body: {
    note_type: 'icu', note_date: '2026-09-11',
    inputs_from_source_ids: [icuSrc.json.id],
    apply_to: ['update', 'support'],
    exam: 'Sedated but arousable.',
    plan: 'Continue wean.',
  }});
  assert.equal(icu.status, 200);
  const icuBy = Object.fromEntries(icu.json.content.sections.map((s) => [s.key, s]));
  assert.match(icuBy.interval_events.text, /Weaned to 2 L/);
  assert.match(icuBy.support.text, /Pressors off/);
});

test('M2d: end-to-end /transcribe text saved then used in note inputs_from_source_ids', async () => {
  const tr = await api('POST', '/transcribe', { token: resident, body: {
    kind: 'audio', mime_type: 'audio/wav', file_base64: Buffer.from('note-dictation').toString('base64'),
  }});
  assert.equal(tr.status, 200);
  const saved = await api('POST', `/patients/${seed.patientId}/sources`, { token: resident, body: {
    kind: 'dictation', title: 'From /transcribe', text: tr.json.text,
  }});
  const note = await api('POST', `/patients/${seed.patientId}/notes`, { token: resident, body: {
    note_type: 'progress', note_date: '2026-09-12',
    inputs_from_source_ids: [saved.json.id],
    apply_to: ['subjective'],
    plan: 'Recheck labs.',
  }});
  assert.equal(note.status, 200);
  assert.match(note.json.content.sections.find((s) => s.key === 'subjective').text, /Creatinine|cough|cultures/i);
  assert.equal((await api('POST', `/artifacts/${note.json.artifact_id}/review`, { token: resident })).status, 200);
});

/* ------------------------------------------------------------------ M3a: checklist rule library */

test('M3a: example rules seed as draft; pyelo CVA prompt only after approve; ack works; no urgency', async () => {
  const drafts = (await api('GET', '/admin/check-rules?status=draft', { token: admin })).json;
  assert.ok(drafts.length >= 10);
  assert.ok(drafts.every((r) => r.status === 'draft'));
  const pyelo = drafts.find((r) => /pyelo/i.test(r.name));
  assert.ok(pyelo);
  assert.ok(pyelo.prompts.some((p) => /CVA tenderness/i.test(p.text)));

  // Add confirmed pyelonephritis problem
  const { run, get } = await import('../src/db.js');
  const { uid, nowIso } = await import('../src/util.js');
  const probId = uid();
  run('INSERT INTO problems(id,patient_id,label,state,fact_ids,uncertainty,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    probId, seed.patientId, 'pyelonephritis', 'confirmed', '[]', '', nowIso(), nowIso());

  const before = await api('GET', `/patients/${seed.patientId}/reminders?date=2026-09-12`, { token: resident });
  assert.equal(before.status, 200);
  assert.ok(!before.json.reminders.some((r) => /pyelo/i.test(r.name)));
  assert.equal(before.json.frame, 'Prompt for your consideration');
  assert.ok(!('urgency' in before.json));

  assert.equal((await api('POST', `/admin/check-rules/${pyelo.id}/approve`, { token: resident })).status, 403);
  const approved = await api('POST', `/admin/check-rules/${pyelo.id}/approve`, { token: admin });
  assert.equal(approved.json.status, 'approved');
  assert.ok(approved.json.approved_by);

  const after = await api('GET', `/patients/${seed.patientId}/reminders?date=2026-09-12`, { token: resident });
  const hit = after.json.reminders.find((r) => r.rule_id === pyelo.id);
  assert.ok(hit);
  assert.ok(hit.prompts.some((p) => /CVA tenderness/i.test(p.text)));
  assert.equal(hit.frame, 'Prompt for your consideration');
  assert.equal(hit.not_an_order, true);
  assert.ok(!('urgency' in hit));

  const ack = await api('POST', `/patients/${seed.patientId}/reminders/${pyelo.id}/ack`, {
    token: resident, body: { state: 'checked', date: '2026-09-12', note: 'Done on rounds' },
  });
  assert.equal(ack.status, 200);
  assert.equal(ack.json.state, 'checked');
  const again = (await api('GET', `/patients/${seed.patientId}/reminders?date=2026-09-12`, { token: resident })).json;
  assert.equal(again.reminders.find((r) => r.rule_id === pyelo.id).ack.state, 'checked');
  assert.ok(get("SELECT 1 AS x FROM audit_log WHERE action='reminder_ack'").x);
});

test('M3a: stroke rule compare_json surfaces yesterday neuro facts with sources after approve', async () => {
  const stroke = (await api('GET', '/admin/check-rules?status=draft', { token: admin })).json.find((r) => /stroke/i.test(r.name))
    || (await api('GET', '/admin/check-rules?status=approved', { token: admin })).json.find((r) => /stroke/i.test(r.name));
  assert.ok(stroke);
  if (stroke.status === 'draft') {
    assert.equal((await api('POST', `/admin/check-rules/${stroke.id}/approve`, { token: admin })).status, 200);
  }

  const { run } = await import('../src/db.js');
  const { uid, nowIso } = await import('../src/util.js');
  const probId = uid();
  run('INSERT INTO problems(id,patient_id,label,state,fact_ids,uncertainty,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    probId, seed.patientId, 'ischemic stroke', 'confirmed', '[]', '', nowIso(), nowIso());
  const sid = uid();
  run('INSERT INTO sources(id,patient_id,kind,title,event_time,uploaded_at,text) VALUES(?,?,?,?,?,?,?)',
    sid, seed.patientId, 'note', 'Neuro', '2026-09-11T08:00', nowIso(), 'Right arm weakness, NIHSS motor 2.');
  const fid = uid();
  run(`INSERT INTO facts(id,patient_id,label,value,unit,event_time,source_id,source_passage,assertion,reviewer_status,revision,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,'confirmed',1,?)`,
    fid, seed.patientId, 'Neuro deficit', 'Right arm weakness', '', '2026-09-11T08:00', sid, 'Right arm weakness, NIHSS motor 2.', 'present', nowIso());

  const r = await api('GET', `/patients/${seed.patientId}/reminders?date=2026-09-12`, { token: resident });
  const hit = r.json.reminders.find((x) => x.rule_id === stroke.id);
  assert.ok(hit);
  assert.ok(hit.compare_yesterday);
  assert.ok(hit.compare_yesterday.facts.some((f) => f.fact_id === fid && /weakness/i.test(f.source_passage)));
  assert.ok(!('urgency' in r.json) && r.json.reminders.every((x) => !('urgency' in x)));
});

test('M3a: AI draft helper creates draft AI-drafted rule; invented citations rejected in validator', async () => {
  const d = await api('POST', '/admin/check-rules/draft', { token: admin, body: { condition: 'pyelonephritis' } });
  assert.equal(d.status, 200);
  assert.equal(d.json.rule.status, 'draft');
  assert.equal(d.json.rule.ai_drafted, true);
  assert.match(d.json.rule.name, /AI-DRAFT|Pyelo/i);
  assert.equal((await api('POST', '/admin/check-rules/draft', { token: resident, body: { condition: 'sepsis' } })).status, 403);

  const { validateCheckRuleDraft } = await import('../src/check_rules.js');
  const bad = validateCheckRuleDraft({
    name: 'Bad', match: { problem_keywords: ['x'], icd_prefixes: [] },
    prompts: [{ text: 'See PMID 12345678', kind: 'review' }], compare: null,
  }, 'x');
  assert.equal(bad.output, null);
  assert.ok(bad.issues.some((i) => i.code === 'invented_citation'));
});

/* ------------------------------------------------------------------ M3b: oral presentation */

test('M3b: present_patient cites fact_ids, stays in word budget, includes plan; other team blocked', async () => {
  await api('PUT', `/patients/${seed.patientId}/plan`, { token: resident, body: { plan_date: '2026-09-12', text: 'Continue antibiotics. Recheck creatinine in the morning.' } });
  const r = await api('POST', `/patients/${seed.patientId}/present`, { token: resident, body: { date: '2026-09-12' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.operation, 'present_patient');
  assert.equal(r.json.requires_review, true);
  assert.ok(r.json.content.sentences.length > 0);
  assert.ok(r.json.content.sentences.every((s) => s.fact_ids.length > 0));
  assert.ok(r.json.content.word_count >= 150 && r.json.content.word_count <= 220);
  assert.deepEqual(r.json.content.flags, []);
  assert.match(r.json.content.spoken_text, /\S/);
  assert.ok(r.json.content.plan_sentences.some((p) => /antibiotics|creatinine/i.test(p.text)));
  assert.equal(r.json.content.target_duration, '60-90 seconds');
  assert.ok(!('urgency' in r.json.content));
  assert.equal((await api('POST', `/patients/${seed.patientId}/present`, { token: other, body: {} })).status, 403);
});

test('M3b: validatePresentation drops unsupported sentences and flags over word budget', async () => {
  const { validatePresentation } = await import('../src/ai/validators.js');
  const ctx = {
    facts: [
      { fact_id: 'f1', label: 'Creatinine', value: '2.1', unit: 'mg/dL', event_time: '2026-08-31' },
      { fact_id: 'f2', label: 'SpO2', value: '93', unit: '%', event_time: '2026-08-29' },
    ],
    trends: [], conflicts: [], missing_information: [], selected_date: '2026-09-12',
  };
  const longPad = Array.from({ length: 230 }, () => 'word').join(' ');
  const v = validatePresentation({
    sentences: [
      { text: 'Creatinine is 2.1 mg/dL.', fact_ids: ['f1'] },
      { text: 'Invented fever of 40 C.', fact_ids: ['f1'] },
      { text: 'No citation at all.' },
      { text: 'Unknown fact.', fact_ids: ['nope'] },
      { text: `SpO2 was 93 percent. ${longPad}`, fact_ids: ['f2'] },
    ],
    plan_sentences: [
      { text: 'Continue antibiotics for 14 days.' }, // 14 not in plan
      { text: 'Continue antibiotics.' },
    ],
  }, ctx, { planText: 'Continue antibiotics. Recheck creatinine.' });
  assert.ok(v.output.sentences.every((s) => s.fact_ids.every((id) => id === 'f1' || id === 'f2')));
  assert.ok(!v.output.sentences.some((s) => /Invented fever|No citation|Unknown fact/.test(s.text)));
  assert.ok(v.issues.some((i) => i.code === 'unsupported_number' || i.code === 'unsupported_claim'));
  assert.ok(v.output.flags.some((f) => f.code === 'over_word_budget') || v.issues.some((i) => i.code === 'over_word_budget'));
  assert.ok(v.issues.some((i) => i.code === 'plan_unsupported_number'));
  assert.ok(v.output.plan_sentences.some((p) => p.text === 'Continue antibiotics.'));
});

/* ------------------------------------------------------------------ M3c: day brief */

test('M3c: round brief is deterministic; pyelo CVA only if approved; stroke yesterday compare; no urgency', async () => {
  // 2026-09-12 so stroke compare lookback hits the M3a neuro fact dated 2026-09-11
  const day = '2026-09-12';
  // Ensure pyelo problem exists (may already from M3a)
  const { run, get } = await import('../src/db.js');
  const { uid, nowIso } = await import('../src/util.js');
  if (!get("SELECT 1 AS x FROM problems WHERE patient_id=? AND lower(label) LIKE '%pyelo%'", seed.patientId)) {
    run('INSERT INTO problems(id,patient_id,label,state,fact_ids,uncertainty,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      uid(), seed.patientId, 'pyelonephritis', 'confirmed', '[]', '', nowIso(), nowIso());
  }
  if (!get("SELECT 1 AS x FROM problems WHERE patient_id=? AND lower(label) LIKE '%stroke%'", seed.patientId)) {
    run('INSERT INTO problems(id,patient_id,label,state,fact_ids,uncertainty,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      uid(), seed.patientId, 'ischemic stroke', 'confirmed', '[]', '', nowIso(), nowIso());
  }

  const rules = (await api('GET', '/admin/check-rules', { token: admin })).json;
  const pyelo = rules.find((r) => /pyelo/i.test(r.name));
  const stroke = rules.find((r) => /stroke/i.test(r.name));
  assert.ok(pyelo && stroke);
  // Force pyelo back to draft to prove it does not appear, then approve
  run("UPDATE check_rules SET status='draft', approved_by=NULL, approved_at=NULL WHERE id=?", pyelo.id);
  if (stroke.status === 'draft') await api('POST', `/admin/check-rules/${stroke.id}/approve`, { token: admin });

  let brief = await api('GET', `/round/brief?date=${day}`, { token: resident });
  assert.equal(brief.status, 200);
  assert.equal(brief.json.assembled_in_code, true);
  assert.equal(brief.json.ordering, 'sort_order_then_room');
  assert.ok(!('urgency' in brief.json));
  const card = brief.json.patients.find((p) => p.patient_id === seed.patientId);
  assert.ok(card);
  assert.ok(card.summary_state);
  assert.equal(card.what_changed.computed_in_code, true);
  assert.ok(Array.isArray(card.pending_items));
  assert.ok(Array.isArray(card.tasks));
  assert.ok(Array.isArray(card.missing_information));
  assert.ok(!card.reminders.some((r) => r.rule_id === pyelo.id));
  assert.ok(!('urgency' in card));
  assert.ok(brief.json.patients.every((p) => !('urgency' in p) && !('acuity' in p) && !('risk_score' in p)));

  await api('POST', `/admin/check-rules/${pyelo.id}/approve`, { token: admin });
  brief = await api('GET', `/round/brief?date=${day}`, { token: resident });
  const card2 = brief.json.patients.find((p) => p.patient_id === seed.patientId);
  assert.ok(card2.reminders.some((r) => r.rule_id === pyelo.id && r.prompts.some((p) => /CVA tenderness/i.test(p.text))));
  const strokeRem = card2.reminders.find((r) => r.rule_id === stroke.id);
  assert.ok(strokeRem);
  assert.ok(strokeRem.compare_yesterday);
  assert.ok(card2.yesterday_comparisons.some((y) => y.rule_id === stroke.id && y.compare.facts.some((f) => f.source_passage)));
  assert.ok(typeof brief.json.counts.unreviewed_facts === 'number');
  assert.ok(typeof brief.json.counts.outdated_summaries === 'number');
  assert.equal((await api('GET', `/round/brief?date=${day}`, { token: other })).json.patients.length, 0);
});

test('M3c: prepare returns partial results with explicit failures; never silent skip', async () => {
  const ghost = '00000000-0000-4000-8000-000000000099';
  const prep = await api('POST', '/round/brief/prepare', { token: resident, body: {
    date: '2026-09-13',
    patient_ids: [seed.patientId, ghost],
  }});
  assert.equal(prep.status, 200);
  assert.equal(prep.json.requested, 2);
  assert.ok(prep.json.results.length === 2);
  const ok = prep.json.results.find((r) => r.patient_id === seed.patientId);
  const bad = prep.json.results.find((r) => r.patient_id === ghost);
  assert.equal(ok.ok, true);
  assert.ok(ok.artifact_id);
  assert.equal(ok.requires_review, true);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'not_found');
  assert.equal(prep.json.failed, 1);
  assert.equal(prep.json.generated, 1);
});

/* ------------------------------------------------------------------ M4: teaching mode */

test('M4: teaching plan from census topics; bank-first questions; unapproved not in bank', async () => {
  const probs = (await api('GET', `/patients/${seed.patientId}/problems`, { token: resident })).json;
  let pneu = probs.find((p) => /pneumonia/i.test(p.label) && p.state !== 'rejected');
  if (!pneu) {
    await api('POST', `/patients/${seed.patientId}/problems/suggest`, { token: resident, body: {} });
    pneu = (await api('GET', `/patients/${seed.patientId}/problems`, { token: resident })).json
      .find((p) => /pneumonia|kidney|aki/i.test(p.label) && p.state !== 'rejected');
  }
  assert.ok(pneu);
  await api('POST', `/patients/${seed.patientId}/problems/${pneu.id}/decision`, { token: resident, body: { action: 'accept' } });

  const plan = await api('GET', '/teaching/plan', { token: resident });
  assert.equal(plan.status, 200);
  assert.ok(plan.json.topics.length >= 1);
  assert.ok(plan.json.topics.every((t) => t.topic_key && t.count >= 1));
  assert.match(plan.json.note, /No patient identifiers/i);

  const topic = plan.json.topics[0].topic;
  const gen = await api('POST', '/learning/generate', { token: resident, body: { topic, count: 1 } });
  assert.equal(gen.status, 200);
  const unreviewedId = gen.json.mcq_ids[0];

  const bankEmpty = await api('GET', `/teaching/questions?topic=${encodeURIComponent(topic)}&count=2`, { token: resident });
  assert.equal(bankEmpty.status, 200);
  assert.equal(bankEmpty.json.bank_served, 0);
  assert.ok(!bankEmpty.json.questions.some((q) => q.mcq_id === unreviewedId));

  const approved = await api('PATCH', `/admin/mcqs/${unreviewedId}`, { token: admin, body: { status: 'approved' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.status, 'approved');
  assert.ok(approved.json.approved_by);

  const gen2 = await api('POST', '/learning/generate', { token: resident, body: { topic, count: 1 } });
  const stillUnreviewed = gen2.json.mcq_ids[0];

  const bank = await api('GET', `/teaching/questions?topic=${encodeURIComponent(topic)}&count=3`, { token: resident });
  assert.equal(bank.status, 200);
  assert.ok(bank.json.bank_served >= 1);
  assert.ok(bank.json.questions.every((q) => q.status === 'approved' && q.bank === true));
  assert.ok(!bank.json.questions.some((q) => q.mcq_id === stillUnreviewed));

  const withGen = await api('GET', `/teaching/questions?topic=${encodeURIComponent(topic)}&count=5&allow_generate=true`, { token: resident });
  assert.equal(withGen.status, 200);
  if (withGen.json.generated > 0) {
    const draft = withGen.json.questions.find((q) => q.bank === false);
    assert.ok(draft);
    assert.equal(draft.status, 'ai_generated_unreviewed');
    assert.match(draft.learner_label, /unreviewed/i);
  }

  const queue = await api('GET', '/admin/mcqs', { token: admin });
  assert.equal(queue.status, 200);
  assert.ok(queue.json.some((m) => m.status === 'ai_generated_unreviewed'));
  assert.equal((await api('GET', '/admin/mcqs', { token: resident })).status, 403);

  const detail = await api('GET', `/admin/mcqs/${stillUnreviewed}`, { token: admin });
  assert.equal(detail.status, 200);
  assert.ok(detail.json.content?.question || detail.json.content?.vignette);
  assert.ok(detail.json.content?.options);
  assert.ok(detail.json.content?.answer);
  assert.equal((await api('GET', `/admin/mcqs/${stillUnreviewed}`, { token: resident })).status, 403);
});

test('M4: curated high-yield vs retrieved labeling; guideline updates for census', async () => {
  const topic = 'community acquired pneumonia';
  const draft = await api('POST', '/admin/curated-reads', { token: admin, body: {
    topic, title: 'Landmark CAP trial (admin curated)', citation: 'NEJM fictional', pmid: '9990001',
    why_it_matters: 'Core teaching article for CAP',
  }});
  assert.equal(draft.status, 200);
  assert.equal(draft.json.approved, 0);
  const appr = await api('POST', `/admin/curated-reads/${draft.json.id}/approve`, { token: admin });
  assert.equal(appr.json.approved, 1);

  const reads = await api('GET', `/teaching/reads?topic=${encodeURIComponent(topic)}`, { token: resident });
  assert.equal(reads.status, 200);
  assert.ok(reads.json.curated_high_yield.some((c) => c.high_yield === true && c.curated === true));
  for (const r of [...reads.json.recent, ...reads.json.older_high_design, ...reads.json.guidelines_pubmed]) {
    assert.equal(r.high_yield, false);
    assert.equal(r.curated, false);
  }
  assert.ok(reads.json.guidelines_pubmed.some((g) => g.label === 'Guideline' || g.pmid));

  const censusTopic = (await api('GET', '/teaching/plan', { token: resident })).json.topics[0]?.topic || topic;
  const gu = await api('POST', '/admin/guideline-updates', { token: admin, body: {
    topic: censusTopic, organization: 'IDSA', title: 'Updated guidance (admin)', published_date: '2025-01-15',
    url: 'https://example.org/cap', summary_by_admin: 'Shorter course discussed — verify source.',
  }});
  assert.equal(gu.status, 200);
  assert.equal(gu.json.status, 'draft');
  await api('POST', `/admin/guideline-updates/${gu.json.id}/approve`, { token: admin });

  const feed = await api('GET', '/teaching/guideline-updates', { token: resident });
  assert.equal(feed.status, 200);
  assert.ok(feed.json.updates.some((u) => u.id === gu.json.id));
  assert.match(feed.json.updates.find((u) => u.id === gu.json.id).verify, /Verify against the source/i);

  const reported = await api('POST', '/learning/generate', { token: resident, body: { topic: 'acute kidney injury', count: 1 } });
  const rid = reported.json.mcq_ids[0];
  await api('POST', `/mcq/${rid}/report`, { token: resident, body: { note: 'wrong key' } });
  const blocked = await api('GET', `/mcq/${rid}`, { token: resident });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'not_approved');
});

/* ------------------------------------------------------------------ M5: team chat */

test('M5: team isolation, patient channel membership, unread counts', async () => {
  const channels = await api('GET', '/channels', { token: resident });
  assert.equal(channels.status, 200);
  assert.ok(channels.json.some((c) => c.type === 'team' && c.name === 'general'));
  const patientCh = channels.json.find((c) => c.type === 'patient' && c.patient_id === seed.patientId);
  assert.ok(patientCh);

  const otherList = await api('GET', '/channels', { token: other });
  assert.ok(!otherList.json.some((c) => c.patient_id === seed.patientId));
  assert.equal((await api('GET', `/channels/${patientCh.id}/messages`, { token: other })).status, 403);
  assert.equal((await api('POST', `/channels/${patientCh.id}/messages`, { token: other, body: { body: 'cross-team' } })).status, 403);

  const viaPatient = await api('GET', `/patients/${seed.patientId}/channel`, { token: resident });
  assert.equal(viaPatient.status, 200);
  assert.equal(viaPatient.json.id, patientCh.id);

  const post = await api('POST', `/channels/${patientCh.id}/messages`, {
    token: admin, body: { body: 'Labs pending — please follow up @Demo' },
  });
  assert.equal(post.status, 200);
  assert.ok(post.json.seq >= 1);
  assert.equal(post.json.body.includes('Labs'), true);

  const unread = await api('GET', '/channels/unread', { token: resident });
  assert.equal(unread.status, 200);
  assert.ok(unread.json.total_unread >= 1);
  assert.ok(unread.json.channels.some((c) => c.id === patientCh.id && c.unread >= 1));

  const marked = await api('POST', `/channels/${patientCh.id}/read`, {
    token: resident, body: { last_read_seq: post.json.seq },
  });
  assert.equal(marked.json.unread, 0);

  const thread = await api('POST', `/channels/${patientCh.id}/messages`, {
    token: resident, body: { body: 'Will check creatinine.', parent_id: post.json.id },
  });
  assert.equal(thread.status, 200);
  assert.equal(thread.json.parent_id, post.json.id);

  const search = await api('GET', `/channels/search?q=${encodeURIComponent('creatinine')}`, { token: resident });
  assert.ok(search.json.messages.some((m) => m.id === thread.json.id));
  assert.equal((await api('GET', `/channels/search?q=creatinine`, { token: other })).json.messages.length, 0);

  const sum = await api('POST', `/channels/${patientCh.id}/summarize`, { token: resident });
  assert.equal(sum.status, 200);
  assert.equal(sum.json.operation, 'summarize_chat_thread');
  assert.equal(sum.json.requires_review, true);
  assert.ok(sum.json.content.bullets?.length >= 1);

  await api('DELETE', `/messages/${thread.json.id}`, { token: resident });
  const afterDel = await api('GET', `/channels/${patientCh.id}/messages`, { token: resident });
  const deleted = afterDel.json.messages.find((m) => m.id === thread.json.id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.body, '');
});

test('M5: SSE scoped to membership; chat disable and retention settings', async () => {
  const channels = (await api('GET', '/channels', { token: resident })).json;
  const general = channels.find((c) => c.type === 'team');
  assert.ok(general);

  const ctrl = new AbortController();
  const res = await fetch(`${base}/stream`, {
    headers: { Authorization: `Bearer ${resident}` },
    signal: ctrl.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const waitChunk = async () => {
    const { value, done } = await reader.read();
    if (done) return buf;
    buf += decoder.decode(value, { stream: true });
    return buf;
  };
  await waitChunk(); // : ok

  const msg = await api('POST', `/channels/${general.id}/messages`, {
    token: admin, body: { body: 'Morning huddle at 7.' },
  });
  assert.equal(msg.status, 200);

  let saw = false;
  for (let i = 0; i < 20; i++) {
    await waitChunk();
    if (buf.includes(msg.json.id) || buf.includes(`"seq":${msg.json.seq}`)) { saw = true; break; }
  }
  ctrl.abort();
  try { await reader.cancel(); } catch { /* ignore */ }
  assert.ok(saw, 'SSE subscriber should receive message event for their channel');

  // Other team cannot open patient stream content via post (already covered); disable chat
  const off = await api('PUT', '/admin/settings', { token: admin, body: { chat_enabled: false } });
  assert.equal(off.json.chat_enabled, false);
  assert.equal((await api('GET', '/channels', { token: resident })).status, 503);
  await api('PUT', '/admin/settings', { token: admin, body: { chat_enabled: true, chat_retention_days: 90 } });
  assert.equal((await api('GET', '/channels', { token: resident })).status, 200);

  const expMissing = await api('GET', `/admin/chat/export?team_id=${seed.teamA}`, { token: admin });
  assert.equal(expMissing.status, 400);
  assert.equal(expMissing.json.error.code, 'reason_required');

  const exp = await api('GET', `/admin/chat/export?team_id=${seed.teamA}&reason=${encodeURIComponent('Litigation hold sample export')}`, { token: admin });
  assert.equal(exp.status, 200);
  assert.ok(exp.json.channels.length >= 1);
  assert.ok(exp.json.export_id);
  assert.match(exp.json.notice, /does not claim HIPAA/i);
  assert.equal((await api('GET', `/admin/chat/export?team_id=${seed.teamA}&reason=x`, { token: resident })).status, 403);
});

test('C0: chat admin purge preview, hold reason/history, export history, metrics', async () => {
  const settings = await api('GET', '/admin/settings', { token: admin });
  assert.equal(settings.status, 200);
  assert.equal(settings.json.chat_limits.max_message_body, 4000);
  assert.equal(settings.json.chat_limits.rate_per_minute, 30);
  assert.ok(typeof settings.json.push.registered_devices === 'number');
  assert.ok(!('token' in (settings.json.push || {})));

  const preview = await api('GET', '/admin/chat/purge/preview', { token: admin });
  assert.equal(preview.status, 200);
  assert.ok(typeof preview.json.eligible_count === 'number');
  assert.equal(preview.json.blocked, false);
  assert.ok(!('body' in preview.json));
  assert.ok(!('messages' in preview.json));

  const previewDays = await api('GET', '/admin/chat/purge/preview?days=30', { token: admin });
  assert.equal(previewDays.status, 200);
  assert.equal(previewDays.json.retention_days, 30);
  assert.equal(previewDays.json.configured_retention_days, 90);

  const holdNoReason = await api('PUT', '/admin/settings', {
    token: admin,
    body: { chat_legal_hold: true },
  });
  assert.equal(holdNoReason.status, 400);
  assert.equal(holdNoReason.json.error.code, 'reason_required');

  const holdOn = await api('PUT', '/admin/settings', {
    token: admin,
    body: { chat_legal_hold: true, chat_legal_hold_reason: 'Subpoena SAMPLE-CASE-001' },
  });
  assert.equal(holdOn.status, 200);
  assert.equal(holdOn.json.chat_legal_hold, true);

  const blockedPreview = await api('GET', '/admin/chat/purge/preview', { token: admin });
  assert.equal(blockedPreview.json.blocked, true);
  assert.equal(blockedPreview.json.blocked_reason, 'legal_hold');

  const purge = await api('POST', '/admin/chat/purge', { token: admin });
  assert.equal(purge.status, 200);
  assert.equal(purge.json.skipped, true);
  assert.equal(purge.json.reason, 'legal_hold');
  assert.equal(purge.json.purged, 0);

  const holdHist = await api('GET', '/admin/chat/hold/history', { token: admin });
  assert.equal(holdHist.status, 200);
  assert.ok(holdHist.json.rows.length >= 1);
  assert.equal(holdHist.json.rows[0].hold, true);
  assert.match(holdHist.json.rows[0].reason, /Subpoena SAMPLE-CASE-001/);
  assert.ok(!JSON.stringify(holdHist.json).includes('Morning huddle'));

  await api('PUT', '/admin/settings', {
    token: admin,
    body: { chat_legal_hold: false, chat_legal_hold_reason: 'Hold cleared after SAMPLE review' },
  });

  const expPost = await api('POST', '/admin/chat/export', {
    token: admin,
    body: { team_id: seed.teamA, reason: 'Quarterly compliance SAMPLE export' },
  });
  assert.equal(expPost.status, 200);
  assert.ok(expPost.json.export_id);
  assert.ok(typeof expPost.json.message_count === 'number');

  const expHist = await api('GET', '/admin/chat/export/history', { token: admin });
  assert.equal(expHist.status, 200);
  assert.ok(expHist.json.rows.length >= 1);
  const histRow = expHist.json.rows[0];
  assert.ok(histRow.reason);
  assert.ok(typeof histRow.message_count === 'number');
  assert.ok(!('channels' in histRow));
  assert.ok(!('body' in histRow));
  assert.ok(!JSON.stringify(expHist.json).includes('"body"'));

  const metrics = await api('GET', '/admin/chat/metrics?from=2020-01-01&to=2099-12-31', { token: admin });
  assert.equal(metrics.status, 200);
  assert.ok(metrics.json.totals);
  assert.ok(typeof metrics.json.totals.messages_posted === 'number');
  assert.ok(Array.isArray(metrics.json.days));
  const blob = JSON.stringify(metrics.json);
  assert.ok(!blob.includes('Morning huddle'));
  assert.ok(!/"body"\s*:/.test(blob));

  assert.equal((await api('GET', '/admin/chat/metrics', { token: resident })).status, 403);
  assert.equal((await api('GET', '/admin/chat/purge/preview', { token: resident })).status, 403);
});
