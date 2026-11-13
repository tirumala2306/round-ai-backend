import { all, get, run, audit, getSetting, setSetting, tx } from '../db.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, signToken, requireRole, throttleCheck, throttleFail, throttleOk } from '../auth.js';
import { HttpError, uid, nowIso, need, str } from '../util.js';
import { listTemplates, getActiveTemplate, publishTemplate, SOURCES } from '../templates.js';
import { providerName } from '../ai/adapter.js';
import { icdStats } from '../icd.js';
import * as CR from '../check_rules.js';
import { draftCheckRule } from '../ai/orchestrator.js';
import * as T from '../teaching.js';
import * as Chat from '../chat.js';
import { replyRaw } from '../http.js';
import * as Admin from '../admin_ops.js';

export function coreRoutes(r) {
  r.get('/health', { auth: false }, () => {
    let users = 0;
    let patients = 0;
    try {
      users = Number(get('SELECT COUNT(*) AS n FROM users')?.n || 0);
      patients = Number(get('SELECT COUNT(*) AS n FROM patients')?.n || 0);
    } catch { /* db not ready */ }
    return {
      status: 'ok',
      time: nowIso(),
      provider: providerName(),
      db_path: config.dbPath,
      users,
      patients,
    };
  });

  r.post('/auth/login', { auth: false }, ({ body }) => {
    const email = str(body.email, 200).toLowerCase();
    throttleCheck(email);
    const user = get('SELECT * FROM users WHERE email=?', email);
    if (!user || !user.active || !verifyPassword(String(body.password || ''), user.password_hash)) {
      throttleFail(email);
      throw new HttpError(401, 'bad_credentials', 'Invalid email or password');
    }
    throttleOk(email);
    const loginAt = nowIso();
    run('UPDATE users SET last_login_at=? WHERE id=?', loginAt, user.id);
    audit(user.id, 'login');
    return { token: signToken(user.id), expires_in: config.tokenTtlSeconds, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  });

  r.get('/me', ({ user }) => ({
    ...user,
    teams: all('SELECT t.id,t.name FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=?', user.id),
    ai_enabled: getSetting('ai_enabled', true),
    chat_enabled: Chat.chatEnabled(),
  }));

  r.get('/templates', () => ['admit_hp', 'progress', 'icu'].map((k) => getActiveTemplate(k)).filter(Boolean));

  /* ---------------- admin ---------------- */
  const admin = (ctx) => requireRole(ctx.user, 'admin');

  r.get('/admin/health', (ctx) => {
    admin(ctx);
    return Admin.adminHealth({ providerName, config, icdStats });
  });

  r.get('/admin/users', (ctx) => {
    admin(ctx);
    return Admin.listUsersAdmin();
  });

  r.post('/admin/users', (ctx) => {
    admin(ctx);
    const { body } = ctx;
    const email = str(body.email, 200).toLowerCase();
    need(/^\S+@\S+\.\S+$/.test(email), 400, 'bad_email', 'Valid email required');
    need(str(body.password, 200).length >= 10, 400, 'weak_password', 'Password must be at least 10 characters');
    need(['resident', 'attending', 'admin'].includes(body.role || 'resident'), 400, 'bad_role', 'role must be resident, attending or admin');
    need(!get('SELECT 1 AS x FROM users WHERE email=?', email), 409, 'exists', 'User already exists');
    const id = uid();
    tx(() => {
      run('INSERT INTO users(id,email,name,role,password_hash,active,created_at) VALUES(?,?,?,?,?,1,?)', id, email, str(body.name, 120) || email, body.role || 'resident', hashPassword(body.password), nowIso());
      for (const t of Array.isArray(body.team_ids) ? body.team_ids : []) {
        if (get('SELECT 1 AS x FROM teams WHERE id=?', t)) run('INSERT OR IGNORE INTO team_members(team_id,user_id) VALUES(?,?)', t, id);
      }
    });
    audit(ctx.user.id, 'admin_create_user', { detail: { user_id: id } });
    return { id, email };
  });

  r.patch('/admin/users/:id', (ctx) => {
    admin(ctx);
    const u = get('SELECT * FROM users WHERE id=?', ctx.params.id);
    need(u, 404, 'not_found', 'User not found');
    const { body } = ctx;
    if (body.role !== undefined) need(['resident', 'attending', 'admin'].includes(body.role), 400, 'bad_role', 'Invalid role');
    run('UPDATE users SET name=?, role=?, active=? WHERE id=?', str(body.name, 120) || u.name, body.role ?? u.role, body.active === undefined ? u.active : Number(!!body.active), u.id);
    if (typeof body.password === 'string') {
      need(body.password.length >= 10, 400, 'weak_password', 'Password must be at least 10 characters');
      run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(body.password), u.id);
    }
    audit(ctx.user.id, 'admin_update_user', { detail: { user_id: u.id } });
    return { ok: true };
  });

  r.get('/admin/teams', (ctx) => {
    admin(ctx);
    return all('SELECT id,name FROM teams ORDER BY name').map((t) => ({
      ...t, members: all('SELECT u.id,u.name,u.email FROM users u JOIN team_members m ON m.user_id=u.id WHERE m.team_id=?', t.id),
    }));
  });
  r.post('/admin/teams', (ctx) => {
    admin(ctx);
    const name = str(ctx.body.name, 120);
    need(name, 400, 'name_required', 'name is required');
    const id = uid();
    run('INSERT INTO teams(id,name) VALUES(?,?)', id, name);
    return { id, name };
  });
  r.post('/admin/teams/:id/members', (ctx) => {
    admin(ctx);
    need(get('SELECT 1 AS x FROM teams WHERE id=?', ctx.params.id), 404, 'not_found', 'Team not found');
    need(get('SELECT 1 AS x FROM users WHERE id=?', ctx.body.user_id), 404, 'not_found', 'User not found');
    run('INSERT OR IGNORE INTO team_members(team_id,user_id) VALUES(?,?)', ctx.params.id, ctx.body.user_id);
    audit(ctx.user.id, 'admin_team_add', { detail: { team_id: ctx.params.id, user_id: ctx.body.user_id } });
    return { ok: true };
  });
  r.delete('/admin/teams/:id/members/:userId', (ctx) => {
    admin(ctx);
    run('DELETE FROM team_members WHERE team_id=? AND user_id=?', ctx.params.id, ctx.params.userId);
    audit(ctx.user.id, 'admin_team_remove', { detail: { team_id: ctx.params.id, user_id: ctx.params.userId } });
    return { ok: true };
  });

  r.get('/admin/audit', (ctx) => {
    admin(ctx);
    const q = ctx.query;
    return Admin.queryAudit({
      actor_id: q.actor_id || undefined,
      action: q.action || undefined,
      patient_id: q.patient_id || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      limit: q.limit,
      offset: q.offset,
    });
  });
  r.get('/admin/audit.csv', (ctx) => {
    admin(ctx);
    const q = ctx.query;
    const csv = Admin.auditCsv({
      actor_id: q.actor_id || undefined,
      action: q.action || undefined,
      patient_id: q.patient_id || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      limit: q.limit,
    });
    return replyRaw(200, csv, 'text/csv; charset=utf-8');
  });

  r.get('/admin/settings', (ctx) => {
    admin(ctx);
    return {
      ai_enabled: getSetting('ai_enabled', true),
      review_intervals_days: getSetting('review_intervals_days', [1, 3, 7]),
      show_individual_learner_analytics: getSetting('show_individual_learner_analytics', false),
      ...Chat.chatSettings(),
      provider: providerName(), model: config.provider === 'openai' ? config.openai.model : 'mock-1',
      prompt_version: config.versions.prompt, features: config.features,
      limits: { max_calls_per_user_per_day: config.limits.maxCallsPerUserPerDay, max_context_facts: config.limits.maxContextFacts },
      cors_origin: config.corsOrigin,
    };
  });
  r.put('/admin/settings', (ctx) => {
    admin(ctx);
    const { body } = ctx;
    if (body.ai_enabled !== undefined) { setSetting('ai_enabled', !!body.ai_enabled); audit(ctx.user.id, 'admin_ai_switch', { detail: { enabled: !!body.ai_enabled } }); }
    if (body.review_intervals_days !== undefined) {
      const v = body.review_intervals_days;
      need(Array.isArray(v) && v.length && v.every((n) => Number.isInteger(n) && n > 0 && n < 400), 400, 'bad_intervals', 'review_intervals_days must be a list of positive integers');
      setSetting('review_intervals_days', v);
    }
    if (body.show_individual_learner_analytics !== undefined) {
      setSetting('show_individual_learner_analytics', !!body.show_individual_learner_analytics);
      audit(ctx.user.id, 'admin_learner_analytics_setting', { detail: { enabled: !!body.show_individual_learner_analytics } });
    }
    if (
      body.chat_enabled !== undefined
      || body.chat_retention_days !== undefined
      || body.chat_legal_hold !== undefined
      || body.chat_legal_hold_reason !== undefined
    ) {
      Chat.updateChatAdminSettings({ user: ctx.user, body });
    }
    return { ok: true, ...Chat.chatSettings(), ai_enabled: getSetting('ai_enabled', true) };
  });

  r.get('/admin/chat/purge/preview', (ctx) => {
    admin(ctx);
    return Chat.previewPurge({ days: ctx.query.days });
  });
  r.post('/admin/chat/purge', (ctx) => {
    admin(ctx);
    return Chat.purgeExpiredMessages({ user: ctx.user });
  });

  r.get('/admin/chat/export', (ctx) => {
    admin(ctx);
    return Chat.exportTeamChat({
      user: ctx.user,
      teamId: str(ctx.query.team_id, 64),
      reason: str(ctx.query.reason, 2000),
    });
  });
  r.post('/admin/chat/export', (ctx) => {
    admin(ctx);
    const body = ctx.body || {};
    return Chat.exportTeamChat({
      user: ctx.user,
      teamId: str(body.team_id ?? ctx.query.team_id, 64),
      reason: str(body.reason, 2000),
    });
  });
  r.get('/admin/chat/export/history', (ctx) => {
    admin(ctx);
    return Chat.listExportHistory({ limit: ctx.query.limit, offset: ctx.query.offset });
  });
  r.get('/admin/chat/hold/history', (ctx) => {
    admin(ctx);
    return Chat.listHoldHistory({ limit: ctx.query.limit, offset: ctx.query.offset });
  });
  r.get('/admin/chat/metrics', (ctx) => {
    admin(ctx);
    return Chat.chatMetrics({ from: ctx.query.from, to: ctx.query.to });
  });

  r.get('/admin/templates', (ctx) => { admin(ctx); return listTemplates(); });
  r.put('/admin/templates/:key', (ctx) => {
    admin(ctx);
    const { body } = ctx;
    const sections = Array.isArray(body.sections) ? body.sections : [];
    need(sections.length > 0, 400, 'sections_required', 'sections required');
    const clean = sections.map((s) => ({ key: str(s.key, 40), title: str(s.title, 80), source: s.source }));
    need(clean.every((s) => /^[a-z_]+$/.test(s.key) && s.title && SOURCES.includes(s.source)), 400, 'bad_section', `each section needs key (a-z_), title, and source in: ${SOURCES.join(', ')}`);
    need(new Set(clean.map((s) => s.key)).size === clean.length, 400, 'dup_key', 'section keys must be unique');
    const version = publishTemplate(ctx.params.key, str(body.title, 80) || ctx.params.key, clean);
    audit(ctx.user.id, 'admin_template_publish', { detail: { key: ctx.params.key, version } });
    return { key: ctx.params.key, version };
  });

  r.get('/admin/usage', (ctx) => {
    admin(ctx);
    return Admin.usageByUserDay({ since: ctx.query.since });
  });

  r.get('/admin/analytics/activity', (ctx) => {
    admin(ctx);
    return {
      rows: Admin.activityByAction({
        since: ctx.query.since || undefined,
        until: ctx.query.until || undefined,
        user_id: ctx.query.user_id || undefined,
      }),
      note: 'Action counts only — audit never stores clinical text.',
    };
  });

  r.get('/admin/analytics/questions', (ctx) => {
    admin(ctx);
    const allowIndividuals = Admin.individualLearnerAllowed();
    return {
      ...Admin.questionAnalytics({ includeIndividuals: allowIndividuals }),
      individual_learner_analytics: allowIndividuals,
      note: 'Topic-level aggregates by default. Per-user learner rows require show_individual_learner_analytics=true.',
    };
  });

  r.get('/admin/content/:type/:id/history', (ctx) => {
    admin(ctx);
    return Admin.contentHistory({ type: ctx.params.type, id: ctx.params.id });
  });

  r.get('/admin/icd', (ctx) => {
    admin(ctx);
    return {
      ...icdStats(),
      import: 'npm run import-icd -- <order-file> --fy=YYYY --replace',
      links: {
        cdc: 'https://www.cdc.gov/nchs/icd/icd-10-cm/files.html',
        cms: 'https://www.cms.gov/medicare/coding-billing/icd-10-codes',
      },
    };
  });

  /* ---- check-rule library (M3a): draft until physician approves ---- */
  r.get('/admin/check-rules', (ctx) => {
    admin(ctx);
    return CR.listCheckRules({ status: ctx.query.status || undefined });
  });
  r.post('/admin/check-rules', (ctx) => {
    admin(ctx);
    return CR.createCheckRule({ user: ctx.user, body: ctx.body || {} });
  });
  // Register /draft before /:id so "draft" is not captured as an id.
  r.post('/admin/check-rules/draft', async (ctx) => {
    admin(ctx);
    return draftCheckRule({ user: ctx.user, condition: ctx.body?.condition });
  });
  r.get('/admin/check-rules/:id', (ctx) => {
    admin(ctx);
    const rule = CR.getCheckRule(ctx.params.id);
    need(rule, 404, 'not_found', 'Check rule not found');
    return rule;
  });
  r.put('/admin/check-rules/:id', (ctx) => {
    admin(ctx);
    return CR.updateCheckRule({ user: ctx.user, id: ctx.params.id, body: ctx.body || {} });
  });
  r.post('/admin/check-rules/:id/approve', (ctx) => {
    admin(ctx);
    return CR.approveCheckRule({ user: ctx.user, id: ctx.params.id });
  });
  r.post('/admin/check-rules/:id/retire', (ctx) => {
    admin(ctx);
    return CR.retireCheckRule({ user: ctx.user, id: ctx.params.id });
  });

  r.get('/admin/mcq-reports', (ctx) => {
    admin(ctx);
    return all(`SELECT i.id, i.mcq_id, i.note, i.created_at, m.topic, m.status FROM issue_reports i JOIN mcqs m ON m.id=i.mcq_id ORDER BY i.created_at DESC LIMIT 200`);
  });
  r.get('/admin/mcqs', (ctx) => {
    admin(ctx);
    return T.adminMcqReviewQueue({
      status: ctx.query.status, topic: ctx.query.topic, source: ctx.query.source, limit: Number(ctx.query.limit) || 100,
    });
  });
  r.get('/admin/mcqs/:id', (ctx) => {
    admin(ctx);
    return T.adminMcqDetail(ctx.params.id);
  });
  r.patch('/admin/mcqs/:id', (ctx) => {
    admin(ctx);
    return T.approveMcq({ user: ctx.user, id: ctx.params.id, status: ctx.body.status || 'approved' });
  });

  r.get('/admin/curated-reads', (ctx) => {
    admin(ctx);
    const approved = ctx.query.approved === undefined ? undefined : ctx.query.approved === '1' || ctx.query.approved === 'true';
    return T.listCuratedReads({ approved });
  });
  r.post('/admin/curated-reads', (ctx) => {
    admin(ctx);
    return T.createCuratedRead({ user: ctx.user, body: ctx.body || {} });
  });
  r.post('/admin/curated-reads/:id/approve', (ctx) => {
    admin(ctx);
    return T.approveCuratedRead({ user: ctx.user, id: ctx.params.id });
  });

  r.get('/admin/guideline-updates', (ctx) => {
    admin(ctx);
    return T.listGuidelineUpdates({ status: ctx.query.status });
  });
  r.post('/admin/guideline-updates', (ctx) => {
    admin(ctx);
    return T.createGuidelineUpdate({ user: ctx.user, body: ctx.body || {} });
  });
  r.post('/admin/guideline-updates/:id/approve', (ctx) => {
    admin(ctx);
    return T.approveGuidelineUpdate({ user: ctx.user, id: ctx.params.id });
  });
}
