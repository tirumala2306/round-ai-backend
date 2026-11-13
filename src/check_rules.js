import { all, get, run, audit } from './db.js';
import { HttpError, uid, nowIso, today, need, str, jsonParse } from './util.js';

const PROMPT_KINDS = new Set(['exam', 'review', 'lab', 'imaging', 'med']);
const RULE_STATUSES = new Set(['draft', 'approved', 'retired']);
const ACK_STATES = new Set(['checked', 'not_applicable', 'snoozed']);

export const FRAME = 'Prompt for your consideration';

/** Example library — seeded as draft so a physician must approve before use. */
export const EXAMPLE_RULES = [
  {
    name: 'Pyelonephritis — CVA tenderness',
    match: { problem_keywords: ['pyelonephritis', 'pyelo'], icd_prefixes: ['N10'] },
    prompts: [{ text: 'Check CVA tenderness', kind: 'exam' }],
    compare: null,
  },
  {
    name: 'Stroke — neuro deficits vs yesterday',
    match: { problem_keywords: ['stroke', 'cva', 'cerebral infarction', 'hemiparesis'], icd_prefixes: ['I63', 'I61', 'I64'] },
    prompts: [{ text: 'Re-examine neurological deficits and compare with yesterday', kind: 'exam' }],
    compare: { fact_label_keywords: ['neuro', 'nihss', 'motor', 'speech', 'weakness', 'deficit'], lookback_days: 1 },
  },
  {
    name: 'Pneumonia — oxygen and cultures',
    match: { problem_keywords: ['pneumonia', 'cap', 'hap'], icd_prefixes: ['J12', 'J13', 'J14', 'J15', 'J16', 'J17', 'J18'] },
    prompts: [
      { text: 'Review oxygen requirement trend', kind: 'review' },
      { text: 'Check culture results if pending', kind: 'lab' },
    ],
    compare: { fact_label_keywords: ['spo2', 'oxygen', 'o2'], lookback_days: 1 },
  },
  {
    name: 'CHF — volume exam',
    match: { problem_keywords: ['heart failure', 'chf', 'volume overload'], icd_prefixes: ['I50'] },
    prompts: [
      { text: 'Assess JVP, edema, and lung exam for volume status', kind: 'exam' },
      { text: 'Review daily weights / net I&O if documented', kind: 'review' },
    ],
    compare: null,
  },
  {
    name: 'AKI — urine output and nephrotoxins',
    match: { problem_keywords: ['aki', 'acute kidney', 'acute renal'], icd_prefixes: ['N17'] },
    prompts: [
      { text: 'Review urine output and latest creatinine', kind: 'lab' },
      { text: 'Hold or review nephrotoxic medications', kind: 'med' },
    ],
    compare: { fact_label_keywords: ['creatinine', 'urine'], lookback_days: 1 },
  },
  {
    name: 'DKA — anion gap and insulin',
    match: { problem_keywords: ['dka', 'diabetic ketoacidosis'], icd_prefixes: ['E11.1', 'E10.1'] },
    prompts: [
      { text: 'Recheck anion gap / bicarb trajectory', kind: 'lab' },
      { text: 'Confirm insulin and potassium plan', kind: 'med' },
    ],
    compare: null,
  },
  {
    name: 'Sepsis — source and antibiotics',
    match: { problem_keywords: ['sepsis', 'septic'], icd_prefixes: ['A41'] },
    prompts: [
      { text: 'Reassess possible infection source', kind: 'review' },
      { text: 'Confirm antibiotic timing and coverage', kind: 'med' },
    ],
    compare: null,
  },
  {
    name: 'GI bleed — hemodynamics and Hb',
    match: { problem_keywords: ['gi bleed', 'gastrointestinal bleed', 'melena', 'hematemesis'], icd_prefixes: ['K92.0', 'K92.1', 'K92.2'] },
    prompts: [
      { text: 'Recheck hemoglobin / hemodynamics', kind: 'lab' },
      { text: 'Confirm PPI / hold anticoagulation plan with team', kind: 'med' },
    ],
    compare: { fact_label_keywords: ['hemoglobin', 'hgb', 'hb'], lookback_days: 1 },
  },
  {
    name: 'PE — oxygenation and anticoagulation',
    match: { problem_keywords: ['pulmonary embolism', 'pe '], icd_prefixes: ['I26'] },
    prompts: [
      { text: 'Review oxygenation and RV strain signs if relevant', kind: 'review' },
      { text: 'Confirm anticoagulation status', kind: 'med' },
    ],
    compare: null,
  },
  {
    name: 'Cellulitis — margins and antibiotics',
    match: { problem_keywords: ['cellulitis'], icd_prefixes: ['L03'] },
    prompts: [
      { text: 'Mark and reassess skin margins / systemic signs', kind: 'exam' },
      { text: 'Confirm antibiotic choice and duration plan', kind: 'med' },
    ],
    compare: null,
  },
];

