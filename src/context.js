import { all, get, run } from './db.js';
import { config } from './config.js';
import { jsonParse, today } from './util.js';

const isNum = (v) => /^-?\d+(\.\d+)?$/.test(String(v).trim());
const timeKey = (f) => f.event_time || '';

/** Differences are computed here, never by the model. */
export function computeTrends(facts) {
  const groups = new Map();
  for (const f of facts) {
    if (!isNum(f.value) || !f.event_time || f.assertion !== 'present') continue;
    const key = `${f.label.toLowerCase()}|${f.unit || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => timeKey(a).localeCompare(timeKey(b)));
    const a = list[0];
    const b = list[list.length - 1];
    const delta = Math.round((Number(b.value) - Number(a.value)) * 1000) / 1000;
    out.push({
      label: b.label, unit: b.unit || '',
      from: { value: a.value, event_time: a.event_time, fact_id: a.fact_id },
      to: { value: b.value, event_time: b.event_time, fact_id: b.fact_id },
      delta: String(delta), direction: delta > 0 ? 'rose' : delta < 0 ? 'fell' : 'unchanged',
    });
  }
  return out;
}

/** Same measurement, same time, different values; or present vs negated on the same day. */
export function detectConflicts(facts) {
  const out = [];
  const seen = new Map();
  for (const f of facts) {
    const day = (f.event_time || '').slice(0, 10);
    const k1 = `${f.label.toLowerCase()}|${f.event_time}`;
    if (isNum(f.value) && f.event_time) {
      const prev = seen.get(k1);
      if (prev && prev.value !== f.value) {
        out.push({ type: 'value_conflict', text: `${f.label} has different values at the same time (${prev.value} vs ${f.value}).`, fact_ids: [prev.fact_id, f.fact_id] });
      } else seen.set(k1, f);
    }
    const k2 = `${f.label.toLowerCase()}|${day}|${f.assertion === 'negated' ? 'neg' : f.assertion === 'present' ? 'pos' : 'unc'}`;
    const opposite = `${f.label.toLowerCase()}|${day}|${f.assertion === 'negated' ? 'pos' : 'neg'}`;
    if (day && seen.has(opposite) && f.assertion !== 'uncertain') {
      out.push({ type: 'assertion_conflict', text: `${f.label} is documented as both present and absent on ${day}.`, fact_ids: [seen.get(opposite).fact_id, f.fact_id] });
    }
    seen.set(k2, f);
  }
  return out;
}

const mapFact = (f) => ({
  fact_id: f.id, label: f.label, value: f.value, unit: f.unit || '', event_time: f.event_time || 'Unknown',
  source_id: f.source_id, source_passage: f.source_passage, assertion: f.assertion,
});

/**
 * Structured context package sent to the model. Contains NO direct identifiers (name, room).
 * Only clinician-confirmed facts are included.
 */
export function buildContext(patient, { date = today() } = {}) {
  const rows = all(
    "SELECT * FROM facts WHERE patient_id=? AND reviewer_status='confirmed' ORDER BY COALESCE(event_time,'') DESC, created_at DESC",
    patient.id,
  );
  const unreviewed = get("SELECT COUNT(*) AS n FROM facts WHERE patient_id=? AND reviewer_status='pending'", patient.id).n;
  const max = config.limits.maxContextFacts;
  const truncated = rows.length > max;
  const kept = rows.slice(0, max).reverse().map(mapFact); // oldest -> newest
  const plan = get('SELECT * FROM plans WHERE patient_id=? AND plan_date=? ORDER BY created_at DESC LIMIT 1', patient.id, date);
  const problems = all("SELECT id,label,state,fact_ids,uncertainty FROM problems WHERE patient_id=? AND state IN ('confirmed','differential') ORDER BY created_at", patient.id)
    .map((p) => ({ ...p, fact_ids: jsonParse(p.fact_ids, []) }));
  const missing = [];
  if (!plan) missing.push('clinician_plan');
  if (unreviewed > 0) missing.push(`${unreviewed} extracted fact(s) not yet reviewed (excluded)`);
  if (kept.some((f) => f.event_time === 'Unknown')) missing.push('some facts have no event time');
  if (kept.length === 0) missing.push('no reviewed chart facts');
  return {
    patient_id: patient.id,
    team_id: patient.team_id,
    age_band: patient.age_band || null,
    sex: patient.sex || null,
    selected_date: date,
    context_revision: patient.revision,
    facts: kept,
    clinician_plan: plan ? { text: plan.text, plan_date: plan.plan_date } : null,
    problems,
    trends: computeTrends(kept),
    conflicts: detectConflicts(kept),
    missing_information: missing,
    truncated,
    excluded_manifest: truncated ? { count: rows.length - max, reason: 'context size limit; oldest facts omitted' } : null,
  };
}

/** Bump the patient's context revision and mark older generated artifacts Outdated (never rewritten). */
export function bumpRevision(patientId) {
  run('UPDATE patients SET revision=revision+1 WHERE id=?', patientId);
  const rev = get('SELECT revision FROM patients WHERE id=?', patientId).revision;
  run('UPDATE artifacts SET outdated=1 WHERE patient_id=? AND context_revision<? AND outdated=0', patientId, rev);
  return rev;
}

/** What changed since the last clinician-reviewed summary. Fully deterministic. */
export function changesSince(patient) {
  const since = patient.last_reviewed_revision;
  if (!since) return { status: 'no_baseline', message: 'No reviewed summary yet. Review a summary to create the baseline.' };
  const ctx = buildContext(patient);
  const newFacts = all("SELECT * FROM facts WHERE patient_id=? AND reviewer_status='confirmed' AND revision>? ORDER BY COALESCE(event_time,'')", patient.id, since).map(mapFact);
  const ids = new Set(newFacts.map((f) => f.fact_id));
  return {
    status: 'ok', computed_in_code: true,
    since_revision: since, current_revision: patient.revision,
    new_facts: newFacts,
    trends: ctx.trends.filter((t) => ids.has(t.to.fact_id)),
    conflicts: ctx.conflicts.filter((c) => c.fact_ids.some((id) => ids.has(id))),
    nothing_new: newFacts.length === 0,
  };
}
