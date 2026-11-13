import { all, get, run, tx, audit } from '../db.js';
import { authorizePatient } from '../auth.js';
import { HttpError, uid, nowIso, today, need, str, jsonParse, isIsoDate } from '../util.js';
import { bumpRevision, changesSince, buildContext } from '../context.js';
import { toEnvelope, decideProblem } from '../ai/orchestrator.js';
import { matchedReminders, ackReminder } from '../check_rules.js';
import { today as todayFn } from '../util.js';
import { ensurePatientChannel } from '../chat.js';

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
         ORDER BY CASE WHEN p.sort_order IS NULL THEN 1 ELSE 0 END, p.sort_order, p.room, p.display_name`, user.id).map((p) => ({
      id: p.id, display_name: p.display_name, room: p.room, age_band: p.age_band, sex: p.sex, team_id: p.team_id,
      sort_order: p.sort_order,
      summary_state: summaryState(p.id), // AI never assigns urgency or ordering
      unreviewed_facts: get("SELECT COUNT(*) AS n FROM facts WHERE patient_id=? AND reviewer_status='pending'", p.id).n,
      open_tasks: get("SELECT COUNT(*) AS n FROM tasks WHERE patient_id=? AND state='open'", p.id).n,
    })));

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
    return {
      id: p.id, display_name: p.display_name, room: p.room, age_band: p.age_band, sex: p.sex, sort_order: p.sort_order,
      revision: p.revision, last_reviewed_revision: p.last_reviewed_revision, summary_state: summaryState(p.id),
      plan_today: ctx.clinician_plan, problems: all("SELECT id,label,state,uncertainty FROM problems WHERE patient_id=? AND state!='rejected' ORDER BY created_at", p.id),
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
    return all(`SELECT id,label,value,unit,event_time,source_id,assertion,reviewer_status FROM facts WHERE patient_id=? ${status ? 'AND reviewer_status=?' : ''} ORDER BY COALESCE(event_time,'') , created_at`, ...(status ? [params.id, status] : [params.id]));
  });

  // Manual entry by a clinician is confirmed immediately and is its own source.
  r.post('/patients/:id/facts', ({ user, params, body }) => {
    const p = authorizePatient(user, params.id);
    const label = str(body.label, 120);
    const value = str(body.value, 1000);
    need(label && value, 400, 'fact_required', 'label and value are required');
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
      for (const id of ids) {
        const f = get('SELECT * FROM facts WHERE id=? AND patient_id=?', id, p.id);
        if (!f || f.reviewer_status === status) continue;
        touched += 1;
        run('UPDATE facts SET reviewer_status=? WHERE id=?', status, id);
      }
      if (!touched) return p.revision;
      const newRev = bumpRevision(p.id);
      for (const id of ids) run("UPDATE facts SET revision=? WHERE id=? AND patient_id=? AND reviewer_status='confirmed'", newRev, id, p.id);
      return newRev;
    });
    audit(user.id, `fact_${status}`, { patient_id: p.id, detail: { count: ids.length } });
    return { context_revision: rev };
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
    // Accept `text`, or legacy `plan_today` as string / line list / { text }.
    let text = str(body.text, 10000);
    if (!text) {
      const raw = body.plan_today;
      if (typeof raw === 'string') text = str(raw, 10000);
      else if (Array.isArray(raw)) text = str(raw.map((x) => String(x ?? '').trim()).filter(Boolean).join('\n'), 10000);
      else if (raw && typeof raw === 'object') text = str(raw.text, 10000);
    }
    need(text, 400, 'text_required', 'text is required');
    const date = str(body.plan_date, 10) || today();
    need(isIsoDate(date), 400, 'bad_date', 'plan_date must be YYYY-MM-DD');
    const rev = bumpRevision(p.id);
    run('INSERT INTO plans(id,patient_id,plan_date,text,author_id,revision,created_at) VALUES(?,?,?,?,?,?,?)', uid(), p.id, date, text, user.id, rev, nowIso());
    audit(user.id, 'plan_save', { patient_id: p.id });
    return { context_revision: rev };
  });

  /* ---------- problems ---------- */
  r.get('/patients/:id/problems', ({ user, params }) => {
    authorizePatient(user, params.id);
    return all('SELECT id,label,state,fact_ids,uncertainty,code_suggestion,updated_at FROM problems WHERE patient_id=? ORDER BY created_at', params.id)
      .map((x) => ({ ...x, fact_ids: jsonParse(x.fact_ids, []), code_suggestion: jsonParse(x.code_suggestion, null) }));
  });
  r.post('/patients/:id/problems/:pid/decision', ({ user, params, body }) => {
    const p = authorizePatient(user, params.id);
    return decideProblem({ user, patient: p, problemId: params.pid, action: body.action });
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
    return { id };
  });
  const taskAction = (state) => ({ user, params, body }) => {
    const t = get('SELECT * FROM tasks WHERE id=?', params.id);
    need(t, 404, 'not_found', 'Task not found');
    authorizePatient(user, t.patient_id);
    if (state === 'open') {
      run("UPDATE tasks SET state='open', accepted_by=?, owner=COALESCE(?,owner), due=COALESCE(?,due) WHERE id=?", user.id, str(body.owner, 80) || null, str(body.due, 40) || null, t.id);
    } else run('UPDATE tasks SET state=? WHERE id=?', state, t.id);
    audit(user.id, `task_${state}`, { patient_id: t.patient_id });
    return { id: t.id, state };
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
    }
    content.unresolved_flags = content.sections.reduce((n, s) => n + s.flags.length, 0);
    const version = get('SELECT MAX(version) AS v FROM artifact_versions WHERE artifact_id=?', a.id).v + 1;
    tx(() => {
      run("UPDATE artifacts SET content=?, review_state='draft', reviewed_by=NULL, reviewed_at=NULL, updated_at=? WHERE id=?", JSON.stringify(content), nowIso(), a.id);
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
