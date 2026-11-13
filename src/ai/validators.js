import { numbersIn, unsupportedNumbers, isIsoDate } from '../util.js';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const strs = (arr, max = 20) => (Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 500)).slice(0, max) : []);
const CONVERSATIONAL = /\b(as an ai|based on (what|the information) you|i (cannot|can't|am unable)|here is (the|your)|here's (the|your)|let me know)\b/i;

export function makeChecker(ctx) {
  const facts = new Map(ctx.facts.map((f) => [f.fact_id, f]));
  const trendText = (ctx.trends || []).map((t) => `${t.label} ${t.from.value} ${t.to.value} ${t.delta} ${t.from.event_time} ${t.to.event_time}`).join(' ');
  const allowedFor = (ids, extra = '') =>
    ids.map((id) => { const f = facts.get(id); return f ? `${f.label} ${f.value} ${f.unit} ${f.event_time}` : ''; }).join(' ')
    + ` ${trendText} ${ctx.selected_date || ''} ${extra}`;

  /** Keep only claims that cite known facts and contain no number the cited facts do not support. */
  function claims(arr, where, issues) {
    const out = [];
    for (const c of Array.isArray(arr) ? arr : []) {
      const text = typeof c?.text === 'string' ? c.text.trim() : '';
      const ids = Array.isArray(c?.fact_ids) ? c.fact_ids.filter((x) => typeof x === 'string') : [];
      if (!text || !ids.length || !ids.every((id) => facts.has(id))) { issues.push({ code: 'unsupported_claim', where }); continue; }
      const bad = unsupportedNumbers(text, allowedFor(ids));
      if (bad.length) { issues.push({ code: 'unsupported_number', where, numbers: bad }); continue; }
      out.push({ text, fact_ids: ids, label: c.label === 'AI interpretation' ? 'AI interpretation' : 'From chart' });
    }
    return out;
  }
  return { facts, claims, allowedFor };
}

export function validateExtractFacts(raw, source, { lowLegibilityLines = [] } = {}) {
  const issues = [];
  const facts = [];
  const missing = [];
  const text = norm(source.text);
  const low = (Array.isArray(lowLegibilityLines) ? lowLegibilityLines : [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => ({ raw: x.trim(), n: norm(x) }));
  for (const line of low) missing.push(`low_legibility: ${line.raw.slice(0, 200)}`);
  for (const f of Array.isArray(raw?.facts) ? raw.facts : []) {
    const label = typeof f?.label === 'string' ? f.label.trim().slice(0, 120) : '';
    const value = typeof f?.value === 'string' || typeof f?.value === 'number' ? String(f.value).trim().slice(0, 1000) : '';
    const passage = typeof f?.source_passage === 'string' ? f.source_passage.trim() : '';
    if (!label || !value || !passage) { issues.push({ code: 'incomplete_fact' }); continue; }
    if (!text.includes(norm(passage))) { issues.push({ code: 'passage_not_in_source', label }); continue; }
    // Low-legibility lines must not become facts (checked before number rules so the reason is clear).
    if (low.some((l) => norm(passage).includes(l.n) || l.n.includes(norm(passage)))) {
      issues.push({ code: 'low_legibility_excluded', label });
      continue;
    }
    if (unsupportedNumbers(value, passage).length) { issues.push({ code: 'value_not_in_passage', label }); continue; }
    facts.push({
      label, value, unit: typeof f.unit === 'string' ? f.unit.trim().slice(0, 20) : '',
      event_time: isIsoDate(f.event_time) ? f.event_time : source.event_time || null,
      assertion: ['present', 'negated', 'uncertain'].includes(f.assertion) ? f.assertion : 'present',
      source_passage: passage,
    });
  }
  return { output: { facts, missing_information: missing }, issues };
}

const UNCERTAIN_RE = /\b(possible|suspected|probable|likely|rule out|r\/o|cannot exclude|differential)\b/i;

const WORD_BUDGET = { min: 150, max: 220 };
const wordCount = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

/**
 * Oral presentation: every chart sentence must cite known fact_ids; plan lines may only
 * restate the clinician plan. Flag if over the ~150–220 word spoken budget.
 */
export function validatePresentation(raw, ctx, { planText = '' } = {}) {
  const issues = [];
  const ck = makeChecker(ctx);
  const sentences = [];
  for (const s of Array.isArray(raw?.sentences) ? raw.sentences : []) {
    const kept = ck.claims([s], 'presentation', issues);
    if (kept.length) sentences.push(kept[0]);
  }
  const plan_sentences = [];
  const plan = String(planText || '');
  for (const s of Array.isArray(raw?.plan_sentences) ? raw.plan_sentences : []) {
    const text = typeof s?.text === 'string' ? s.text.trim() : '';
    if (!text) continue;
    if (!plan) { issues.push({ code: 'plan_sentence_without_plan' }); continue; }
    const bad = unsupportedNumbers(text, plan);
    if (bad.length) { issues.push({ code: 'plan_unsupported_number', numbers: bad }); continue; }
    if (CONVERSATIONAL.test(text)) { issues.push({ code: 'conversational_text', where: 'plan' }); continue; }
    plan_sentences.push({ text, source: 'clinician_plan' });
  }

  const spoken_text = [...sentences.map((s) => s.text), ...plan_sentences.map((s) => s.text)].join(' ').trim();
  const words = wordCount(spoken_text);
  const flags = [];
  if (words > WORD_BUDGET.max) {
    flags.push({ code: 'over_word_budget', words, max: WORD_BUDGET.max });
    issues.push({ code: 'over_word_budget', words, max: WORD_BUDGET.max });
  } else if (words > 0 && words < WORD_BUDGET.min) {
    flags.push({ code: 'under_word_budget', words, min: WORD_BUDGET.min });
    issues.push({ code: 'under_word_budget', words, min: WORD_BUDGET.min });
  }
  if (!sentences.length) issues.push({ code: 'no_supported_sentences' });

  const estimated_seconds = Math.round((words / 180) * 60); // ~180 wpm spoken
  return {
    output: {
      sentences,
      plan_sentences,
      spoken_text,
      word_count: words,
      word_budget: WORD_BUDGET,
      estimated_seconds,
      target_duration: '60-90 seconds',
      flags,
      missing_information: strs(raw?.missing_information),
      label: 'AI draft oral presentation. Review required before use.',
    },
    issues,
  };
}

/**
 * Model may only pick codes from `candidates` (local table retrieval).
 * Uncertain / differential problems are never labeled as confirmed coding.
 */
export function validateIcdSuggest(raw, { candidates, problem, facts }) {
  const issues = [];
  const reviewer_notes = [];
  const cand = new Map((candidates || []).map((c) => [String(c.code).toUpperCase(), c]));
  const factIds = new Set((facts || []).map((f) => f.fact_id));
  const uncertain = !!(problem?.uncertainty)
    || problem?.state === 'differential'
    || UNCERTAIN_RE.test(`${problem?.label || ''} ${problem?.uncertainty || ''}`);

  if (uncertain) {
    reviewer_notes.push(
      'Uncertain / differential diagnosis: do not code as a confirmed inpatient principal diagnosis without clinician/coder judgment. Outpatient vs inpatient uncertain-diagnosis rules differ — verify against official coding guidelines. This app does not decide.',
    );
  }

  const suggestions = [];
  for (const s of Array.isArray(raw?.suggestions) ? raw.suggestions : []) {
    const code = typeof s?.code === 'string' ? s.code.trim().toUpperCase() : '';
    if (!code) { issues.push({ code: 'missing_code' }); continue; }
    if (!cand.has(code)) { issues.push({ code: 'code_not_in_candidates', value: code }); continue; }
    const meta = cand.get(code);
    const ids = (Array.isArray(s?.fact_ids) ? s.fact_ids : []).filter((id) => typeof id === 'string' && factIds.has(id));
    const missing_for_specificity = (Array.isArray(s?.missing_for_specificity) ? s.missing_for_specificity : [])
      .filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 200)).slice(0, 10);
    const rationale = typeof s?.rationale === 'string' ? s.rationale.trim().slice(0, 500) : '';
    suggestions.push({
      code: meta.code,
      description: meta.description,
      billable: !!meta.billable,
      fact_ids: ids,
      missing_for_specificity,
      rationale,
      coding_status: uncertain ? 'uncertain_not_confirmed' : 'suggested',
    });
  }

  if (!suggestions.length && (candidates || []).length) {
    issues.push({ code: 'no_valid_suggestion' });
  }

  return {
    output: {
      problem_id: problem?.id || null,
      problem_label: problem?.label || null,
      problem_state: problem?.state || null,
      uncertain,
      candidates: (candidates || []).map((c) => ({ code: c.code, description: c.description, billable: !!c.billable })),
      suggestions,
      reviewer_notes: [...reviewer_notes, ...((Array.isArray(raw?.reviewer_notes) ? raw.reviewer_notes : []).filter((x) => typeof x === 'string').map((x) => x.slice(0, 300)))],
      label: 'Suggestion for clinician/coder review. Not a billing determination.',
    },
    issues,
  };
}