function cleanMatch(m) {
  const o = m && typeof m === 'object' ? m : {};
  return {
    problem_keywords: (Array.isArray(o.problem_keywords) ? o.problem_keywords : []).map((x) => str(x, 80).toLowerCase()).filter(Boolean).slice(0, 30),
    icd_prefixes: (Array.isArray(o.icd_prefixes) ? o.icd_prefixes : []).map((x) => str(x, 16).toUpperCase()).filter(Boolean).slice(0, 30),
  };
}

function cleanPrompts(arr) {
  return (Array.isArray(arr) ? arr : []).map((p) => ({
    text: str(p?.text, 300),
    kind: PROMPT_KINDS.has(p?.kind) ? p.kind : 'review',
  })).filter((p) => p.text).slice(0, 20);
}

function cleanCompare(c) {
  if (!c || typeof c !== 'object') return null;
  const fact_label_keywords = (Array.isArray(c.fact_label_keywords) ? c.fact_label_keywords : [])
    .map((x) => str(x, 80).toLowerCase()).filter(Boolean).slice(0, 20);
  const lookback_days = Math.min(Math.max(Number(c.lookback_days) || 1, 1), 7);
  if (!fact_label_keywords.length) return null;
  return { fact_label_keywords, lookback_days };
}

export function mapRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    status: row.status,
    match: jsonParse(row.match_json, { problem_keywords: [], icd_prefixes: [] }),
    prompts: jsonParse(row.prompts_json, []),
    compare: jsonParse(row.compare_json, null),
    created_by: row.created_by,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    ai_drafted: !!row.ai_drafted,
    created_at: row.created_at,
    updated_at: row.updated_at,
    frame: FRAME,
  };
}

export function seedExampleCheckRules(createdBy = null) {
  if (get('SELECT 1 AS x FROM check_rules LIMIT 1')) return false;
  const now = nowIso();
  for (const ex of EXAMPLE_RULES) {
    run(
      `INSERT INTO check_rules(id,name,version,status,match_json,prompts_json,compare_json,created_by,ai_drafted,created_at,updated_at)
       VALUES(?,?,1,'draft',?,?,?,?,0,?,?)`,
      uid(), `[EXAMPLE — review before approve] ${ex.name}`,
      JSON.stringify(cleanMatch(ex.match)),
      JSON.stringify(cleanPrompts(ex.prompts)),
      ex.compare ? JSON.stringify(cleanCompare(ex.compare)) : null,
      createdBy, now, now,
    );
  }
  return true;
}

export function listCheckRules({ status } = {}) {
  const rows = status
    ? all('SELECT * FROM check_rules WHERE status=? ORDER BY name, version DESC', status)
    : all('SELECT * FROM check_rules ORDER BY name, version DESC');
  return rows.map(mapRule);
}

export function getCheckRule(id) {
  return mapRule(get('SELECT * FROM check_rules WHERE id=?', id));
}

export function createCheckRule({ user, body, aiDrafted = false }) {
  const name = str(body.name, 200);
  need(name, 400, 'name_required', 'name is required');
  const match = cleanMatch(body.match || body.match_json);
  const prompts = cleanPrompts(body.prompts || body.prompts_json);
  need(prompts.length, 400, 'prompts_required', 'At least one prompt is required');
  need(match.problem_keywords.length || match.icd_prefixes.length, 400, 'match_required', 'match needs problem_keywords and/or icd_prefixes');
  const compare = cleanCompare(body.compare || body.compare_json);
  const id = uid();
  const now = nowIso();
  run(
    `INSERT INTO check_rules(id,name,version,status,match_json,prompts_json,compare_json,created_by,ai_drafted,created_at,updated_at)
     VALUES(?,?,1,'draft',?,?,?,?,?,?,?)`,
    id, name, JSON.stringify(match), JSON.stringify(prompts), compare ? JSON.stringify(compare) : null,
    user.id, aiDrafted ? 1 : 0, now, now,
  );
  audit(user.id, 'check_rule_create', { detail: { rule_id: id, ai_drafted: !!aiDrafted } });
  return getCheckRule(id);
}

