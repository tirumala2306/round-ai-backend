import { jsonParse } from './util.js';

/**
 * Structured Assessment & Plan stored in plans.text as JSON when versioned.
 * Legacy plain text remains supported.
 *
 * Shape:
 * {
 *   version: 1,
 *   include_icd: boolean,
 *   items: [{ problem_id?, label, assessment, plan, code? }]
 * }
 */

export function isStructuredPlanText(raw) {
  if (typeof raw !== 'string') return false;
  const t = raw.trim();
  if (!t.startsWith('{')) return false;
  try {
    const o = JSON.parse(t);
    return o && o.version === 1 && Array.isArray(o.items);
  } catch {
    return false;
  }
}

export function parsePlanRecord(planRow) {
  if (!planRow?.text) {
    return {
      include_icd: false,
      items: [],
      plain_text: '',
      structured: null,
      plan_date: planRow?.plan_date || null,
    };
  }
  if (isStructuredPlanText(planRow.text)) {
    const structured = JSON.parse(planRow.text);
    return {
      include_icd: !!structured.include_icd,
      items: normalizeItems(structured.items),
      plain_text: renderPlanText(structured),
      structured: {
        version: 1,
        include_icd: !!structured.include_icd,
        items: normalizeItems(structured.items),
      },
      plan_date: planRow.plan_date,
    };
  }
  const plain = String(planRow.text).trim();
  // Migrate legacy free-text into one "General" block (Prompt 8 §5.8).
  const migrated = plain
    ? normalizeItems([{
      problem_id: null,
      label: 'General',
      assessment: '',
      plan: plain,
      source: 'clinician',
      status: 'edited',
      manually_edited: true,
    }])
    : [];
  return {
    include_icd: false,
    items: migrated,
    plain_text: plain,
    structured: migrated.length
      ? { version: 1, include_icd: false, items: migrated }
      : null,
    plan_date: planRow.plan_date,
    migrated_from_plain: !!migrated.length,
  };
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 40).map((it) => {
    const source = ['clinician', 'dictation_proposal'].includes(it?.source)
      ? it.source
      : 'clinician';
    const status = ['draft', 'proposed', 'accepted', 'edited'].includes(it?.status)
      ? it.status
      : (source === 'dictation_proposal' ? 'proposed' : 'draft');
    return {
      problem_id: typeof it?.problem_id === 'string' ? it.problem_id.slice(0, 64) : null,
      label: String(it?.label || '').trim().slice(0, 200),
      assessment: String(it?.assessment || it?.assessment_text || '').trim().slice(0, 4000),
      plan: String(it?.plan || it?.plan_text || '').trim().slice(0, 4000),
      code: typeof it?.code === 'string' && it.code.trim()
        ? it.code.trim().toUpperCase().slice(0, 16)
        : null,
      source,
      status,
      manually_edited: !!it?.manually_edited,
      updated_at: typeof it?.updated_at === 'string' ? it.updated_at.slice(0, 40) : null,
    };
  }).filter((it) => it.label || it.assessment || it.plan);
}

/** Accepted ICD only — never attach suggested-but-unreviewed codes to copy/render. */
export function acceptedCodeFromSuggestion(sug) {
  if (!sug || typeof sug !== 'object') return null;
  if (!sug.code) return null;
  // Accepted rows carry accepted_at; raw suggest payloads do not.
  if (sug.accepted_at || sug.coding_status === 'accepted') {
    return String(sug.code).trim().toUpperCase().slice(0, 16) || null;
  }
  // Legacy stored suggestions without accepted_at still count once on the problem.
  if (sug.accepted_by || sug.fy != null) {
    return String(sug.code).trim().toUpperCase().slice(0, 16) || null;
  }
  return null;
}

/**
 * Render clinician-facing A&P text. When include_icd, append accepted codes only
 * (never invent). Codes on items take precedence; otherwise look up by problem_id/label.
 */
export function renderPlanText(structured, { problems = [] } = {}) {
  if (!structured || !Array.isArray(structured.items) || !structured.items.length) return '';
  const includeIcd = !!structured.include_icd;
  const byId = new Map(problems.map((p) => [p.id, p]));
  const byLabel = new Map(
    problems.map((p) => [String(p.label || '').toLowerCase(), p]),
  );
  const lines = [];
  for (const it of normalizeItems(structured.items)) {
    let code = it.code;
    if (includeIcd && !code) {
      const p = (it.problem_id && byId.get(it.problem_id))
        || byLabel.get(String(it.label || '').toLowerCase());
      const sug = p?.code_suggestion
        ? (typeof p.code_suggestion === 'string' ? jsonParse(p.code_suggestion, null) : p.code_suggestion)
        : null;
      code = acceptedCodeFromSuggestion(sug);
    }
    const title = it.label
      ? (includeIcd && code ? `${it.label} (${code})` : it.label)
      : 'Assessment and Plan';
    lines.push(title);
    if (it.assessment) lines.push(`Assessment: ${it.assessment}`);
    if (it.plan) lines.push(`Plan: ${it.plan}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function buildStructuredFromBody(body, { problems = [] } = {}) {
  if (Array.isArray(body?.items)) {
    const items = normalizeItems(body.items);
    const include_icd = !!body.include_icd;
    // Attach accepted codes when toggle on and item lacks an explicit code.
    if (include_icd) {
      for (const it of items) {
        if (it.code) continue;
        const p = problems.find(
          (x) => x.id === it.problem_id
            || String(x.label || '').toLowerCase() === String(it.label || '').toLowerCase(),
        );
        const sug = p?.code_suggestion
          ? (typeof p.code_suggestion === 'string' ? jsonParse(p.code_suggestion, null) : p.code_suggestion)
          : null;
        const accepted = acceptedCodeFromSuggestion(sug);
        if (accepted) it.code = accepted;
      }
    } else {
      for (const it of items) it.code = null;
    }
    const structured = { version: 1, include_icd, items };
    return {
      structured,
      text: JSON.stringify(structured),
      plain_text: renderPlanText(structured, { problems }),
    };
  }
  return null;
}

/** Resolve plain text for clinician_plan / note inputs. */
export function planTextForContext(planRow, { problems = [], includeIcdOverride } = {}) {
  const parsed = parsePlanRecord(planRow);
  if (parsed.structured) {
    const structured = {
      ...parsed.structured,
      include_icd: includeIcdOverride === undefined
        ? parsed.structured.include_icd
        : !!includeIcdOverride,
    };
    return {
      text: renderPlanText(structured, { problems }),
      plan_date: parsed.plan_date,
      structured,
      include_icd: structured.include_icd,
    };
  }
  return {
    text: parsed.plain_text,
    plan_date: parsed.plan_date,
    structured: null,
    include_icd: false,
  };
}
