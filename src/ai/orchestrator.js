import { config } from '../config.js';
import { all, get, run, tx, audit, getSetting } from '../db.js';
import { HttpError, uid, nowIso, today, jsonParse, str, need, isIsoDate } from '../util.js';
import { buildContext, bumpRevision, changesSince } from '../context.js';
import { getActiveTemplate } from '../templates.js';
import { generate, transcribe, extractFromImage, AdapterError, providerName } from './adapter.js';
import { promptVersion } from './prompts.js';
import * as V from './validators.js';
import { searchEvidence, assertQuerySafe, publicCard, EvidenceError } from '../evidence/pubmed.js';
import { saveMcq } from '../learning.js';
import { deleteRaw } from '../upload.js';
import { searchIcdCandidates, seedDemoIcdIfEmpty } from '../icd.js';
import { ensurePatientChannel, authorizeChannel, threadMessagesForAi, assertChatEnabled } from '../chat.js';

/* ------------------------------------------------------------------ gating & usage */

function gate(user) {
  if (!getSetting('ai_enabled', true)) {
    throw new HttpError(503, 'ai_disabled', 'AI features are temporarily disabled. Manual entry and chart review still work.');
  }
  const row = get('SELECT calls FROM ai_usage WHERE user_id=? AND day=?', user.id, today());
  if ((row?.calls || 0) >= config.limits.maxCallsPerUserPerDay) {
    throw new HttpError(429, 'daily_limit', 'Daily AI usage limit reached.');
  }
}

function recordUsage(userId, usage) {
  run(`INSERT INTO ai_usage(user_id,day,calls,input_tokens,output_tokens) VALUES(?,?,1,?,?)
       ON CONFLICT(user_id,day) DO UPDATE SET calls=calls+1, input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens`,
    userId, today(), usage.input_tokens || 0, usage.output_tokens || 0);
}

async function callModel(user, operation, payload) {
  gate(user);
  const t0 = Date.now();
  let res;
  try {
    res = await generate({ operation, payload });
  } catch (e) {
    if (e instanceof AdapterError) {
      audit(user.id, 'ai_failed', { detail: { operation, status: e.status ?? null } });
      throw new HttpError(502, 'ai_unavailable', 'AI generation failed. Your data is unchanged. Retry, or continue manually.');
    }
    throw e;
  }
  recordUsage(user.id, res.usage);
  return { ...res, ms: Date.now() - t0 };
}

function checked(fn) {
  try { return fn(); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'ai_invalid_output', 'The AI returned output that could not be validated. Nothing was saved.');
  }
}

/* ------------------------------------------------------------------ artifacts */

export function toEnvelope(row) {
  return {
    artifact_id: row.id, operation: row.operation, patient_id: row.patient_id, context_revision: row.context_revision,
    status: row.status, review_state: row.review_state, outdated: !!row.outdated, requires_review: !!row.requires_review,
    provider: row.provider, model: row.model, prompt_version: row.prompt_version, template_version: row.template_version,
    usage: jsonParse(row.usage, {}), generation_ms: row.generation_ms, created_at: row.created_at, updated_at: row.updated_at,
    reviewed_at: row.reviewed_at, content: jsonParse(row.content, {}),
  };
}

function saveArtifact({ user, patient, operation, content, issues = [], res, templateVersion = null, status }) {
  const id = uid();
  const now = nowIso();
  const st = status || (issues.length ? 'partial' : 'draft');
  run(`INSERT INTO artifacts(id,patient_id,team_id,operation,context_revision,status,content,requires_review,provider,model,prompt_version,template_version,usage,generation_ms,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)`,
    id, patient?.id ?? null, patient?.team_id ?? null, operation, patient?.revision ?? null, st,
    JSON.stringify({ ...content, validation_issues: issues }), providerName(), res.model, promptVersion, templateVersion,
    JSON.stringify(res.usage), res.ms, user.id, now, now);
  run('INSERT INTO artifact_versions(id,artifact_id,version,content,edited_by,created_at) VALUES(?,?,?,?,?,?)',
    uid(), id, 1, JSON.stringify({ ...content, validation_issues: issues }), null, now);
  audit(user.id, 'ai_generate', { patient_id: patient?.id, artifact_id: id, detail: { operation, status: st, issues: issues.length, model: res.model, tokens: res.usage } });
  return toEnvelope(get('SELECT * FROM artifacts WHERE id=?', id));
}

/* ------------------------------------------------------------------ operations */