/** Proposed census rows from a photo/voice extract. Nothing is created yet. */
export function validateCensusPropose(raw, sourceText) {
  const issues = [];
  const patients = [];
  const full = norm(sourceText);
  for (const p of Array.isArray(raw?.patients) ? raw.patients : []) {
    const display_name = typeof p?.display_name === 'string' ? p.display_name.trim().slice(0, 120) : '';
    if (!display_name) { issues.push({ code: 'missing_display_name' }); continue; }
    const source_passage = typeof p?.source_text === 'string' ? p.source_text.trim().slice(0, 500) : '';
    if (source_passage && !full.includes(norm(source_passage))) {
      issues.push({ code: 'source_text_not_in_extract', where: display_name });
      continue;
    }
    const one_line_reason = typeof p?.one_line_reason === 'string' ? p.one_line_reason.trim().slice(0, 300) : '';
    if (one_line_reason) {
      const bad = unsupportedNumbers(one_line_reason, `${sourceText} ${source_passage}`);
      if (bad.length) { issues.push({ code: 'unsupported_number', where: display_name, numbers: bad }); continue; }
    }
    patients.push({
      display_name,
      room: typeof p?.room === 'string' ? p.room.trim().slice(0, 20) : '',
      age_band: typeof p?.age_band === 'string' ? p.age_band.trim().slice(0, 20) : '',
      sex: typeof p?.sex === 'string' ? p.sex.trim().slice(0, 20) : '',
      one_line_reason,
      source_text: source_passage || display_name,
      status: 'proposed',
    });
  }
  return { output: { patients, status: 'proposed' }, issues };
}

