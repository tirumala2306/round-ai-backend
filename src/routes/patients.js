import { all, get, run, tx, audit } from '../db.js';
import { authorizePatient } from '../auth.js';
import { HttpError, uid, nowIso, today, need, str, jsonParse, isIsoDate } from '../util.js';
import { bumpRevision, changesSince, buildContext } from '../context.js';
import { toEnvelope, decideProblem } from '../ai/orchestrator.js';
import { matchedReminders, ackReminder } from '../check_rules.js';
import { today as todayFn } from '../util.js';
import { ensurePatientChannel } from '../chat.js';
import { isIdentityFact } from '../ai/validators.js';
import { buildStructuredFromBody, parsePlanRecord, planTextForContext } from '../plan.js';

export function authorizeArtifact(user, id) {
  const row = get('SELECT * FROM artifacts WHERE id=?', id);
  if (!row) throw new HttpError(404, 'not_found', 'Artifact not found');
  if (row.patient_id) authorizePatient(user, row.patient_id);
  else if (row.created_by !== user.id) throw new HttpError(403, 'access_denied', 'Not your artifact');
  return row;
}

function summaryState(patientId) {
  const a = get("SELECT outdated, review_state FROM artifacts WHERE patient_id=? AND operation='summarize_patient' ORDER BY created_at DESC LIMIT 1", patientId);
  if (!a) return 'Not generated';
  if (a.outdated) return 'Outdated';
  return a.review_state === 'reviewed' ? 'Reviewed' : 'Draft ready';
}

/** Snapshot for FE stores after mutations — no extra refetch required. */
export function patientStatus(patientId) {
  const p = get('SELECT id, revision FROM patients WHERE id=?', patientId);
  if (!p) return null;
  return {
    patient_id: p.id,
    summary_state: summaryState(p.id),
    unreviewed_facts: Number(get("SELECT COUNT(*) AS n FROM facts WHERE patient_id=? AND reviewer_status='pending'", p.id)?.n || 0),
    open_tasks: Number(get("SELECT COUNT(*) AS n FROM tasks WHERE patient_id=? AND state='open'", p.id)?.n || 0),
    revision: Number(p.revision || 0),
  };
}

function withPatientStatus(patientId, body) {
  return { ...body, patient_status: patientStatus(patientId) };
}

const PLACEHOLDER = /\[[^\]]*not entered\]/i;

