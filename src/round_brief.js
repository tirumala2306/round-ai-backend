import { all, get, audit } from './db.js';
import { HttpError, need, str, isIsoDate, today, jsonParse } from './util.js';
import { buildContext, changesSince } from './context.js';
import { matchedReminders } from './check_rules.js';
import { config } from './config.js';

function summaryState(patientId) {
  const a = get("SELECT outdated, review_state FROM artifacts WHERE patient_id=? AND operation='summarize_patient' ORDER BY created_at DESC LIMIT 1", patientId);
  if (!a) return 'Not generated';
  if (a.outdated) return 'Outdated';
  return a.review_state === 'reviewed' ? 'Reviewed' : 'Draft ready';
}

function pendingItems(patientId) {
  return all(
    `SELECT id, label, value, unit, event_time, assertion, source_id, source_passage
     FROM facts WHERE patient_id=? AND reviewer_status='confirmed'
       AND (lower(value) LIKE '%pending%' OR lower(value) LIKE '%awaiting%' OR lower(value) LIKE '%ordered%'
            OR lower(label) LIKE '%pending%' OR lower(label) LIKE '%awaiting%')
     ORDER BY COALESCE(event_time,''), created_at`,
    patientId,
  ).map((f) => ({
    fact_id: f.id, label: f.label, value: f.value, unit: f.unit || '',
    event_time: f.event_time, assertion: f.assertion, source_id: f.source_id, source_passage: f.source_passage,
  }));
}

function tasksForDay(patientId, day) {
  const rows = all(
    "SELECT id, text, owner, due, state FROM tasks WHERE patient_id=? AND state IN ('proposed','open') ORDER BY created_at",
    patientId,
  );
  return rows.map((t) => {
    const due = t.due || '';
    const overdue = !!(due && /^\d{4}-\d{2}-\d{2}/.test(due) && due.slice(0, 10) < day);
    const due_today = !!(due && due.slice(0, 10) === day);
    return { id: t.id, text: t.text, owner: t.owner, due: t.due, state: t.state, due_today, overdue };
  });
}

function teamPatients(userId, teamId) {
  if (teamId) {
    need(get('SELECT 1 AS x FROM team_members WHERE team_id=? AND user_id=?', teamId, userId), 403, 'access_denied', 'You are not a member of that team');
    return all(
      `SELECT * FROM patients WHERE team_id=?
       ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order, room, display_name`,
      teamId,
    );
  }
  return all(
    `SELECT p.* FROM patients p JOIN team_members m ON m.team_id=p.team_id WHERE m.user_id=?
     ORDER BY CASE WHEN p.sort_order IS NULL THEN 1 ELSE 0 END, p.sort_order, p.room, p.display_name`,
    userId,
  );
}

/**
 * Deterministic day brief for the clinician's team. No AI ranking or urgency.
 */