/** Vision OCR output: keep verbatim text; collect low-legibility lines for missing_information. */
export function validateImageExtract(raw) {
  const issues = [];
  const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
  if (!text) issues.push({ code: 'empty_image_extract' });
  const low = [];
  for (const line of Array.isArray(raw?.lines) ? raw.lines : []) {
    if (line?.legibility === 'low' && typeof line.text === 'string' && line.text.trim()) low.push(line.text.trim());
  }
  for (const s of Array.isArray(raw?.low_legibility_lines) ? raw.low_legibility_lines : []) {
    if (typeof s === 'string' && s.trim() && !low.includes(s.trim())) low.push(s.trim());
  }
  const confidence = ['ok', 'partial', 'low'].includes(raw?.confidence)
    ? raw.confidence
    : (low.length ? 'partial' : 'ok');
  return {
    output: issues.length ? null : { text, low_legibility_lines: low, confidence },
    issues,
  };
}

const SUMMARY_KEYS = ['reason_for_admission', 'brief_course', 'active_problems', 'key_findings', 'pending_work'];

export function validateSummary(raw, ctx) {
  const issues = [];
  const ck = makeChecker(ctx);
  const one = ck.claims([raw?.one_liner], 'one_liner', issues)[0] || null;
  const sections = [];
  for (const s of Array.isArray(raw?.sections) ? raw.sections : []) {
    if (!SUMMARY_KEYS.includes(s?.key)) continue;
    const cl = ck.claims(s.claims, s.key, issues);
    if (cl.length) sections.push({ key: s.key, title: typeof s.title === 'string' ? s.title.slice(0, 80) : s.key, claims: cl });
  }
  return {
    output: {
      one_liner: one, sections,
      missing_information: [...ctx.missing_information, ...strs(raw?.missing_information)],
      conflicts: ctx.conflicts, // detected in code
      truncated: ctx.truncated ? ctx.excluded_manifest : null,
    },
    issues,
  };
}