export function updateCheckRule({ user, id, body }) {
  const row = get('SELECT * FROM check_rules WHERE id=?', id);
  need(row, 404, 'not_found', 'Check rule not found');
  need(row.status !== 'retired', 409, 'retired', 'Retired rules cannot be edited; create a new version');
  const name = body.name !== undefined ? str(body.name, 200) : row.name;
  need(name, 400, 'name_required', 'name is required');
  const match = body.match !== undefined || body.match_json !== undefined
    ? cleanMatch(body.match || body.match_json)
    : jsonParse(row.match_json, {});
  const prompts = body.prompts !== undefined || body.prompts_json !== undefined
    ? cleanPrompts(body.prompts || body.prompts_json)
    : jsonParse(row.prompts_json, []);
  need(prompts.length, 400, 'prompts_required', 'At least one prompt is required');
  const compare = body.compare !== undefined || body.compare_json !== undefined
    ? cleanCompare(body.compare || body.compare_json)
    : jsonParse(row.compare_json, null);
  // Editing an approved rule returns it to draft for re-approval.
  const status = row.status === 'approved' ? 'draft' : row.status;
  run(
    `UPDATE check_rules SET name=?, match_json=?, prompts_json=?, compare_json=?, status=?,
     approved_by=NULL, approved_at=NULL, updated_at=? WHERE id=?`,
    name, JSON.stringify(match), JSON.stringify(prompts), compare ? JSON.stringify(compare) : null,
    status, nowIso(), id,
  );
  audit(user.id, 'check_rule_update', { detail: { rule_id: id, status } });
  return getCheckRule(id);
}

export function approveCheckRule({ user, id }) {
  const row = get('SELECT * FROM check_rules WHERE id=?', id);
  need(row, 404, 'not_found', 'Check rule not found');
  need(row.status === 'draft', 409, 'not_draft', 'Only draft rules can be approved');
  const now = nowIso();
  run('UPDATE check_rules SET status=?, approved_by=?, approved_at=?, updated_at=? WHERE id=?',
    'approved', user.id, now, now, id);
  audit(user.id, 'check_rule_approve', { detail: { rule_id: id } });
  return getCheckRule(id);
}

export function retireCheckRule({ user, id }) {
  const row = get('SELECT * FROM check_rules WHERE id=?', id);
  need(row, 404, 'not_found', 'Check rule not found');
  run("UPDATE check_rules SET status='retired', updated_at=? WHERE id=?", nowIso(), id);
  audit(user.id, 'check_rule_retire', { detail: { rule_id: id } });
  return getCheckRule(id);
}

function patientMatchCorpus(patientId) {
  const problems = all("SELECT id,label,state,uncertainty,code_suggestion FROM problems WHERE patient_id=? AND state IN ('confirmed','differential')", patientId);
  const labels = [];
  const codes = [];
  for (const p of problems) {
    labels.push({ problem_id: p.id, label: p.label, state: p.state });
    const sug = jsonParse(p.code_suggestion, null);
    if (sug?.code) codes.push(String(sug.code).toUpperCase());
  }
  return { problems: labels, codes };
}

function ruleMatches(rule, corpus) {
  const match = rule.match || {};
  const kws = match.problem_keywords || [];
  const prefixes = match.icd_prefixes || [];
  const hitProblems = [];
  for (const p of corpus.problems) {
    const lab = p.label.toLowerCase();
    if (kws.some((k) => lab.includes(k))) hitProblems.push(p);
  }
  const hitCodes = [];
  for (const code of corpus.codes) {
    if (prefixes.some((pre) => code.startsWith(pre))) hitCodes.push(code);
  }
  return { matched: hitProblems.length > 0 || hitCodes.length > 0, hitProblems, hitCodes };
}