function plainText(content) {
  if (content.sections && content.note_type) return content.sections.map((s) => `${s.title.toUpperCase()}\n${s.text}`).join('\n\n');
  if (content.summary) {
    const lines = [...content.summary.map((c) => c.text)];
    const act = content.outstanding_actions.map((c) => `- ${c.text}`);
    return [`SUMMARY\n${lines.join('\n')}`, act.length ? `OUTSTANDING\n${act.join('\n')}` : '', content.contingencies.length ? `IF / THEN\n${content.contingencies.map((c) => `- ${c}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
  }
  throw new HttpError(400, 'not_exportable', 'This artifact type cannot be exported as text.');
}

export function patientRoutes(r) {
  /* ---------- census ---------- */
  r.get('/patients', ({ user }) =>
    all(`SELECT p.* FROM patients p JOIN team_members m ON m.team_id=p.team_id WHERE m.user_id=?
         ORDER BY CASE WHEN p.sort_order IS NULL THEN 1 ELSE 0 END, p.sort_order, p.room, p.display_name`, user.id).map((p) => {
      const problems = all(
        "SELECT label FROM problems WHERE patient_id=? AND state IN ('confirmed','differential') ORDER BY created_at LIMIT 3",
        p.id,
      ).map((x) => x.label);
      const ctx = buildContext(p);
      const keyChanges = (ctx.trends || []).slice(0, 3).map((t) => t.text).filter(Boolean);
      const oneLiner = [
        p.age_band && p.sex ? `${p.age_band} ${p.sex}` : (p.age_band || p.sex || ''),
        problems[0] ? `with ${problems[0]}` : '',
      ].filter(Boolean).join(' ').trim();
      return {
        id: p.id, display_name: p.display_name, room: p.room, age_band: p.age_band, sex: p.sex, team_id: p.team_id,
        sort_order: p.sort_order,
        summary_state: summaryState(p.id), // AI never assigns urgency or ordering
        unreviewed_facts: get("SELECT COUNT(*) AS n FROM facts WHERE patient_id=? AND reviewer_status='pending'", p.id).n,
        open_tasks: get("SELECT COUNT(*) AS n FROM tasks WHERE patient_id=? AND state='open'", p.id).n,
        one_liner: oneLiner || null,
        key_changes: keyChanges,
        active_problems: problems,
      };
    }));

  r.post('/patients', ({ user, body }) => {
    const teamId = str(body.team_id, 64);
    need(get('SELECT 1 AS x FROM team_members WHERE team_id=? AND user_id=?', teamId, user.id), 403, 'access_denied', 'You are not a member of that team');
    const name = str(body.display_name, 120);
    need(name, 400, 'name_required', 'display_name is required (use fictional data in development)');
    const id = uid();
    const sortOrder = body.sort_order === null || body.sort_order === undefined || body.sort_order === ''
      ? null
      : Number(body.sort_order);
    need(sortOrder === null || (Number.isInteger(sortOrder) && sortOrder >= 0 && sortOrder < 100000), 400, 'bad_sort', 'sort_order must be a non-negative integer');
    run('INSERT INTO patients(id,team_id,display_name,room,age_band,sex,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?)',
      id, teamId, name, str(body.room, 20), str(body.age_band, 20), str(body.sex, 20), sortOrder, nowIso());
    audit(user.id, 'patient_create', { patient_id: id });
    const patient = get('SELECT * FROM patients WHERE id=?', id);
    ensurePatientChannel({ patient, createdBy: user.id });
    return { id, sort_order: sortOrder };
  });

  r.patch('/patients/:id', ({ user, params, body }) => {
    const p = authorizePatient(user, params.id);
    const updates = [];
    const vals = [];
    if (body.sort_order !== undefined) {
      const sortOrder = body.sort_order === null || body.sort_order === '' ? null : Number(body.sort_order);
      need(sortOrder === null || (Number.isInteger(sortOrder) && sortOrder >= 0 && sortOrder < 100000), 400, 'bad_sort', 'sort_order must be a non-negative integer or null');
      updates.push('sort_order=?');
      vals.push(sortOrder);
    }
    if (body.room !== undefined) { updates.push('room=?'); vals.push(str(body.room, 20) || null); }
    if (body.display_name !== undefined) {
      const name = str(body.display_name, 120);
      need(name, 400, 'name_required', 'display_name cannot be empty');
      updates.push('display_name=?');
      vals.push(name);
    }
    need(updates.length, 400, 'nothing_to_update', 'Provide sort_order, room, and/or display_name');
    vals.push(p.id);
    run(`UPDATE patients SET ${updates.join(', ')} WHERE id=?`, ...vals);
    audit(user.id, 'patient_patch', { patient_id: p.id, detail: { fields: updates.map((u) => u.split('=')[0]) } });
    const row = get('SELECT id,display_name,room,age_band,sex,sort_order,team_id FROM patients WHERE id=?', p.id);
    return row;
  });

  r.get('/patients/:id', ({ user, params }) => {
    const p = authorizePatient(user, params.id);
    audit(user.id, 'patient_view', { patient_id: p.id });
    const ctx = buildContext(p);
    const problems = all(
      "SELECT id,label,state,fact_ids,uncertainty,code_suggestion FROM problems WHERE patient_id=? AND state!='rejected' ORDER BY created_at",
      p.id,
    ).map((x) => ({
      ...x,
      fact_ids: jsonParse(x.fact_ids, []),
      code_suggestion: jsonParse(x.code_suggestion, null),
    }));
    return {
      id: p.id, display_name: p.display_name, room: p.room, age_band: p.age_band, sex: p.sex, sort_order: p.sort_order,
      revision: p.revision, last_reviewed_revision: p.last_reviewed_revision, summary_state: summaryState(p.id),
      // Rendered plain text (ICD applied when include_icd was saved).
      plan_today: ctx.clinician_plan,
      plan_structured: ctx.clinician_plan?.structured || null,
      problems,
      missing_information: ctx.missing_information, trends: ctx.trends, conflicts: ctx.conflicts,
      tasks: all("SELECT id,text,owner,due,state FROM tasks WHERE patient_id=? AND state IN ('proposed','open') ORDER BY created_at", p.id),
    };
  });

  /* ---------- sources & facts ---------- */
  r.post('/patients/:id/sources', ({ user, params, body }) => {
    const p = authorizePatient(user, params.id);
    const text = str(body.text, 100_000);
    need(text, 400, 'text_required', 'text is required');
    const eventTime = body.event_time ? str(body.event_time, 25) : null;
    need(!eventTime || isIsoDate(eventTime), 400, 'bad_time', 'event_time must be ISO date/time');
    const id = uid();
    run('INSERT INTO sources(id,patient_id,kind,title,event_time,uploaded_at,text) VALUES(?,?,?,?,?,?,?)', id, p.id, str(body.kind, 40) || 'note', str(body.title, 200), eventTime, nowIso(), text);
    audit(user.id, 'source_add', { patient_id: p.id, detail: { source_id: id } });
    return { id };
  });

  r.get('/patients/:id/sources', ({ user, params }) => {
    authorizePatient(user, params.id);
    return all('SELECT id,kind,title,event_time,uploaded_at FROM sources WHERE patient_id=? ORDER BY COALESCE(event_time,uploaded_at)', params.id);
  });

  r.get('/patients/:id/facts', ({ user, params, query }) => {
    authorizePatient(user, params.id);
    const status = ['pending', 'confirmed', 'rejected'].includes(query.status) ? query.status : null;
    return all(
      `SELECT id,label,value,unit,event_time,source_id,source_passage,assertion,reviewer_status,qualifier,warnings_json
       FROM facts WHERE patient_id=? ${status ? 'AND reviewer_status=?' : ''}
       ORDER BY COALESCE(event_time,'') , created_at`,
      ...(status ? [params.id, status] : [params.id]),
    ).map((f) => ({
      ...f,
      warnings: jsonParse(f.warnings_json, []),
      warnings_json: undefined,
    }));
  });

  /** Inline edit of a pending fact (label/value/qualifier/event_time). */
  r.patch('/facts/:id', ({ user, params, body }) => {
    const f = get('SELECT * FROM facts WHERE id=?', params.id);
    need(f, 404, 'not_found', 'Fact not found');
    authorizePatient(user, f.patient_id);
    need(f.reviewer_status === 'pending', 400, 'not_pending', 'Only pending facts can be edited.');
    const label = body.label != null ? str(body.label, 120) : f.label;
    const value = body.value != null ? str(body.value, 1000) : f.value;
    need(label && value, 400, 'fact_required', 'label and value are required');
    need(!isIdentityFact(label, value), 400, 'identity_fact_excluded', 'Identity fields cannot be stored as clinical facts.');
    const unit = body.unit != null ? str(body.unit, 20) : (f.unit || '');
    const qualifier = body.qualifier != null ? str(body.qualifier, 120) : (f.qualifier || '');
    if (qualifier) {
      need(
        String(f.source_passage || '').toLowerCase().includes(qualifier.toLowerCase()),
        400,
        'qualifier_not_in_passage',
        'Qualifier must appear in the source passage.',
      );
    }
    let eventTime = f.event_time;
    if (body.event_time !== undefined) {
      eventTime = body.event_time ? str(body.event_time, 25) : null;
      need(!eventTime || isIsoDate(eventTime), 400, 'bad_time', 'event_time must be ISO date/time');
    }
    run(
      'UPDATE facts SET label=?, value=?, unit=?, qualifier=?, event_time=? WHERE id=?',
      label, value, unit, qualifier || null, eventTime, f.id,
    );
    return {
      id: f.id, label, value, unit, qualifier: qualifier || null, event_time: eventTime,
      source_passage: f.source_passage, reviewer_status: f.reviewer_status,
      warnings: jsonParse(f.warnings_json, []),
    };
  });

  // Manual entry by a clinician is confirmed immediately and is its own source.
  r.post('/patients/:id/facts', ({ user, params, body }) => {
    const p = authorizePatient(user, params.id);
    const label = str(body.label, 120);
    const value = str(body.value, 1000);
    need(label && value, 400, 'fact_required', 'label and value are required');
    need(!isIdentityFact(label, value), 400, 'identity_fact_excluded', 'Patient name, MRN, visit date, and other identity fields cannot be stored as clinical facts.');
    const eventTime = body.event_time ? str(body.event_time, 25) : null;
    need(!eventTime || isIsoDate(eventTime), 400, 'bad_time', 'event_time must be ISO date/time');
    const assertion = ['present', 'negated', 'uncertain'].includes(body.assertion) ? body.assertion : 'present';
    const unit = str(body.unit, 20);
    const passage = `${label}: ${value}${unit ? ' ' + unit : ''}`;
    const factId = uid();
    tx(() => {
      const sid = uid();
      run('INSERT INTO sources(id,patient_id,kind,title,event_time,uploaded_at,text) VALUES(?,?,?,?,?,?,?)', sid, p.id, 'clinician_entry', 'Manual entry', eventTime, nowIso(), passage);
      const rev = bumpRevision(p.id);
      run(`INSERT INTO facts(id,patient_id,label,value,unit,event_time,source_id,source_passage,assertion,reviewer_status,revision,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,'confirmed',?,?)`, factId, p.id, label, value, unit, eventTime, sid, passage, assertion, rev, nowIso());
    });
    audit(user.id, 'fact_manual', { patient_id: p.id });
    return { id: factId };
  });

  r.post('/patients/:id/facts/review', ({ user, params, body }) => {
    const p = authorizePatient(user, params.id);
    const status = body.status;
    need(['confirmed', 'rejected'].includes(status), 400, 'bad_status', 'status must be confirmed or rejected');
    const ids = Array.isArray(body.fact_ids) ? body.fact_ids.slice(0, 500) : [];
    need(ids.length, 400, 'ids_required', 'fact_ids required');
    const rev = tx(() => {
      let touched = 0;
      let rejectedIdentity = 0;
      for (const id of ids) {
        const f = get('SELECT * FROM facts WHERE id=? AND patient_id=?', id, p.id);
        if (!f || f.reviewer_status === status) continue;
        // Never promote identity/demographics into confirmed chart facts.
        if (status === 'confirmed' && isIdentityFact(f.label, f.value)) {
          run("UPDATE facts SET reviewer_status='rejected' WHERE id=?", id);
          rejectedIdentity += 1;
          touched += 1;
          continue;
        }
        touched += 1;
        run('UPDATE facts SET reviewer_status=? WHERE id=?', status, id);
      }
      if (!touched) return p.revision;
      const newRev = bumpRevision(p.id);
      for (const id of ids) run("UPDATE facts SET revision=? WHERE id=? AND patient_id=? AND reviewer_status='confirmed'", newRev, id, p.id);
      if (rejectedIdentity) {
        audit(user.id, 'fact_identity_auto_rejected', { patient_id: p.id, detail: { count: rejectedIdentity } });
      }
      return newRev;
    });
    audit(user.id, `fact_${status}`, { patient_id: p.id, detail: { count: ids.length } });
    return withPatientStatus(p.id, { context_revision: rev });
  });

  r.get('/facts/:id/source', ({ user, params }) => {
    const f = get('SELECT * FROM facts WHERE id=?', params.id);
    need(f, 404, 'not_found', 'Fact not found');
    authorizePatient(user, f.patient_id);
    const s = get('SELECT id,kind,title,event_time,uploaded_at,text FROM sources WHERE id=?', f.source_id);
    return { fact_id: f.id, passage: f.source_passage, source: { id: s.id, kind: s.kind, title: s.title, event_time: s.event_time, uploaded_at: s.uploaded_at }, context_text: s.text };
  });

  /* ---------- plan ---------- */
  r.put('/patients/:id/plan', ({ user, params, body }) => {
    const p = authorizePatient(user, params.id);
    const date = str(body.plan_date, 10) || today();
    need(isIsoDate(date), 400, 'bad_date', 'plan_date must be YYYY-MM-DD');
    const problems = all(
      "SELECT id,label,state,code_suggestion FROM problems WHERE patient_id=? AND state!='rejected'",
      p.id,
    ).map((x) => ({ ...x, code_suggestion: jsonParse(x.code_suggestion, null) }));

    let storeText = '';
    let rendered = '';
    let structuredOut = null;
    const fromItems = buildStructuredFromBody(body, { problems });
    if (fromItems) {
      storeText = fromItems.text;
      rendered = fromItems.plain_text;
      structuredOut = fromItems.structured;
      need(fromItems.structured.items.length, 400, 'text_required', 'At least one Assessment and Plan item is required');
    } else {
      // Legacy: `text`, or `plan_today` as string / line list / { text }.
      let text = str(body.text, 10000);
      if (!text) {
        const raw = body.plan_today;
        if (typeof raw === 'string') text = str(raw, 10000);
        else if (Array.isArray(raw)) text = str(raw.map((x) => String(x ?? '').trim()).filter(Boolean).join('\n'), 10000);
        else if (raw && typeof raw === 'object') text = str(raw.text, 10000);
      }
      need(text, 400, 'text_required', 'text is required');
      storeText = text;
      rendered = text;
    }

    const rev = bumpRevision(p.id);
    run('INSERT INTO plans(id,patient_id,plan_date,text,author_id,revision,created_at) VALUES(?,?,?,?,?,?,?)', uid(), p.id, date, storeText, user.id, rev, nowIso());
    audit(user.id, 'plan_save', { patient_id: p.id, detail: { structured: !!structuredOut } });
    return withPatientStatus(p.id, {
      context_revision: rev,
      plan_today: { text: rendered, plan_date: date, include_icd: !!structuredOut?.include_icd },
      plan_structured: structuredOut,
    });
  });

  /** Latest extract_facts A&P proposals for this patient (dictation / photo intake). */
  r.get('/patients/:id/plan-proposals', ({ user, params }) => {
    authorizePatient(user, params.id);
    const a = get(
      "SELECT id, content, created_at FROM artifacts WHERE patient_id=? AND operation='extract_facts' ORDER BY created_at DESC LIMIT 1",
      params.id,
    );
    if (!a) return { artifact_id: null, proposals: [], warnings: [] };
    const content = jsonParse(a.content, {});
    return {
      artifact_id: a.id,
      proposals: Array.isArray(content.plan_proposals) ? content.plan_proposals : [],
      warnings: Array.isArray(content.warnings) ? content.warnings : [],
      created_at: a.created_at,
    };
  });

  /**
   * Accept selected dictation A&P proposals into today's structured plan
   * (pre-filled; clinician still owns the wording).
   */
  r.post('/patients/:id/plan-proposals/accept', ({ user, params, body }) => {
    const p = authorizePatient(user, params.id);
    const selected = Array.isArray(body.proposals) ? body.proposals : [];
    need(selected.length, 400, 'proposals_required', 'At least one proposal is required');
    const date = str(body.plan_date, 10) || today();
    need(isIsoDate(date), 400, 'bad_date', 'plan_date must be YYYY-MM-DD');
    const existing = get(
      'SELECT * FROM plans WHERE patient_id=? AND plan_date=? ORDER BY created_at DESC LIMIT 1',
      p.id, date,
    );
    const parsed = parsePlanRecord(existing);
    const items = [...(parsed.structured?.items || parsed.items || [])];
    for (const prop of selected.slice(0, 20)) {
      const planText = str(prop.plan_text, 4000) || str(prop.plan, 4000);
      if (!planText) continue;
      items.push({
        problem_id: typeof prop.problem_id === 'string' ? prop.problem_id : null,
        label: str(prop.title || prop.label, 200) || 'General',
        assessment: str(prop.assessment_text || prop.assessment, 4000),
        plan: planText,
        code: null,
      });
      if (prop.is_new_problem && prop.title) {
        const label = str(prop.title, 200);
        const dup = get(
          "SELECT id FROM problems WHERE patient_id=? AND lower(label)=lower(?) AND state!='rejected' LIMIT 1",
          p.id, label,
        );
        if (!dup) {
          run(
            "INSERT INTO problems(id,patient_id,label,state,fact_ids,uncertainty,created_at,updated_at) VALUES(?,?,?,'differential','[]',?,?,?)",
            uid(), p.id, label, 'new, not confirmed — from dictation', nowIso(), nowIso(),
          );
        }
      }
    }
    need(items.length, 400, 'text_required', 'At least one Assessment and Plan item is required');
    const structured = { version: 1, include_icd: !!parsed.include_icd, items };
    const storeText = JSON.stringify(structured);
    const rendered = items.map((it) => {
      const head = it.label ? it.label.toUpperCase() : 'PLAN';
      const bits = [it.assessment, it.plan].filter(Boolean);
      return `${head}\n${bits.join('\n')}`;
    }).join('\n\n');
    const rev = bumpRevision(p.id);
    run(
      'INSERT INTO plans(id,patient_id,plan_date,text,author_id,revision,created_at) VALUES(?,?,?,?,?,?,?)',
      uid(), p.id, date, storeText, user.id, rev, nowIso(),
    );
    audit(user.id, 'plan_proposals_accept', { patient_id: p.id, detail: { count: selected.length } });
    return withPatientStatus(p.id, {
      context_revision: rev,
      plan_today: { text: rendered, plan_date: date, include_icd: !!structured.include_icd },
      plan_structured: structured,
    });
  });

  /* ---------- problems ---------- */
  r.get('/patients/:id/problems', ({ user, params }) => {
    authorizePatient(user, params.id);
    return all('SELECT id,label,state,fact_ids,uncertainty,code_suggestion,updated_at FROM problems WHERE patient_id=? ORDER BY created_at', params.id)
      .map((x) => ({ ...x, fact_ids: jsonParse(x.fact_ids, []), code_suggestion: jsonParse(x.code_suggestion, null) }));
  });
  r.post('/patients/:id/problems/:pid/decision', ({ user, params, body }) => {
    const p = authorizePatient(user, params.id);
    return withPatientStatus(p.id, decideProblem({ user, patient: p, problemId: params.pid, action: body.action }));
  });

  /* ---------- tasks ---------- */
  r.get('/patients/:id/tasks', ({ user, params }) => {
    authorizePatient(user, params.id);
    return all('SELECT id,text,owner,due,plan_quote,state FROM tasks WHERE patient_id=? ORDER BY created_at', params.id);
  });
  r.post('/patients/:id/tasks', ({ user, params, body }) => {
    const p = authorizePatient(user, params.id);
    const text = str(body.text, 300) || str(body.title, 300);
    need(text, 400, 'text_required', 'text is required');
    const id = uid();
    run("INSERT INTO tasks(id,patient_id,text,owner,due,state,accepted_by,created_at) VALUES(?,?,?,?,?, 'open',?,?)", id, p.id, text, str(body.owner, 80) || null, str(body.due, 40) || null, user.id, nowIso());
    return withPatientStatus(p.id, { id });
  });
  const taskAction = (state) => ({ user, params, body }) => {
    const t = get('SELECT * FROM tasks WHERE id=?', params.id);
    need(t, 404, 'not_found', 'Task not found');
    authorizePatient(user, t.patient_id);
    if (state === 'open') {
      run("UPDATE tasks SET state='open', accepted_by=?, owner=COALESCE(?,owner), due=COALESCE(?,due) WHERE id=?", user.id, str(body.owner, 80) || null, str(body.due, 40) || null, t.id);
    } else run('UPDATE tasks SET state=? WHERE id=?', state, t.id);
    audit(user.id, `task_${state}`, { patient_id: t.patient_id });
    return withPatientStatus(t.patient_id, { id: t.id, state });
  };
  r.post('/tasks/:id/accept', taskAction('open'));
  r.post('/tasks/:id/dismiss', taskAction('dismissed'));
  r.post('/tasks/:id/complete', taskAction('done'));

  /* ---------- changes ---------- */
  r.get('/patients/:id/changes', ({ user, params }) => changesSince(authorizePatient(user, params.id)));

  /* ---------- reminders (approved check-rules only; never orders) ---------- */
  r.get('/patients/:id/reminders', ({ user, params, query }) => {
    const p = authorizePatient(user, params.id);
    const day = str(query.date, 10) || todayFn();
    need(isIsoDate(day), 400, 'bad_date', 'date must be YYYY-MM-DD');
    return matchedReminders({ patient: p, day, userId: user.id });
  });
  r.post('/patients/:id/reminders/:ruleId/ack', ({ user, params, body }) => {
    const p = authorizePatient(user, params.id);
    const day = str(body?.date, 10) || todayFn();
    need(isIsoDate(day), 400, 'bad_date', 'date must be YYYY-MM-DD');
    return ackReminder({ user, patient: p, ruleId: params.ruleId, body: body || {}, day });
  });

  /* ---------- artifacts ---------- */
  r.get('/patients/:id/artifacts', ({ user, params, query }) => {
    authorizePatient(user, params.id);
    const rows = query.operation
      ? all('SELECT * FROM artifacts WHERE patient_id=? AND operation LIKE ? ORDER BY created_at DESC LIMIT 50', params.id, `${query.operation}%`)
      : all('SELECT * FROM artifacts WHERE patient_id=? ORDER BY created_at DESC LIMIT 50', params.id);
    return rows.map((x) => { const e = toEnvelope(x); delete e.content; return e; });
  });

  r.get('/artifacts/:id', ({ user, params }) => toEnvelope(authorizeArtifact(user, params.id)));

  r.get('/artifacts/:id/versions', ({ user, params }) => {
    authorizeArtifact(user, params.id);
    return all('SELECT version,edited_by,created_at,content FROM artifact_versions WHERE artifact_id=? ORDER BY version', params.id).map((v) => ({ ...v, content: jsonParse(v.content) }));
  });

  /** Restore a prior clinician-edited note version (creates a new version snapshot). */
  r.post('/artifacts/:id/versions/:version/restore', ({ user, params }) => {
    const a = authorizeArtifact(user, params.id);
    const ver = Number(params.version);
    need(Number.isInteger(ver) && ver >= 1, 400, 'bad_version', 'version must be a positive integer');
    const snap = get(
      'SELECT version, content FROM artifact_versions WHERE artifact_id=? AND version=?',
      a.id, ver,
    );
    need(snap, 404, 'not_found', 'Version not found');
    const content = jsonParse(snap.content, {});
    need(Array.isArray(content.sections) && content.note_type, 400, 'not_restorable', 'Only note drafts can be restored');
    for (const s of content.sections) {
      s.manually_edited = true;
      s.edited = true;
    }
    const next = Number(get('SELECT MAX(version) AS v FROM artifact_versions WHERE artifact_id=?', a.id)?.v || 0) + 1;
    tx(() => {
      run(
        "UPDATE artifacts SET content=?, status='draft', review_state='draft', reviewed_by=NULL, reviewed_at=NULL, updated_at=? WHERE id=?",
        JSON.stringify(content), nowIso(), a.id,
      );
      run(
        'INSERT INTO artifact_versions(id,artifact_id,version,content,edited_by,created_at) VALUES(?,?,?,?,?,?)',
        uid(), a.id, next, JSON.stringify(content), user.id, nowIso(),
      );
    });
    audit(user.id, 'artifact_restore', { patient_id: a.patient_id, artifact_id: a.id, detail: { from_version: ver, version: next } });
    return toEnvelope(get('SELECT * FROM artifacts WHERE id=?', a.id));
  });

  // Clinician edits to note sections. Editing clears that section's flags and returns the note to draft.
  r.patch('/artifacts/:id', ({ user, params, body }) => {
    const a = authorizeArtifact(user, params.id);
    const content = jsonParse(a.content, {});
    need(Array.isArray(content.sections) && content.note_type, 400, 'not_editable', 'Only note drafts can be edited');
    for (const edit of Array.isArray(body.sections) ? body.sections : []) {
      const s = content.sections.find((x) => x.key === edit.key);
      need(s, 404, 'section_not_found', `Section ${edit.key} not found`);
      s.text = str(edit.text, 20000);
      s.flags = [];
      s.edited = true;
      s.manually_edited = true;
    }
    content.unresolved_flags = content.sections.reduce((n, s) => n + s.flags.length, 0);
    const version = get('SELECT MAX(version) AS v FROM artifact_versions WHERE artifact_id=?', a.id).v + 1;
    tx(() => {
      // Clinician edits clear soft-AI "partial" so review reflects human-owned draft text.
      run("UPDATE artifacts SET content=?, status='draft', review_state='draft', reviewed_by=NULL, reviewed_at=NULL, updated_at=? WHERE id=?", JSON.stringify(content), nowIso(), a.id);
      run('INSERT INTO artifact_versions(id,artifact_id,version,content,edited_by,created_at) VALUES(?,?,?,?,?,?)', uid(), a.id, version, JSON.stringify(content), user.id, nowIso());
    });
    audit(user.id, 'artifact_edit', { patient_id: a.patient_id, artifact_id: a.id, detail: { version } });
    return toEnvelope(get('SELECT * FROM artifacts WHERE id=?', a.id));
  });

  r.post('/artifacts/:id/review', ({ user, params }) => {
    const a = authorizeArtifact(user, params.id);
    need(['draft', 'partial'].includes(a.status), 409, 'not_reviewable', 'This artifact cannot be reviewed');
    need(!a.outdated, 409, 'outdated', 'The chart changed after this was generated. Regenerate before marking reviewed.');
    const content = jsonParse(a.content, {});
    if (content.sections && content.note_type) {
      const flagged = content.sections.filter((s) => s.flags?.length).map((s) => s.key);
      need(!flagged.length, 409, 'unresolved_flags', 'Resolve flagged sections (edit them) before marking reviewed.', { sections: flagged });
      const missing = content.sections.filter((s) => PLACEHOLDER.test(s.text)).map((s) => s.key);
      need(!missing.length, 409, 'placeholders_remaining', 'Fill in the sections that were not entered before marking reviewed.', { sections: missing });
    }
    run("UPDATE artifacts SET review_state='reviewed', reviewed_by=?, reviewed_at=?, updated_at=? WHERE id=?", user.id, nowIso(), nowIso(), a.id);
    if (a.operation === 'summarize_patient') run('UPDATE patients SET last_reviewed_revision=? WHERE id=?', a.context_revision, a.patient_id);
    audit(user.id, 'artifact_reviewed', { patient_id: a.patient_id, artifact_id: a.id });
    return toEnvelope(get('SELECT * FROM artifacts WHERE id=?', a.id));
  });

  // Clean copy for pasting into the EHR: no AI labels, only after clinician review.
  r.get('/artifacts/:id/export', ({ user, params }) => {
    const a = authorizeArtifact(user, params.id);
    need(a.review_state === 'reviewed', 409, 'not_reviewed', 'Mark the draft reviewed before exporting.');
    audit(user.id, 'artifact_export', { patient_id: a.patient_id, artifact_id: a.id });
    return { artifact_id: a.id, text: plainText(jsonParse(a.content, {})) };
  });
}