const INPUT_FOR = { clinician_subjective: 'subjective', clinician_exam: 'exam', clinician_update: 'update', clinician_support: 'support', clinician_plan: 'plan' };

export function validateNote(raw, ctx, template, inputs, noteDate) {
  const issues = [];
  const ck = makeChecker(ctx);
  const byKey = new Map((Array.isArray(raw?.sections) ? raw.sections : []).map((s) => [s?.key, s]));
  const considerations = ck.claims(raw?.proposed_considerations, 'considerations', issues);
  const missing = ctx.missing_information.filter((m) => m !== 'clinician_plan');
  const sections = [];
  for (const t of template.sections) {
    const rs = byKey.get(t.key);
    let text = typeof rs?.text === 'string' ? rs.text.trim() : '';
    let ids = (Array.isArray(rs?.fact_ids) ? rs.fact_ids : []).filter((id) => ck.facts.has(id));
    const flags = [];
    const field = INPUT_FOR[t.source];
    const isHistory = t.source === 'clinician_history';
    if (field || isHistory) {
      // Clinician-sourced section: content may only come from what the clinician supplied for THIS section.
      const entered = isHistory ? (inputs.history?.[t.key] || '') : (inputs[field] || '');
      ids = [];
      if (!entered) {
        if (text) issues.push({ code: 'model_text_discarded', where: t.key });
        text = `[${t.title} not entered]`;
        missing.push(isHistory ? `clinician_history_${t.key}` : `clinician_${field}`);
      } else {
        const bad = unsupportedNumbers(text, `${entered} ${noteDate}`);
        if (bad.length) flags.push({ code: 'unsupported_number', numbers: bad });
      }
    } else {
      const extra = t.source === 'facts_and_exam' ? inputs.exam || '' : '';
      const bad = unsupportedNumbers(text, ck.allowedFor(ids, `${extra} ${noteDate}`));
      if (bad.length) flags.push({ code: 'unsupported_number', numbers: bad });
      if (text && !ids.length && t.source === 'facts') flags.push({ code: 'no_source_facts' });
    }
    if (CONVERSATIONAL.test(text)) flags.push({ code: 'conversational_text' });
    if (flags.length) issues.push({ code: 'section_flagged', where: t.key });
    sections.push({ key: t.key, title: t.title, source: t.source, text, fact_ids: ids, flags, edited: false });
  }
  return {
    output: { sections, proposed_considerations: considerations, missing_information: [...new Set([...missing, ...strs(raw?.missing_information)])], conflicts: ctx.conflicts },
    issues,
  };
}

export function validateRewrite(raw, before) {
  const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
  const issues = [];
  if (!text) issues.push({ code: 'empty_rewrite' });
  const bad = unsupportedNumbers(text, before);
  if (bad.length) issues.push({ code: 'rewrite_added_numbers', numbers: bad });
  if (CONVERSATIONAL.test(text)) issues.push({ code: 'conversational_text' });
  return { output: issues.length ? null : { text }, issues };
}

const PROBLEM_STATES = ['Documented in source', 'Suggested by AI'];