export function buildRoundBrief({ user, date, teamId = null }) {
  const day = str(date, 10) || today();
  need(isIsoDate(day), 400, 'bad_date', 'date must be YYYY-MM-DD');
  const patients = teamPatients(user.id, teamId);
  let unreviewed_facts = 0;
  let outdated_summaries = 0;
  const cards = [];

  for (const p of patients) {
    const ctx = buildContext(p, { date: day });
    const changes = changesSince(p);
    const reminders = matchedReminders({ patient: p, day, userId: user.id });
    const unreviewed = get("SELECT COUNT(*) AS n FROM facts WHERE patient_id=? AND reviewer_status='pending'", p.id).n;
    unreviewed_facts += unreviewed;
    const state = summaryState(p.id);
    if (state === 'Outdated') outdated_summaries += 1;

    const yesterday_comparisons = (reminders.reminders || [])
      .filter((r) => r.compare_yesterday)
      .map((r) => ({
        rule_id: r.rule_id,
        rule_name: r.name,
        frame: r.frame,
        compare: r.compare_yesterday,
      }));

    cards.push({
      patient_id: p.id,
      display_name: p.display_name,
      room: p.room || '',
      age_band: p.age_band || '',
      sex: p.sex || '',
      sort_order: p.sort_order,
      team_id: p.team_id,
      summary_state: state,
      revision: p.revision,
      last_reviewed_revision: p.last_reviewed_revision,
      unreviewed_facts: unreviewed,
      what_changed: {
        status: changes.status,
        message: changes.message || null,
        computed_in_code: true,
        new_facts: changes.new_facts || [],
        trends: changes.trends || [],
        conflicts: changes.conflicts || [],
        nothing_new: changes.nothing_new ?? null,
      },
      trends: ctx.trends,
      conflicts: ctx.conflicts,
      pending_items: pendingItems(p.id),
      tasks: tasksForDay(p.id, day),
      reminders: reminders.reminders,
      yesterday_comparisons,
      missing_information: ctx.missing_information,
      plan_today: ctx.clinician_plan,
      problems: ctx.problems.map((pr) => ({ id: pr.id, label: pr.label, state: pr.state })),
      // Explicitly absent fields — never AI urgency:
      // urgency / acuity / risk_score are not included
    });
  }

  audit(user.id, 'round_brief', { detail: { date: day, patients: cards.length } });
  return {
    date: day,
    assembled_in_code: true,
    ordering: 'sort_order_then_room',
    counts: {
      patients: cards.length,
      unreviewed_facts,
      outdated_summaries,
    },
    patients: cards,
    note: 'Day brief assembled in code from the chart. No AI ranking or urgency. Reminders are prompts for your consideration only.',
  };
}

/**
 * Pre-generate oral presentations for selected patients.
 * Respects the per-user daily AI cap; returns partial results with explicit failures (never silent skip).
 */
export async function prepareRoundBrief({ user, body, presentPatient }) {
  const day = str(body?.date, 10) || today();
  need(isIsoDate(day), 400, 'bad_date', 'date must be YYYY-MM-DD');
  const ids = Array.isArray(body?.patient_ids) ? body.patient_ids.map((x) => str(x, 64)).filter(Boolean).slice(0, 50) : [];
  need(ids.length, 400, 'patient_ids_required', 'patient_ids required');

  const usage = get('SELECT calls FROM ai_usage WHERE user_id=? AND day=?', user.id, today());
  const used = usage?.calls || 0;
  const cap = config.limits.maxCallsPerUserPerDay;
  const remaining = Math.max(0, cap - used);

  const results = [];
  let attempted = 0;
  for (const patientId of ids) {
    if (attempted >= remaining) {
      results.push({
        patient_id: patientId,
        ok: false,
        error: { code: 'daily_limit', message: 'Daily AI usage limit reached. Presentation not generated.' },
      });
      continue;
    }
    const patient = get('SELECT * FROM patients WHERE id=?', patientId);
    if (!patient) {
      results.push({ patient_id: patientId, ok: false, error: { code: 'not_found', message: 'Patient not found' } });
      continue;
    }
    const member = get('SELECT 1 AS x FROM team_members WHERE team_id=? AND user_id=?', patient.team_id, user.id);
    if (!member) {
      results.push({ patient_id: patientId, ok: false, error: { code: 'access_denied', message: 'You do not have access to this patient' } });
      continue;
    }
    attempted += 1;
    try {
      const envelope = await presentPatient({ user, patient, date: day });
      results.push({
        patient_id: patientId,
        ok: true,
        artifact_id: envelope.artifact_id,
        status: envelope.status,
        word_count: envelope.content?.word_count,
        requires_review: true,
      });
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 'present_failed';
      const message = e instanceof HttpError ? e.message : 'Presentation generation failed';
      results.push({ patient_id: patientId, ok: false, error: { code, message } });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  audit(user.id, 'round_brief_prepare', { detail: { date: day, requested: ids.length, ok, failed, remaining_before: remaining } });
  return {
    date: day,
    requested: ids.length,
    generated: ok,
    failed,
    daily_cap: cap,
    calls_remaining_before: remaining,
    results,
    note: 'Partial results are returned explicitly. Failures are never silently skipped. Presentations remain AI drafts requiring review.',
  };
}