export async function extractFacts({ user, patient, source, lowLegibilityLines = [] }) {
  const res = await callModel(user, 'extract_facts', { source: { id: source.id, kind: source.kind, event_time: source.event_time, text: source.text } });
  const { output, issues } = checked(() => V.validateExtractFacts(res.json, source, { lowLegibilityLines }));
  const ids = tx(() => output.facts.map((f) => {
    const id = uid();
    run(`INSERT INTO facts(id,patient_id,label,value,unit,event_time,source_id,source_passage,assertion,reviewer_status,revision,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      id, patient.id, f.label, f.value, f.unit, f.event_time, source.id, f.source_passage, f.assertion, patient.revision, nowIso());
    return id;
  }));
  return saveArtifact({
    user, patient, operation: 'extract_facts',
    content: {
      source_id: source.id, fact_ids: ids, rejected_count: issues.length,
      missing_information: output.missing_information || [],
    },
    issues, res,
  });
}

async function callMedia(user, label, fn) {
  gate(user);
  const t0 = Date.now();
  let res;
  try {
    res = await fn();
  } catch (e) {
    if (e instanceof AdapterError) {
      // Log provider status code / adapter reason only — never media bytes or clinical text.
      console.error(`[ai] ${label} failed:`, e.message, e.status != null ? `provider_status=${e.status}` : '');
      audit(user.id, 'ai_failed', { detail: { operation: label, status: e.status ?? null, reason: e.message } });
      throw new HttpError(502, 'ai_unavailable', 'AI generation failed. Your data is unchanged. Retry, or continue manually.');
    }
    throw e;
  }
  recordUsage(user.id, res.usage);
  return { ...res, ms: Date.now() - t0 };
}

/** Audio or image intake for an existing patient: media -> text source -> pending facts. */
export async function intakeMedia({ user, patient, media }) {
  const { kind, buffer, mimeType, eventTime, sourceKind, retainedPath } = media;
  try {
    let text;
    let lowLegibilityLines = [];
    let confidence = 'ok';
    let mediaModel;

    if (kind === 'audio') {
      const res = await callMedia(user, 'transcribe', () =>
        transcribe({ audioBase64: buffer.toString('base64'), mimeType }));
      text = str(res.json?.text, 100_000);
      need(text, 502, 'ai_invalid_output', 'Transcription returned no text.');
      mediaModel = res.model;
    } else {
      const res = await callMedia(user, 'extract_from_image', () =>
        extractFromImage({ imageBase64: buffer.toString('base64'), mimeType }));
      const { output, issues } = checked(() => V.validateImageExtract(res.json));
      // Specific code so the app can say "could not read the photo" instead of a generic AI error.
      if (!output) {
        const empty = (issues || []).some((i) => i.code === 'empty_image_extract');
        throw new HttpError(
          502,
          empty ? 'image_unreadable' : 'ai_invalid_output',
          empty ? 'Could not read text from the photo.' : 'Image extraction could not be validated.',
          { issues },
        );
      }
      text = output.text;
      lowLegibilityLines = output.low_legibility_lines;
      confidence = output.confidence;
      mediaModel = res.model;
    }

    const sourceId = uid();
    const kindRow = sourceKind || (kind === 'audio' ? 'dictation' : 'image_extract');
    const title = kind === 'audio' ? 'Dictation' : 'Image extract';
    run('INSERT INTO sources(id,patient_id,kind,title,event_time,uploaded_at,text) VALUES(?,?,?,?,?,?,?)',
      sourceId, patient.id, kindRow, title, eventTime, nowIso(), text);
    audit(user.id, 'intake_source', { patient_id: patient.id, detail: { source_id: sourceId, kind: kindRow, confidence } });

    const source = get('SELECT * FROM sources WHERE id=?', sourceId);
    const artifact = await extractFacts({ user, patient, source, lowLegibilityLines });
    return {
      source_id: sourceId,
      transcript_or_text: text,
      fact_ids: artifact.content.fact_ids,
      low_legibility_lines: lowLegibilityLines,
      confidence,
      media_model: mediaModel,
      artifact,
    };
  } finally {
    // Default: never keep raw PHI bytes on disk.
    if (!retainedPath) { /* already in-memory only */ }
    else if (!config.uploads.retainRaw) deleteRaw(retainedPath);
  }
}

/** Dictate into a note field: audio -> text only (no source/facts). */
export async function transcribeOnly({ user, media }) {
  const { buffer, mimeType, retainedPath } = media;
  try {
    const res = await callMedia(user, 'transcribe', () =>
      transcribe({ audioBase64: buffer.toString('base64'), mimeType }));
    const text = str(res.json?.text, 100_000);
    need(text, 502, 'ai_invalid_output', 'Transcription returned no text.');
    audit(user.id, 'transcribe', { detail: { model: res.model } });
    return { text, model: res.model, provider: providerName() };
  } finally {
    if (retainedPath && !config.uploads.retainRaw) deleteRaw(retainedPath);
  }
}

async function mediaToText(user, media) {
  const { kind, buffer, mimeType } = media;
  if (kind === 'audio') {
    const res = await callMedia(user, 'transcribe', () =>
      transcribe({ audioBase64: buffer.toString('base64'), mimeType }));
    const text = str(res.json?.text, 100_000);
    need(text, 502, 'ai_invalid_output', 'Transcription returned no text.');
    return { text, model: res.model };
  }
  const res = await callMedia(user, 'extract_from_image', () =>
    extractFromImage({ imageBase64: buffer.toString('base64'), mimeType }));
  const { output, issues } = checked(() => V.validateImageExtract(res.json));
  if (!output) {
    const empty = (issues || []).some((i) => i.code === 'empty_image_extract');
    throw new HttpError(
      502,
      empty ? 'image_unreadable' : 'ai_invalid_output',
      empty ? 'Could not read text from the photo.' : 'Image extraction could not be validated.',
      { issues },
    );
  }
  return { text: output.text, model: res.model, low_legibility_lines: output.low_legibility_lines, confidence: output.confidence };
}

/**
 * Census from photo or voice. Returns proposed patients only — nothing is created until confirm.
 */
export async function censusIntake({ user, teamId, media }) {
  need(get('SELECT 1 AS x FROM team_members WHERE team_id=? AND user_id=?', teamId, user.id), 403, 'access_denied', 'You are not a member of that team');
  const { kind, retainedPath } = media;
  try {
    const extracted = await mediaToText(user, media);
    const res = await callModel(user, 'propose_census', { source_text: extracted.text });
    const { output, issues } = checked(() => V.validateCensusPropose(res.json, extracted.text));
    const id = uid();
    const now = nowIso();
    const items = output.patients.map((p, index) => ({ index, ...p }));
    run('INSERT INTO census_intakes(id,team_id,created_by,kind,status,source_text,items,created_at) VALUES(?,?,?,?,?,?,?,?)',
      id, teamId, user.id, kind, 'proposed', extracted.text, JSON.stringify(items), now);
    audit(user.id, 'census_intake', { detail: { intake_id: id, team_id: teamId, count: items.length, issues: issues.length } });
    return {
      id,
      status: 'proposed',
      kind,
      team_id: teamId,
      source_text: extracted.text,
      patients: items,
      validation_issues: issues,
      confidence: extracted.confidence || 'ok',
      low_legibility_lines: extracted.low_legibility_lines || [],
      requires_review: true,
      note: 'Proposed patients only. Nothing was added to the census until you confirm.',
    };
  } finally {
    if (retainedPath && !config.uploads.retainRaw) deleteRaw(retainedPath);
  }
}

/** Clinician confirms selected proposed rows (with optional edits). Creates patients + pending reason facts. */
export function censusConfirm({ user, intakeId, body }) {
  const intake = get('SELECT * FROM census_intakes WHERE id=?', intakeId);
  need(intake, 404, 'not_found', 'Census intake not found');
  need(intake.status === 'proposed', 409, 'not_confirmable', 'This intake was already confirmed or discarded');
  need(get('SELECT 1 AS x FROM team_members WHERE team_id=? AND user_id=?', intake.team_id, user.id), 403, 'access_denied', 'You are not a member of that team');
  const proposed = jsonParse(intake.items, []);
  const selections = Array.isArray(body?.items) ? body.items : proposed.map((p) => ({ index: p.index }));
  need(selections.length, 400, 'items_required', 'items required (use index + optional edits, or skip:true)');

  const created = [];
  tx(() => {
    for (const sel of selections.slice(0, 100)) {
      if (sel.skip) continue;
      const base = proposed.find((p) => p.index === sel.index);
      need(base, 400, 'bad_index', `No proposed patient at index ${sel.index}`);
      const edits = sel.edits && typeof sel.edits === 'object' ? sel.edits : {};
      const display_name = str(edits.display_name, 120) || base.display_name;
      need(display_name, 400, 'name_required', 'display_name is required');
      const room = edits.room !== undefined ? str(edits.room, 20) : base.room;
      const age_band = edits.age_band !== undefined ? str(edits.age_band, 20) : base.age_band;
      const sex = edits.sex !== undefined ? str(edits.sex, 20) : base.sex;
      const one_line_reason = edits.one_line_reason !== undefined ? str(edits.one_line_reason, 300) : base.one_line_reason;
      const source_text = str(edits.source_text, 500) || base.source_text || one_line_reason || display_name;
      const patientId = uid();
      const now = nowIso();
      const maxSort = get('SELECT MAX(sort_order) AS m FROM patients WHERE team_id=?', intake.team_id)?.m;
      const sortOrder = Number.isInteger(maxSort) ? maxSort + 1 : (created.length);
      run('INSERT INTO patients(id,team_id,display_name,room,age_band,sex,sort_order,revision,created_at) VALUES(?,?,?,?,?,?,?,1,?)',
        patientId, intake.team_id, display_name, room || null, age_band || null, sex || null, sortOrder, now);
      let factId = null;
      if (one_line_reason) {
        const sid = uid();
        // Ensure the reason passage exists verbatim in the stored source text.
        const stored = source_text.includes(one_line_reason) ? source_text : `${one_line_reason}\n${source_text}`;
        run('INSERT INTO sources(id,patient_id,kind,title,event_time,uploaded_at,text) VALUES(?,?,?,?,?,?,?)',
          sid, patientId, 'census_intake', 'Census intake', null, now, stored);
        factId = uid();
        run(`INSERT INTO facts(id,patient_id,label,value,unit,event_time,source_id,source_passage,assertion,reviewer_status,revision,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,'pending',1,?)`,
          factId, patientId, 'Admission reason', one_line_reason, '', null, sid, one_line_reason, 'present', now);
      }
      audit(user.id, 'patient_create', { patient_id: patientId, detail: { from: 'census_confirm', intake_id: intakeId } });
      created.push({ patient_id: patientId, index: sel.index, fact_id: factId });
    }
    run("UPDATE census_intakes SET status='confirmed', confirmed_at=? WHERE id=?", nowIso(), intakeId);
  });
  for (const c of created) {
    const patient = get('SELECT * FROM patients WHERE id=?', c.patient_id);
    if (patient) ensurePatientChannel({ patient, createdBy: user.id });
  }
  audit(user.id, 'census_confirm', { detail: { intake_id: intakeId, created: created.length } });
  return { intake_id: intakeId, status: 'confirmed', created };
}

/** Deterministic printable census for the clinician's teams. No AI ranking. */
export function censusExport({ user, teamId }) {
  let teamIds;
  if (teamId) {
    need(get('SELECT 1 AS x FROM team_members WHERE team_id=? AND user_id=?', teamId, user.id), 403, 'access_denied', 'You are not a member of that team');
    teamIds = [teamId];
  } else {
    teamIds = all('SELECT team_id FROM team_members WHERE user_id=?', user.id).map((r) => r.team_id);
  }
  need(teamIds.length, 400, 'no_team', 'Join a team before exporting a census');
  const placeholders = teamIds.map(() => '?').join(',');
  const rows = all(
    `SELECT id, display_name, room, age_band, sex, sort_order, team_id FROM patients
     WHERE team_id IN (${placeholders})
     ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order, room, display_name`,
    ...teamIds,
  );
  const patients = rows.map((p, i) => ({
    line: i + 1,
    id: p.id,
    display_name: p.display_name,
    room: p.room || '',
    age_band: p.age_band || '',
    sex: p.sex || '',
    sort_order: p.sort_order,
    team_id: p.team_id,
  }));
  const text = patients.map((p) => {
    const bits = [p.room || '—', p.display_name, p.age_band, p.sex].filter(Boolean);
    return `${String(p.line).padStart(2, ' ')}. ${bits.join(' · ')}`;
  }).join('\n');
  audit(user.id, 'census_export', { detail: { count: patients.length } });
  return {
    ordered_by: 'sort_order_then_room',
    patients,
    text,
    note: 'Printable census. Ordering is clinician sort_order, then room — never AI urgency.',
  };
}

export async function summarizePatient({ user, patient, date }) {
  const ctx = buildContext(patient, { date });
  need(ctx.facts.length > 0, 422, 'no_reviewed_facts', 'Review and confirm chart facts before generating a summary.');
  const res = await callModel(user, 'summarize_patient', { context: ctx });
  const { output, issues } = checked(() => V.validateSummary(res.json, ctx));
  return saveArtifact({ user, patient, operation: 'summarize_patient', content: output, issues, res });
}

/** 60–90s oral presentation from confirmed facts + changesSince + reviewed summary + clinician plan. */
export async function presentPatient({ user, patient, date }) {
  const d = date || today();
  const ctx = buildContext(patient, { date: d });
  need(ctx.facts.length > 0, 422, 'no_reviewed_facts', 'Review and confirm chart facts before generating a presentation.');
  const changes = changesSince(patient);
  const reviewed = get(
    "SELECT id, content, reviewed_at, context_revision FROM artifacts WHERE patient_id=? AND operation='summarize_patient' AND review_state='reviewed' AND outdated=0 ORDER BY reviewed_at DESC LIMIT 1",
    patient.id,
  );
  const reviewed_summary = reviewed ? {
    artifact_id: reviewed.id,
    reviewed_at: reviewed.reviewed_at,
    context_revision: reviewed.context_revision,
    content: jsonParse(reviewed.content, {}),
  } : null;
  const clinician_plan = ctx.clinician_plan;
  const payload = {
    context: ctx,
    changes,
    reviewed_summary: reviewed_summary ? { one_liner: reviewed_summary.content.one_liner, sections: reviewed_summary.content.sections } : null,
    clinician_plan,
  };

  let res = await callModel(user, 'present_patient', payload);
  let { output, issues } = checked(() => V.validatePresentation(res.json, ctx, { planText: clinician_plan?.text || '' }));

  // If validation stripped most chart sentences, regenerate once with a stricter hint.
  const rawCount = Array.isArray(res.json?.sentences) ? res.json.sentences.length : 0;
  const keptCount = (output.sentences || []).length;
  const strippedHard = rawCount >= 2 && keptCount <= Math.floor(rawCount / 2);
  let regenerated = false;
  if (strippedHard) {
    regenerated = true;
    res = await callModel(user, 'present_patient', {
      ...payload,
      stricter: true,
      instruction: 'Prior attempt had unsupported sentences dropped. Cite only known fact_ids; do not invent content.',
    });
    ({ output, issues } = checked(() => V.validatePresentation(res.json, ctx, { planText: clinician_plan?.text || '' })));
  }

  const guidance = [];
  if (!(ctx.facts || []).length) guidance.push('Confirm facts before generating a presentation.');
  if (!clinician_plan?.text) guidance.push("Confirm facts and save Today's plan");
  if ((output.sentences || []).length === 0) {
    guidance.push('Confirm facts and save Today\'s plan');
  }

  return saveArtifact({
    user, patient, operation: 'present_patient',
    content: {
      ...output,
      date: d,
      changes_status: changes.status,
      reviewed_summary_artifact_id: reviewed_summary?.artifact_id || null,
      requires_review: true,
      regenerated_once: regenerated,
      missing_information: [...new Set([...(output.missing_information || []), ...guidance])],
    },
    issues, res,
  });
}

/** Defaults when inputs_from_source_ids is a bare id list (no field map). */
function defaultApplyTo(noteType, template) {
  if (noteType === 'admit_hp') {
    const hist = template.sections.filter((s) => s.source === 'clinician_history').map((s) => s.key);
    // Dictation most often is HPI; still allow feeding all history keys if the client asks via apply_to.
    return hist.includes('hpi') ? ['hpi'] : hist.slice(0, 1);
  }
  if (noteType === 'icu') return ['update'];
  return ['subjective'];
}

/**
 * Resolve clinician note inputs, optionally filling empty fields from dictation/image sources
 * on this patient (POST /transcribe text saved as a source, or intake dictation).
 *
 * Accepts either:
 *   inputs_from_source_ids: ["sid", ...]  + optional apply_to: ["subjective"|"hpi"|...]
 *   inputs_from_source_ids: { subjective: ["sid"], exam: ["sid"], history: { hpi: ["sid"] } }
 * Explicit body fields always win over source-derived text.
 */
function resolveNoteInputs({ patient, input, template, noteType }) {
  const historyKeys = new Set(template.sections.filter((s) => s.source === 'clinician_history').map((s) => s.key));
  const rawHistory = input.history && typeof input.history === 'object' && !Array.isArray(input.history) ? input.history : {};
  const history = {};
  for (const key of historyKeys) history[key] = str(rawHistory[key]);
  const ignoredHistoryKeys = Object.keys(rawHistory).filter((k) => !historyKeys.has(k));

  const fields = {
    subjective: str(input.subjective),
    exam: str(input.exam),
    update: str(input.update),
    support: str(input.support),
    plan: str(input.plan),
    history,
  };

  const fed = []; // { source_id, field } — IDs only for audit/response
  const from = input.inputs_from_source_ids;
  if (!from) {
    return { fields, ignoredHistoryKeys, fed_from_sources: fed, missing_source_ids: [] };
  }

  const loadSource = (id) => {
    const s = get('SELECT id, text, kind FROM sources WHERE id=? AND patient_id=?', id, patient.id);
    need(s, 404, 'source_not_found', `Source ${id} not found for this patient`);
    return s;
  };

  const append = (field, sourceIds) => {
    const ids = (Array.isArray(sourceIds) ? sourceIds : [sourceIds]).map((x) => str(x, 64)).filter(Boolean).slice(0, 10);
    if (!ids.length) return;
    const chunks = [];
    for (const id of ids) {
      const s = loadSource(id);
      const t = str(s.text, 100_000);
      if (t) chunks.push(t);
      fed.push({ source_id: s.id, field, kind: s.kind });
    }
    if (!chunks.length) return;
    const joined = chunks.join('\n\n');
    if (field.startsWith('history.')) {
      const key = field.slice('history.'.length);
      if (!historyKeys.has(key)) return;
      if (!fields.history[key]) fields.history[key] = joined;
    } else if (['subjective', 'exam', 'update', 'support', 'plan'].includes(field)) {
      if (!fields[field]) fields[field] = joined;
    }
  };

  const missing_source_ids = [];
  if (Array.isArray(from)) {
    const ids = from.map((x) => str(x, 64)).filter(Boolean).slice(0, 10);
    for (const id of ids) {
      if (!get('SELECT 1 AS x FROM sources WHERE id=? AND patient_id=?', id, patient.id)) missing_source_ids.push(id);
    }
    need(!missing_source_ids.length, 404, 'source_not_found', 'One or more sources were not found for this patient', { missing_source_ids });
    const applyTo = Array.isArray(input.apply_to) && input.apply_to.length
      ? input.apply_to.map((x) => str(x, 40)).filter(Boolean)
      : defaultApplyTo(noteType, template);
    for (const target of applyTo) {
      if (historyKeys.has(target)) append(`history.${target}`, ids);
      else append(target, ids);
    }
  } else if (from && typeof from === 'object') {
    for (const [field, val] of Object.entries(from)) {
      if (field === 'history' && val && typeof val === 'object' && !Array.isArray(val)) {
        for (const [hk, sids] of Object.entries(val)) append(`history.${hk}`, sids);
      } else {
        append(field, val);
      }
    }
  } else {
    throw new HttpError(400, 'bad_inputs_from_source_ids', 'inputs_from_source_ids must be an array of source ids or a field map object');
  }

  return { fields, ignoredHistoryKeys, fed_from_sources: fed, missing_source_ids };
}

export async function draftNote({ user, patient, input }) {
  const noteType = str(input.note_type, 20) || 'progress';
  const template = getActiveTemplate(noteType);
  need(template, 400, 'unknown_template', `No active template "${noteType}".`);
  const date = str(input.note_date, 10) || today();
  const ctx = buildContext(patient, { date });

  const resolved = resolveNoteInputs({ patient, input, template, noteType });
  const inputs = {
    subjective: resolved.fields.subjective,
    exam: resolved.fields.exam,
    update: resolved.fields.update,
    support: resolved.fields.support,
    plan: resolved.fields.plan || ctx.clinician_plan?.text || '',
    history: resolved.fields.history,
  };

  const res = await callModel(user, 'draft_note', { context: ctx, template: { sections: template.sections }, inputs, note_date: date });
  const { output, issues } = checked(() => V.validateNote(res.json, ctx, template, inputs, date));
  const unresolved = output.sections.reduce((n, s) => n + s.flags.length, 0);
  if (resolved.fed_from_sources.length) {
    audit(user.id, 'note_from_sources', {
      patient_id: patient.id,
      detail: { note_type: noteType, sources: resolved.fed_from_sources.map((f) => ({ source_id: f.source_id, field: f.field })) },
    });
  }
  return saveArtifact({
    user, patient, operation: `draft_note:${noteType}`,
    content: {
      note_type: noteType, note_date: date, ...output, unresolved_flags: unresolved,
      ignored_history_keys: resolved.ignoredHistoryKeys,
      fed_from_sources: resolved.fed_from_sources,
    },
    issues, res, templateVersion: `${template.key}@v${template.version}`,
  });
}

/**
 * Scribe: one messy dictation → structured note sections with transcript spans.
 * Body: { note_type, transcript?, source_ids?, note_date?, clarifications? }
 * clarifications: [{ phrase, answer }] optional answers to prior needs_clarification.
 */
export async function draftNoteFromDictation({ user, patient, input }) {
  const noteType = str(input.note_type, 20) || 'progress';
  const template = getActiveTemplate(noteType);
  need(template, 400, 'unknown_template', `No active template "${noteType}".`);
  const date = str(input.note_date, 10) || today();
  need(isIsoDate(date), 400, 'bad_date', 'note_date must be YYYY-MM-DD');

  let transcript = str(input.transcript, 100_000);
  const sourceIds = Array.isArray(input.source_ids)
    ? input.source_ids.map((x) => str(x, 64)).filter(Boolean).slice(0, 10)
    : [];
  if (!transcript && sourceIds.length) {
    const chunks = [];
    for (const id of sourceIds) {
      const s = get('SELECT id, text FROM sources WHERE id=? AND patient_id=?', id, patient.id);
      need(s, 404, 'source_not_found', `Source ${id} not found for this patient`);
      const t = str(s.text, 100_000);
      if (t) chunks.push(t);
    }
    transcript = chunks.join('\n\n');
  }
  need(transcript, 400, 'transcript_required', 'Provide transcript text or source_ids with text');

  const clarifications = Array.isArray(input.clarifications) ? input.clarifications : [];
  let working = transcript;
  for (const c of clarifications.slice(0, 20)) {
    const phrase = str(c?.phrase, 300);
    const answer = str(c?.answer, 500);
    if (phrase && answer) working += `\n[Clarification about "${phrase}": ${answer}]`;
  }

  const ctx = buildContext(patient, { date });
  const res = await callModel(user, 'draft_note_from_dictation', {
    context: ctx,
    template: { sections: template.sections },
    transcript: working,
    note_date: date,
  });
  const { output, issues } = checked(() =>
    V.validateNoteFromDictation(res.json, ctx, template, working, date));
  const unresolved = output.sections.reduce((n, s) => n + s.flags.length, 0);
  audit(user.id, 'note_from_dictation', {
    patient_id: patient.id,
    detail: { note_type: noteType, source_ids: sourceIds, transcript_chars: working.length, model: res.model },
  });
  return saveArtifact({
    user, patient, operation: `draft_note:${noteType}`,
    content: {
      note_type: noteType,
      note_date: date,
      ...output,
      unresolved_flags: unresolved,
      scribe_mode: 'from_dictation',
      transcript: working,
      media_model: res.model,
      fed_from_sources: sourceIds.map((id) => ({ source_id: id, field: 'transcript' })),
    },
    issues, res, templateVersion: `${template.key}@v${template.version}`,
  });
}

export async function rewriteSection({ user, artifact, key, mode }) {
  need(['regenerate', 'shorten', 'expand', 'improve'].includes(mode), 400, 'bad_mode', 'mode must be regenerate, shorten, expand or improve');
  const content = jsonParse(artifact.content, {});
  const section = (content.sections || []).find((s) => s.key === key);
  need(section, 404, 'section_not_found', 'Section not found');
  const res = await callModel(user, 'rewrite_section', { text: section.text, mode });
  const { output, issues } = checked(() => V.validateRewrite(res.json, section.text));
  if (!output) throw new HttpError(422, 'rewrite_rejected', 'The rewrite was rejected because it added new content. Original text kept.', { issues });
  audit(user.id, 'ai_rewrite_section', { artifact_id: artifact.id, detail: { key, mode } });
  return { key, mode, before: section.text, after: output.text, applied: false };
}

export async function suggestProblems({ user, patient, date }) {
  const ctx = buildContext(patient, { date });
  need(ctx.facts.length > 0, 422, 'no_reviewed_facts', 'Review and confirm chart facts first.');
  const rejected = all("SELECT label FROM problems WHERE patient_id=? AND state='rejected'", patient.id).map((r) => r.label);
  const res = await callModel(user, 'suggest_problems', { context: ctx, rejected_labels: rejected });
  const { output, issues } = checked(() => V.validateProblems(res.json, ctx, rejected));
  const existing = new Set(all("SELECT label FROM problems WHERE patient_id=? AND state!='rejected'", patient.id).map((r) => r.label.toLowerCase()));
  const created = [];
  for (const p of output.problems) {
    if (existing.has(p.label.toLowerCase())) continue;
    const id = uid();
    run('INSERT INTO problems(id,patient_id,label,state,fact_ids,uncertainty,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      id, patient.id, p.label, p.state === 'Documented in source' ? 'documented' : 'suggested', JSON.stringify(p.fact_ids), p.uncertainty, nowIso(), nowIso());
    created.push(id);
  }
  return saveArtifact({ user, patient, operation: 'suggest_problems', content: { problem_ids: created }, issues, res });
}

export function decideProblem({ user, patient, problemId, action }) {
  const problem = get('SELECT * FROM problems WHERE id=? AND patient_id=?', problemId, patient.id);
  need(problem, 404, 'not_found', 'Problem not found');
  const map = { accept: 'confirmed', differential: 'differential', reject: 'rejected' };
  need(map[action], 400, 'bad_action', 'action must be accept, differential or reject');
  run('UPDATE problems SET state=?, decided_by=?, updated_at=? WHERE id=?', map[action], user.id, nowIso(), problemId);
  const revision = bumpRevision(patient.id); // confirmed/differential problems are part of the context
  audit(user.id, `problem_${action}`, { patient_id: patient.id });
  return { id: problemId, state: map[action], context_revision: revision };
}

/**
 * ICD-10-CM suggestions: local table retrieves candidates; model may only choose among them.
 * Does NOT write problems.code_suggestion until the clinician accepts.
 */
export async function suggestCoding({ user, patient, input }) {
  seedDemoIcdIfEmpty();
  const ctx = buildContext(patient);
  need(ctx.facts.length > 0, 422, 'no_reviewed_facts', 'Review and confirm chart facts first.');
  let problems;
  if (input.problem_id) {
    const p = get("SELECT * FROM problems WHERE id=? AND patient_id=? AND state IN ('confirmed','differential')", input.problem_id, patient.id);
    need(p, 422, 'problem_not_selected', 'Coding suggest needs a clinician-confirmed or differential problem.');
    problems = [p];
  } else {
    problems = all("SELECT * FROM problems WHERE patient_id=? AND state IN ('confirmed','differential') ORDER BY created_at", patient.id);
    need(problems.length, 422, 'no_problems', 'Confirm or mark a differential problem before requesting ICD suggestions.');
  }

  const perProblem = [];
  const allIssues = [];
  let lastRes = { model: providerName() === 'openai' ? config.openai.model : 'mock-1', usage: {}, ms: 0 };

  for (const problem of problems.slice(0, 5)) {
    const candidates = searchIcdCandidates(problem.label, { limit: Math.min(Math.max(Number(input.top_n) || 12, 3), 25) });
    const uncertain = !!(problem.uncertainty)
      || problem.state === 'differential'
      || /\b(possible|suspected|probable|likely|rule out|r\/o)\b/i.test(`${problem.label || ''} ${problem.uncertainty || ''}`);
    if (!candidates.length) {
      perProblem.push({
        problem_id: problem.id, problem_label: problem.label, problem_state: problem.state, uncertain,
        candidates: [], suggestions: [],
        reviewer_notes: [
          'No codes in the local ICD-10-CM table matched this problem label. Import the official order file.',
          ...(uncertain ? ['Uncertain / differential diagnosis: do not code as confirmed without clinician/coder judgment.'] : []),
        ],
        label: 'Suggestion for clinician/coder review. Not a billing determination.',
      });
      allIssues.push({ code: 'no_candidates', where: problem.id });
      continue;
    }
    const res = await callModel(user, 'suggest_icd', {
      problem: { id: problem.id, label: problem.label, state: problem.state, uncertainty: problem.uncertainty },
      candidates,
      context: ctx,
    });
    lastRes = res;
    const { output, issues } = checked(() => V.validateIcdSuggest(res.json, {
      candidates,
      problem: { id: problem.id, label: problem.label, state: problem.state, uncertainty: problem.uncertainty },
      facts: ctx.facts,
    }));
    allIssues.push(...issues);
    perProblem.push(output);
  }

  return saveArtifact({
    user, patient, operation: 'suggest_icd',
    content: {
      problems: perProblem,
      label: 'Suggestion for clinician/coder review. Not a billing determination.',
      stored_on_problem: false,
    },
    issues: allIssues, res: lastRes,
  });
}

/** Clinician accepts one suggestion onto problems.code_suggestion (never auto-written). */
export function acceptCodingSuggestion({ user, patient, problemId, body }) {
  const problem = get("SELECT * FROM problems WHERE id=? AND patient_id=? AND state IN ('confirmed','differential')", problemId, patient.id);
  need(problem, 404, 'not_found', 'Problem not found (must be confirmed or differential)');
  const code = str(body.code, 16).toUpperCase();
  need(code, 400, 'code_required', 'code is required');
  seedDemoIcdIfEmpty();
  const row = get('SELECT code, description, billable, fy FROM icd10cm WHERE code=?', code);
  need(row, 400, 'code_not_in_table', 'Code is not in the local ICD-10-CM table');

  let fromArtifact = null;
  if (body.artifact_id) {
    const a = get('SELECT * FROM artifacts WHERE id=? AND patient_id=? AND operation=?', body.artifact_id, patient.id, 'suggest_icd');
    need(a, 404, 'artifact_not_found', 'Coding suggestion artifact not found');
    const content = jsonParse(a.content, {});
    const block = (content.problems || []).find((p) => p.problem_id === problemId);
    const hit = (block?.suggestions || []).find((s) => String(s.code).toUpperCase() === code);
    need(hit, 400, 'not_in_artifact', 'That code was not among the validated suggestions for this problem');
    fromArtifact = a.id;
  }

  const suggestion = {
    code: row.code,
    description: row.description,
    billable: !!row.billable,
    fy: row.fy,
    accepted_at: nowIso(),
    accepted_by: user.id,
    artifact_id: fromArtifact,
    label: 'Suggestion for clinician/coder review. Not a billing determination.',
  };
  run('UPDATE problems SET code_suggestion=?, updated_at=? WHERE id=?', JSON.stringify(suggestion), nowIso(), problemId);
  audit(user.id, 'coding_accept', { patient_id: patient.id, detail: { problem_id: problemId, code: row.code, artifact_id: fromArtifact } });
  return { problem_id: problemId, code_suggestion: suggestion };
}

/** Admin AI helper: draft a check-rule candidate (always status draft, AI-drafted). */
export async function draftCheckRule({ user, condition }) {
  const { createCheckRule, validateCheckRuleDraft } = await import('../check_rules.js');
  const cond = str(condition, 120);
  need(cond, 400, 'condition_required', 'condition is required (e.g. pyelonephritis)');
  const res = await callModel(user, 'draft_check_rule', { condition: cond });
  const { output, issues } = checked(() => validateCheckRuleDraft(res.json, cond));
  need(output, 422, 'draft_rejected', 'The AI draft could not be validated. Nothing was saved.', { issues });
  const rule = createCheckRule({
    user,
    body: { name: output.name, match: output.match, prompts: output.prompts, compare: output.compare },
    aiDrafted: true,
  });
  return {
    rule,
    validation_issues: issues,
    label: output.label,
    requires_review: true,
    note: 'AI-drafted candidate stored as draft. A physician must edit and approve before it affects reminders.',
  };
}

export async function runEvidence({ user, patient, input, label = 'search_evidence' }) {
  let topic = str(input.topic, 150);
  if (input.problem_id) {
    const p = get("SELECT label FROM problems WHERE id=? AND patient_id=? AND state IN ('confirmed','differential')", input.problem_id, patient.id);
    need(p, 422, 'problem_not_selected', 'Evidence search needs a clinician-confirmed or differential problem.');
    topic = p.label;
  }
  need(topic, 422, 'topic_required', 'Provide a topic or a confirmed problem_id.');
  assertQuerySafe(topic, patient);
  let ev;
  try {
    ev = await searchEvidence({ topic, months: Math.min(Math.max(Number(input.months) || 24, 1), 120), includeOlder: input.include_older !== false, force: !!input.force });
  } catch (e) {
    if (e instanceof EvidenceError) throw new HttpError(502, 'evidence_retrieval_failed', 'Evidence retrieval failed. Nothing is shown from memory. Please retry.');
    throw e;
  }
  const toExplain = [...ev.recent.slice(0, 3), ...ev.older.slice(0, 2)];
  let explanations = new Map();
  let res = { model: providerName() === 'openai' ? config.openai.model : 'mock-1', usage: {}, ms: 0 };
  const issues = [];
  if (toExplain.length) {
    try {
      const ctx = buildContext(patient);
      const studies = toExplain.map((r) => ({ evidence_id: r.evidence_id, title: r.title, study_type: r.study_type, date: r.date, abstract: r.abstract }));
      res = await callModel(user, 'explain_evidence', { context: ctx, studies });
      const v = checked(() => V.validateEvidenceExplain(res.json, studies, ctx));
      explanations = v.output;
      issues.push(...v.issues);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      issues.push({ code: 'explanation_unavailable', reason: e.code }); // cards still shown
    }
  }
  const card = (r) => ({ ...publicCard(r), explanation: explanations.get(r.evidence_id) || null });
  const content = {
    topic, query: ev.term, search_date: ev.search_date, last_checked: ev.last_checked, from_cache: ev.from_cache,
    window_months: ev.window_months, sources: ev.sources, filters: ev.filters, excluded_retracted: ev.excluded_retracted,
    top: ev.recent.slice(0, 3).map(card), more: ev.recent.slice(3, 8).map(card), older: ev.older.map(card),
    message: ev.recent.length ? null : 'No relevant recent studies were found in the searched sources.',
    note: 'Studies are retrieved from PubMed. Explanations are AI drafts; read the source before acting.',
  };
  return saveArtifact({ user, patient, operation: label, content, issues, res });
}

const STAGES = ['Recognition', 'Pathophysiology', 'Workup', 'Management', 'Medication choice'];

export async function generateMcqs({ user, patient, input }) {
  let topic = str(input.topic, 150);
  if (patient && input.problem_id) {
    const p = get("SELECT label FROM problems WHERE id=? AND patient_id=? AND state IN ('confirmed','differential')", input.problem_id, patient.id);
    need(p, 422, 'problem_not_selected', 'Case-inspired questions need a clinician-confirmed or differential problem.');
    topic = p.label;
  }
  need(topic, 422, 'topic_required', 'Provide a topic (or a confirmed problem_id).');
  if (patient) assertQuerySafe(topic, patient);
  const count = Math.min(Math.max(Number(input.count) || 1, 1), 5);
  const difficulty = ['easy', 'intermediate', 'hard'].includes(input.difficulty) ? input.difficulty : 'intermediate';
  let ev;
  try { ev = await searchEvidence({ topic, months: 60, includeOlder: true }); } catch (e) {
    if (e instanceof EvidenceError) throw new HttpError(502, 'evidence_retrieval_failed', 'Could not assemble an evidence packet. Please retry.');
    throw e;
  }
  const packet = [...ev.recent, ...ev.older].filter((r) => r.abstract).slice(0, 4);
  need(packet.length, 422, 'no_evidence_packet', 'No approved evidence was found for this topic, so no question was generated.');
  const identifiers = patient ? [...patient.display_name.split(/\s+/), patient.room || ''] : [];
  const packetPayload = packet.map((p) => ({ pmid: p.pmid, title: p.title, date: p.date, abstract: p.abstract }));
  const ids = [];
  let withheld = 0;
  for (const stage of STAGES.slice(0, count)) {
    let saved = null;
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      const gen = await callModel(user, 'generate_mcq', { topic, stage, difficulty, evidence_packet: packetPayload });
      const v = checked(() => V.validateMcq(gen.json, packetPayload, identifiers));
      if (!v.output) continue;
      const chk = await callModel(user, 'validate_mcq', { mcq: v.output, evidence_packet: packetPayload });
      const ok = chk.json?.one_defensible_answer === true && chk.json?.ambiguous === false && !(chk.json?.unsupported_claims || []).length;
      if (!ok) continue;
      saved = saveMcq({ user, topic, difficulty, stage, content: { ...v.output, evidence: packetPayload.map(({ pmid, title, date }) => ({ pmid, title, date })) }, validation: chk.json, model: gen.model });
    }
    if (saved) ids.push(saved); else withheld += 1;
  }
  audit(user.id, 'mcq_generate', { patient_id: patient?.id, detail: { count: ids.length, withheld } });
  return { topic, difficulty, generated: ids.length, withheld, mcq_ids: ids, status: 'ai_generated_unreviewed' };
}

export async function extractTasks({ user, patient, date }) {
  const plan = get('SELECT * FROM plans WHERE patient_id=? AND plan_date=? ORDER BY created_at DESC LIMIT 1', patient.id, date || today());
  need(plan, 422, 'no_plan', 'Enter the clinician plan first; tasks are only extracted from a documented plan.');
  const res = await callModel(user, 'extract_tasks', { plan_text: plan.text });
  const { output, issues } = checked(() => V.validateTasks(res.json, plan.text));
  const existing = new Set(all("SELECT text FROM tasks WHERE patient_id=? AND state IN ('proposed','open')", patient.id).map((t) => t.text.toLowerCase()));
  const ids = [];
  for (const t of output.tasks) {
    if (existing.has(t.text.toLowerCase())) continue;
    const id = uid();
    run('INSERT INTO tasks(id,patient_id,text,owner,due,plan_quote,state,created_at) VALUES(?,?,?,?,?,?,?,?)', id, patient.id, t.text, t.owner, t.due, t.plan_quote, 'proposed', nowIso());
    ids.push(id);
  }
  return saveArtifact({ user, patient, operation: 'extract_tasks', content: { task_ids: ids, plan_date: plan.plan_date }, issues, res });
}

export async function draftSignout({ user, patient, input }) {
  const date = str(input.date, 10) || today();
  const ctx = buildContext(patient, { date });
  need(ctx.facts.length > 0, 422, 'no_reviewed_facts', 'Review and confirm chart facts first.');
  const contingencies = (Array.isArray(input.contingencies) ? input.contingencies : []).map((c) => str(c, 400)).filter(Boolean).slice(0, 20);
  const res = await callModel(user, 'draft_signout', { context: ctx });
  const { output, issues } = checked(() => V.validateSignout(res.json, ctx, contingencies));
  return saveArtifact({ user, patient, operation: 'draft_signout', content: output, issues, res });
}

export async function exploreConsiderations({ user, patient, date }) {
  need(config.features.considerations, 403, 'feature_disabled', 'Considerations are disabled until clinical evaluation passes.');
  const ctx = buildContext(patient, { date });
  need(ctx.facts.length > 0, 422, 'no_reviewed_facts', 'Review and confirm chart facts first.');
  const res = await callModel(user, 'explore_considerations', { context: ctx });
  const { output, issues } = checked(() => V.validateConsiderations(res.json, ctx));
  return saveArtifact({ user, patient, operation: 'explore_considerations', content: { ...output, disclaimer: 'Considerations for clinician review. Not a diagnosis, ranking or probability.' }, issues, res });
}

/** Explicit opt-in thread summary. AI must not silently read channels. */
export async function summarizeChatThread({ user, channelId }) {
  assertChatEnabled();
  const ch = authorizeChannel(user, channelId);
  const messages = threadMessagesForAi(channelId, { limit: 80 });
  need(messages.length, 422, 'empty_thread', 'No messages to summarize in this channel.');
  const payload = {
    channel: { id: ch.id, type: ch.type, name: ch.name },
    messages: messages.map((m) => ({ message_id: m.id, sender_id: m.sender_id, body: m.body, created_at: m.created_at })),
  };
  const res = await callModel(user, 'summarize_chat_thread', payload);
  const { output, issues } = checked(() => V.validateChatThreadSummary(res.json, messages));
  const patient = ch.patient_id ? get('SELECT * FROM patients WHERE id=?', ch.patient_id) : null;
  audit(user.id, 'chat_summarize_requested', {
    patient_id: ch.patient_id,
    detail: { channel_id: channelId },
  });
  return saveArtifact({
    user,
    patient,
    operation: 'summarize_chat_thread',
    content: {
      ...output,
      channel_id: ch.id,
      disclaimer: 'AI draft of this channel only. Review required. Not clinical documentation.',
    },
    issues,
    res,
  });
}

/* ------------------------------------------------------------------ patient-scoped assistant */

const BLOCKED = /\b(all patients|other patients|another patient|census|export|download|prescribe|place (an )?order|send (a )?(message|email)|sign (the|this) note)\b/i;
const EVIDENCE = /\b(study|studies|trial|trials|evidence|guideline|guidelines|literature|pubmed|meta-analysis|research)\b/i;
const CHART = /\b(this patient|my patient|chart|today|overnight|yesterday|summar|course|changed|trend|lab|pending|she|he)\b/i;

export async function ask({ user, patient, input }) {
  const question = str(input.question, 1000);
  need(question, 400, 'question_required', 'question is required');
  if (BLOCKED.test(question)) {
    return { status: 'refused', message: 'This assistant is limited to the current patient and cannot place orders, send messages, sign notes, or access other patients or exports.' };
  }
  const wantsEvidence = EVIDENCE.test(question);
  const wantsChart = CHART.test(question) || !wantsEvidence;
  const out = { status: 'ok', route: wantsEvidence && wantsChart ? 'mixed' : wantsEvidence ? 'evidence' : 'chart' };
  if (wantsChart) {
    const ctx = buildContext(patient, { date: str(input.date, 10) || today() });
    need(ctx.facts.length > 0, 422, 'no_reviewed_facts', 'Review and confirm chart facts before asking about the chart.');
    const res = await callModel(user, 'answer_chart_question', { context: ctx, question });
    const { output, issues } = checked(() => V.validateChat(res.json, ctx));
    out.chart = saveArtifact({ user, patient, operation: 'answer_chart_question', content: output, issues, res });
  }
  if (wantsEvidence) {
    const topic = str(input.topic, 150) || get("SELECT label FROM problems WHERE patient_id=? AND state IN ('confirmed','differential') ORDER BY created_at LIMIT 1", patient.id)?.label;
    if (!topic) { out.status = 'needs_topic'; out.message = 'Which clinical topic should I search the literature for? Provide "topic" or confirm a problem first.'; return out; }
    out.evidence = await runEvidence({ user, patient, input: { topic }, label: 'search_evidence' });
  }
  return out;
}