export function validateProblems(raw, ctx, rejectedLabels) {
  const issues = [];
  const ck = makeChecker(ctx);
  const rej = new Set(rejectedLabels.map((x) => x.toLowerCase()));
  const out = [];
  for (const p of Array.isArray(raw?.problems) ? raw.problems : []) {
    const label = typeof p?.label === 'string' ? p.label.trim().slice(0, 120) : '';
    const ids = Array.isArray(p?.fact_ids) ? p.fact_ids.filter((id) => ck.facts.has(id)) : [];
    if (!label || !ids.length) { issues.push({ code: 'unsupported_problem' }); continue; }
    if (rej.has(label.toLowerCase())) { issues.push({ code: 'rejected_label_resuggested' }); continue; }
    out.push({ label, state: PROBLEM_STATES.includes(p.state) ? p.state : 'Suggested by AI', fact_ids: ids, uncertainty: typeof p.uncertainty === 'string' ? p.uncertainty.slice(0, 300) : '' });
  }
  return { output: { problems: out }, issues };
}

export function validateEvidenceExplain(raw, studies, ctx) {
  const issues = [];
  const ck = makeChecker(ctx);
  const byId = new Map(studies.map((s) => [s.evidence_id, s]));
  const out = new Map();
  const cleanText = (text, allowed) =>
    String(text || '').split(/(?<=[.!?])\s+/).filter((sent) => {
      const bad = unsupportedNumbers(sent, allowed);
      if (bad.length) issues.push({ code: 'evidence_number_not_in_abstract', numbers: bad });
      return sent.trim() && !bad.length;
    }).join(' ').trim();
  for (const it of Array.isArray(raw?.items) ? raw.items : []) {
    const s = byId.get(it?.evidence_id);
    if (!s) { issues.push({ code: 'unknown_evidence_id' }); continue; }
    const allowed = `${s.title} ${s.abstract || ''}`;
    out.set(s.evidence_id, {
      what_found: cleanText(it.what_found, allowed),
      applicability: {
        resembles: ck.claims(it.applicability?.resembles, 'resembles', issues),
        differs: ck.claims(it.applicability?.differs, 'differs', issues),
        unknown: strs(it.applicability?.unknown),
      },
      discuss: cleanText(it.discuss, allowed),
    });
  }
  return { output: out, issues };
}

export function validateMcq(raw, packet, identifiers) {
  const issues = [];
  const letters = ['A', 'B', 'C', 'D', 'E'];
  const opts = raw?.options || {};
  const optTexts = letters.map((l) => (typeof opts[l] === 'string' ? opts[l].trim() : ''));
  if (optTexts.some((t) => !t)) issues.push({ code: 'options_incomplete', fatal: true });
  if (new Set(optTexts.map(norm)).size !== 5) issues.push({ code: 'options_not_distinct', fatal: true });
  if (!letters.includes(raw?.answer)) issues.push({ code: 'bad_answer_key', fatal: true });
  const oe = raw?.option_explanations || {};
  if (letters.some((l) => typeof oe[l] !== 'string' || !oe[l].trim())) issues.push({ code: 'missing_option_explanations', fatal: true });
  for (const k of ['vignette', 'question', 'explanation', 'learning_objective']) {
    if (typeof raw?.[k] !== 'string' || !raw[k].trim()) issues.push({ code: `missing_${k}`, fatal: true });
  }
  const pmids = new Set(packet.map((p) => String(p.pmid)));
  const refs = (Array.isArray(raw?.references) ? raw.references : []).map((r) => String(r?.pmid)).filter((p) => pmids.has(p));
  if (!refs.length) issues.push({ code: 'no_valid_reference', fatal: true });
  const blob = norm(JSON.stringify(raw));
  for (const id of identifiers) if (id.length >= 3 && blob.includes(norm(id))) issues.push({ code: 'identifier_leak', fatal: true });
  if (/\b\d{6,}\b/.test(blob)) issues.push({ code: 'long_number_in_text', fatal: true });
  const fatal = issues.some((i) => i.fatal);
  return {
    output: fatal ? null : {
      vignette: raw.vignette.trim(), question: raw.question.trim(),
      options: Object.fromEntries(letters.map((l, i) => [l, optTexts[i]])),
      answer: raw.answer, explanation: raw.explanation.trim(),
      option_explanations: Object.fromEntries(letters.map((l) => [l, oe[l].trim()])),
      learning_objective: raw.learning_objective.trim(), references: refs.map((pmid) => ({ pmid })),
    },
    issues,
  };
}