function dayOffsetIso(day, offsetDays) {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

function compareBlock(patientId, compare, day) {
  if (!compare?.fact_label_keywords?.length) return null;
  const lookback = compare.lookback_days || 1;
  const from = dayOffsetIso(day, lookback);
  const to = dayOffsetIso(day, 1); // "yesterday" relative to selected day (inclusive window ending day-1)
  const facts = all(
    `SELECT id, label, value, unit, event_time, source_id, source_passage, assertion
     FROM facts WHERE patient_id=? AND reviewer_status='confirmed'
       AND event_time IS NOT NULL AND substr(event_time,1,10) >= ? AND substr(event_time,1,10) <= ?
     ORDER BY event_time`,
    patientId, from, to,
  );
  const kws = compare.fact_label_keywords;
  const hits = facts.filter((f) => {
    const blob = `${f.label} ${f.value}`.toLowerCase();
    return kws.some((k) => blob.includes(k));
  }).map((f) => ({
    fact_id: f.id,
    label: f.label,
    value: f.value,
    unit: f.unit || '',
    event_time: f.event_time,
    assertion: f.assertion,
    source_passage: f.source_passage,
    source_id: f.source_id,
  }));
  return {
    lookback_days: lookback,
    window: { from, to },
    fact_label_keywords: kws,
    facts: hits,
    message: hits.length
      ? `Documented in the prior ${lookback} day(s) for comparison today.`
      : `No confirmed facts matching these labels in the prior ${lookback} day(s).`,
  };
}

/**
 * Deterministic reminders for a patient/day. Only approved rules. Never assigns urgency.
 */
export function matchedReminders({ patient, day = today(), userId = null }) {
  const d = day || today();
  const corpus = patientMatchCorpus(patient.id);
  const rules = listCheckRules({ status: 'approved' });
  const out = [];
  for (const rule of rules) {
    const { matched, hitProblems, hitCodes } = ruleMatches(rule, corpus);
    if (!matched) continue;
    const ack = userId
      ? get('SELECT state, note, created_at FROM reminder_acks WHERE patient_id=? AND rule_id=? AND day=? AND user_id=?',
        patient.id, rule.id, d, userId)
      : get('SELECT state, note, created_at FROM reminder_acks WHERE patient_id=? AND rule_id=? AND day=? ORDER BY created_at DESC LIMIT 1',
        patient.id, rule.id, d);
    out.push({
      rule_id: rule.id,
      name: rule.name,
      version: rule.version,
      frame: FRAME,
      framing: FRAME, // alias
      prompts: rule.prompts.map((p) => ({ ...p, frame: FRAME })),
      matched_problems: hitProblems,
      matched_icd_codes: hitCodes,
      compare_yesterday: compareBlock(patient.id, rule.compare, d),
      ack: ack ? { state: ack.state, note: ack.note || null, at: ack.created_at } : null,
      // Explicitly never an order or finding:
      not_an_order: true,
      not_a_finding: true,
    });
  }
  return {
    date: d,
    frame: FRAME,
    reminders: out,
    note: 'Prompts for your consideration from the approved rule library. Not orders or clinical findings. AI does not assign urgency.',
  };
}

export function ackReminder({ user, patient, ruleId, body, day = today() }) {
  const rule = get("SELECT * FROM check_rules WHERE id=? AND status='approved'", ruleId);
  need(rule, 404, 'not_found', 'Approved check rule not found');
  const state = str(body.state, 40);
  need(ACK_STATES.has(state), 400, 'bad_state', 'state must be checked, not_applicable, or snoozed');
  const note = body.note !== undefined ? str(body.note, 500) : null;
  const d = str(day, 10) || today();
  const id = uid();
  const now = nowIso();
  run(
    `INSERT INTO reminder_acks(id,patient_id,rule_id,day,user_id,state,note,created_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(patient_id, rule_id, day, user_id) DO UPDATE SET state=excluded.state, note=excluded.note, created_at=excluded.created_at, id=excluded.id`,
    id, patient.id, ruleId, d, user.id, state, note, now,
  );
  audit(user.id, 'reminder_ack', { patient_id: patient.id, detail: { rule_id: ruleId, day: d, state } });
  return { patient_id: patient.id, rule_id: ruleId, day: d, state, note, frame: FRAME };
}

/** Validate model-drafted rule payload (no invented citations; draft only). */
export function validateCheckRuleDraft(raw, condition) {
  const issues = [];
  const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 200) : `AI draft: ${condition}`.slice(0, 200);
  const match = cleanMatch(raw?.match);
  const prompts = cleanPrompts(raw?.prompts);
  const compare = cleanCompare(raw?.compare);
  if (!match.problem_keywords.length && !match.icd_prefixes.length) issues.push({ code: 'match_empty' });
  if (!prompts.length) issues.push({ code: 'prompts_empty' });
  // Reject fake citations / PMIDs invented by the model
  const blob = JSON.stringify(raw || {});
  if (/\bpmid\b|\bdoi:\s*10\./i.test(blob)) issues.push({ code: 'invented_citation' });
  return {
    output: issues.length ? null : {
      name: name.startsWith('[AI-DRAFT]') ? name : `[AI-DRAFT] ${name}`,
      match, prompts, compare,
      ai_drafted: true,
      status: 'draft',
      label: 'AI-drafted candidate. Physician must edit and approve before use. No citations were verified.',
    },
    issues,
  };
}