export function validateTasks(raw, planText) {
  const issues = [];
  const plan = norm(planText);
  const tasks = [];
  for (const t of Array.isArray(raw?.tasks) ? raw.tasks : []) {
    const text = typeof t?.text === 'string' ? t.text.trim().slice(0, 300) : '';
    const quote = typeof t?.plan_quote === 'string' ? t.plan_quote.trim() : '';
    if (!text || !quote || !plan.includes(norm(quote))) { issues.push({ code: 'task_not_in_plan' }); continue; }
    const owner = typeof t.owner === 'string' && norm(quote).includes(norm(t.owner)) ? t.owner.trim() : null;
    const due = typeof t.due === 'string' && norm(quote).includes(norm(t.due)) ? t.due.trim() : null;
    if ((t.owner && !owner) || (t.due && !due)) issues.push({ code: 'owner_or_due_not_explicit' });
    tasks.push({ text, owner, due, plan_quote: quote });
  }
  return { output: { tasks }, issues };
}

export function validateChat(raw, ctx) {
  const issues = [];
  const ck = makeChecker(ctx);
  return { output: { answer: ck.claims(raw?.answer, 'answer', issues), missing_information: strs(raw?.missing_information) }, issues };
}

/** Thread summary: every bullet must cite known message_ids; numbers must appear in cited message bodies. */
export function validateChatThreadSummary(raw, messages) {
  const issues = [];
  const byId = new Map((messages || []).map((m) => [m.id, m]));
  const bullets = [];
  for (const b of Array.isArray(raw?.bullets) ? raw.bullets : []) {
    const text = typeof b?.text === 'string' ? b.text.trim().slice(0, 500) : '';
    const ids = Array.isArray(b?.message_ids) ? b.message_ids.filter((x) => typeof x === 'string') : [];
    if (!text || !ids.length || !ids.every((id) => byId.has(id))) {
      issues.push({ code: 'unsupported_bullet' });
      continue;
    }
    const allowed = ids.map((id) => byId.get(id).body).join(' ');
    const bad = unsupportedNumbers(text, allowed);
    if (bad.length) { issues.push({ code: 'unsupported_number', numbers: bad }); continue; }
    bullets.push({ text, message_ids: ids });
  }
  return {
    output: {
      bullets,
      open_questions: strs(raw?.open_questions),
      missing_information: strs(raw?.missing_information),
    },
    issues,
  };
}

export function validateSignout(raw, ctx, contingencies) {
  const issues = [];
  const ck = makeChecker(ctx);
  const missing = strs(raw?.missing_information);
  if (!contingencies.length) missing.push('contingency_instructions (clinician must supply)');
  return {
    output: {
      summary: ck.claims(raw?.summary, 'summary', issues),
      outstanding_actions: ck.claims(raw?.outstanding_actions, 'outstanding_actions', issues),
      contingencies, // clinician-supplied only; any model-written contingency is ignored
      missing_information: missing,
    },
    issues,
  };
}

export function validateConsiderations(raw, ctx) {
  const issues = [];
  const ck = makeChecker(ctx);
  const out = [];
  for (const c of Array.isArray(raw?.considerations) ? raw.considerations : []) {
    const name = typeof c?.name === 'string' ? c.name.trim().slice(0, 120) : '';
    if (!name) continue;
    out.push({ name, supporting: ck.claims(c.supporting, 'supporting', issues), opposing: ck.claims(c.opposing, 'opposing', issues), missing_data: strs(c.missing_data) });
  }
  return { output: { considerations: out }, issues };
}

export { numbersIn };
