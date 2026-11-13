import { all, get, run, tx, audit, getSetting, setSetting } from './db.js';
import { HttpError, uid, nowIso, need, str, sha, jsonParse, isIsoDate } from './util.js';

export const CHAT_MAX_BODY = 4000;
export const CHAT_RATE_PER_MIN = 30;
const recentPosts = new Map(); // userId -> { t, n, lastHash }
const subscribers = new Set(); // { userId, channelIds:Set, res, lastHeartbeat }

export function chatEnabled() {
  return getSetting('chat_enabled', true) !== false;
}

export function assertChatEnabled() {
  need(chatEnabled(), 503, 'chat_disabled', 'Team chat is temporarily disabled by an administrator.');
}

function lastAuditAction(action) {
  const row = get('SELECT at, actor_id, detail FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1', action);
  if (!row) return null;
  const detail = jsonParse(row.detail, {}) || {};
  return { at: row.at, actor_id: row.actor_id, detail };
}

export function chatSettings() {
  const devices = get('SELECT COUNT(*) AS n FROM chat_devices')?.n || 0;
  return {
    chat_enabled: chatEnabled(),
    chat_retention_days: Number(getSetting('chat_retention_days', 90)) || 90,
    chat_legal_hold: !!getSetting('chat_legal_hold', false),
    chat_limits: {
      max_message_body: CHAT_MAX_BODY,
      rate_per_minute: CHAT_RATE_PER_MIN,
    },
    push: {
      registered_devices: devices,
      note: 'Device count only. Tokens are stored as hashes and never returned.',
    },
    retention_last_change: lastAuditAction('admin_chat_retention'),
    legal_hold_last_change: lastAuditAction('admin_chat_legal_hold'),
    last_purge: lastAuditAction('admin_chat_purge'),
  };
}

function teamIdsFor(userId) {
  return all('SELECT team_id FROM team_members WHERE user_id=?', userId).map((r) => r.team_id);
}

function sameTeam(userA, userB) {
  const a = new Set(teamIdsFor(userA));
  return teamIdsFor(userB).some((t) => a.has(t));
}

function addMember(channelId, userId) {
  run('INSERT OR IGNORE INTO channel_members(channel_id,user_id,joined_at) VALUES(?,?,?)', channelId, userId, nowIso());
}

function teamMemberIds(teamId) {
  return all('SELECT user_id FROM team_members WHERE team_id=?', teamId).map((r) => r.user_id);
}

/** Default team channel (Slack-like #general). Idempotent. */
export function ensureTeamChannel({ teamId, createdBy }) {
  let row = get("SELECT * FROM channels WHERE team_id=? AND type='team' AND name='general' AND archived=0", teamId);
  if (row) {
    for (const uid_ of teamMemberIds(teamId)) addMember(row.id, uid_);
    return row;
  }
  const id = uid();
  run('INSERT INTO channels(id,team_id,name,type,patient_id,created_by,archived,created_at) VALUES(?,?,?,?,NULL,?,0,?)',
    id, teamId, 'general', 'team', createdBy, nowIso());
  for (const uid_ of teamMemberIds(teamId)) addMember(id, uid_);
  return get('SELECT * FROM channels WHERE id=?', id);
}

/** One patient thread per patient; members = that patient's team. */
export function ensurePatientChannel({ patient, createdBy }) {
  let row = get("SELECT * FROM channels WHERE patient_id=? AND type='patient'", patient.id);
  if (row) {
    for (const uid_ of teamMemberIds(patient.team_id)) addMember(row.id, uid_);
    return row;
  }
  const id = uid();
  const name = `patient:${patient.room || patient.id.slice(0, 8)}`;
  run('INSERT INTO channels(id,team_id,name,type,patient_id,created_by,archived,created_at) VALUES(?,?,?,?,?,?,0,?)',
    id, patient.team_id, name, 'patient', patient.id, createdBy || patient.id, nowIso());
  for (const uid_ of teamMemberIds(patient.team_id)) addMember(id, uid_);
  audit(createdBy || null, 'chat_channel_create', { patient_id: patient.id, detail: { channel_id: id, type: 'patient' } });
  return get('SELECT * FROM channels WHERE id=?', id);
}

export function authorizeChannel(user, channelId) {
  const ch = get('SELECT * FROM channels WHERE id=?', channelId);
  if (!ch) throw new HttpError(404, 'not_found', 'Channel not found');
  const mem = get('SELECT 1 AS ok FROM channel_members WHERE channel_id=? AND user_id=?', channelId, user.id);
  if (!mem) {
    audit(user.id, 'access_denied', { patient_id: ch.patient_id, detail: { channel_id: channelId, reason: 'not_member' } });
    throw new HttpError(403, 'access_denied', 'You do not have access to this channel');
  }
  // Defense in depth: still on the team
  const onTeam = get('SELECT 1 AS ok FROM team_members WHERE team_id=? AND user_id=?', ch.team_id, user.id);
  if (!onTeam) {
    audit(user.id, 'access_denied', { patient_id: ch.patient_id, detail: { channel_id: channelId, reason: 'cross_team' } });
    throw new HttpError(403, 'access_denied', 'You do not have access to this channel');
  }
  return ch;
}

function unreadFor(userId, channelId) {
  const read = get('SELECT last_read_seq FROM message_reads WHERE user_id=? AND channel_id=?', userId, channelId);
  const last = read?.last_read_seq || 0;
  const row = get(
    'SELECT COUNT(*) AS n FROM messages WHERE channel_id=? AND seq>? AND deleted_at IS NULL AND sender_id!=?',
    channelId, last, userId,
  );
  return row?.n || 0;
}

function publicChannel(row, userId) {
  return {
    id: row.id,
    team_id: row.team_id,
    name: row.name,
    type: row.type,
    patient_id: row.patient_id || null,
    archived: !!row.archived,
    created_at: row.created_at,
    unread: unreadFor(userId, row.id),
  };
}

export function listChannels(user) {
  assertChatEnabled();
  const teams = teamIdsFor(user.id);
  for (const teamId of teams) ensureTeamChannel({ teamId, createdBy: user.id });
  // Ensure patient threads for census patients
  for (const p of all(
    `SELECT p.* FROM patients p JOIN team_members m ON m.team_id=p.team_id WHERE m.user_id=?`,
    user.id,
  )) {
    ensurePatientChannel({ patient: p, createdBy: user.id });
  }
  const rows = all(
    `SELECT c.* FROM channels c
     JOIN channel_members cm ON cm.channel_id=c.id
     WHERE cm.user_id=? AND c.archived=0
     ORDER BY c.type, c.name`,
    user.id,
  );
  return rows.map((r) => publicChannel(r, user.id));
}

export function createChannel({ user, body }) {
  assertChatEnabled();
  const type = str(body.type, 20);
  need(['team', 'group', 'dm'].includes(type), 400, 'bad_type', 'type must be team, group, or dm (patient channels are auto-created)');
  const teamId = str(body.team_id, 64) || teamIdsFor(user.id)[0];
  need(teamId, 400, 'team_required', 'team_id is required');
  need(get('SELECT 1 AS x FROM team_members WHERE team_id=? AND user_id=?', teamId, user.id), 403, 'access_denied', 'Not a member of that team');

  if (type === 'dm') {
    const otherId = str(body.user_id, 64);
    need(otherId && otherId !== user.id, 400, 'user_required', 'user_id of teammate is required for DM');
    need(sameTeam(user.id, otherId), 403, 'access_denied', 'DMs are only allowed among teammates');
    // Reuse existing DM if present
    const existing = all(
      `SELECT c.* FROM channels c
       JOIN channel_members a ON a.channel_id=c.id AND a.user_id=?
       JOIN channel_members b ON b.channel_id=c.id AND b.user_id=?
       WHERE c.type='dm' AND c.team_id=? AND c.archived=0`,
      user.id, otherId, teamId,
    ).find((c) => all('SELECT user_id FROM channel_members WHERE channel_id=?', c.id).length === 2);
    if (existing) return publicChannel(existing, user.id);
    const other = get('SELECT name FROM users WHERE id=?', otherId);
    const id = uid();
    run('INSERT INTO channels(id,team_id,name,type,patient_id,created_by,archived,created_at) VALUES(?,?,?,?,NULL,?,0,?)',
      id, teamId, `dm:${other?.name || otherId.slice(0, 8)}`, 'dm', user.id, nowIso());
    addMember(id, user.id);
    addMember(id, otherId);
    audit(user.id, 'chat_channel_create', { detail: { channel_id: id, type: 'dm' } });
    return publicChannel(get('SELECT * FROM channels WHERE id=?', id), user.id);
  }

  const name = str(body.name, 80);
  need(name, 400, 'name_required', 'name is required');
  const memberIds = Array.isArray(body.member_ids) ? body.member_ids.map((x) => str(x, 64)).filter(Boolean) : [];
  if (type === 'team') {
    const id = uid();
    run('INSERT INTO channels(id,team_id,name,type,patient_id,created_by,archived,created_at) VALUES(?,?,?,?,NULL,?,0,?)',
      id, teamId, name, 'team', user.id, nowIso());
    for (const uid_ of teamMemberIds(teamId)) addMember(id, uid_);
    audit(user.id, 'chat_channel_create', { detail: { channel_id: id, type: 'team' } });
    return publicChannel(get('SELECT * FROM channels WHERE id=?', id), user.id);
  }

  // group: creator + explicit members (must be teammates)
  const id = uid();
  run('INSERT INTO channels(id,team_id,name,type,patient_id,created_by,archived,created_at) VALUES(?,?,?,?,NULL,?,0,?)',
    id, teamId, name, 'group', user.id, nowIso());
  addMember(id, user.id);
  for (const mid of memberIds.slice(0, 50)) {
    need(sameTeam(user.id, mid), 403, 'access_denied', 'Group members must be teammates');
    addMember(id, mid);
  }
  audit(user.id, 'chat_channel_create', { detail: { channel_id: id, type: 'group' } });
  return publicChannel(get('SELECT * FROM channels WHERE id=?', id), user.id);
}

function publicMessage(row) {
  const deleted = !!row.deleted_at;
  return {
    id: row.id,
    seq: row.seq,
    channel_id: row.channel_id,
    sender_id: row.sender_id,
    body: deleted ? '' : row.body,
    parent_id: row.parent_id || null,
    created_at: row.created_at,
    edited_at: row.edited_at || null,
    deleted_at: row.deleted_at || null,
    deleted,
  };
}

function rateCheck(userId, bodyHash) {
  const now = Date.now();
  let rec = recentPosts.get(userId);
  if (!rec || now - rec.t > 60_000) rec = { t: now, n: 0, lastHash: null, lastAt: 0 };
  if (rec.n >= CHAT_RATE_PER_MIN) {
    audit(userId, 'chat_rate_limited', { detail: {} });
    throw new HttpError(429, 'rate_limited', 'Too many messages. Slow down.');
  }
  if (rec.lastHash === bodyHash && now - rec.lastAt < 5000) {
    audit(userId, 'chat_duplicate_rejected', { detail: {} });
    throw new HttpError(429, 'duplicate_message', 'Duplicate message rejected (spam guard).');
  }
  rec.n += 1;
  rec.lastHash = bodyHash;
  rec.lastAt = now;
  recentPosts.set(userId, rec);
}

function parseMentions(body, teamId) {
  const names = [...body.matchAll(/@([A-Za-z][A-Za-z0-9._-]{1,40})/g)].map((m) => m[1].toLowerCase());
  if (!names.length) return [];
  const members = all(
    `SELECT u.id, lower(u.name) AS name FROM users u
     JOIN team_members m ON m.user_id=u.id WHERE m.team_id=?`,
    teamId,
  );
  const out = [];
  for (const n of names) {
    const hit = members.find((m) => m.name.split(/\s+/)[0] === n || m.name.replace(/\s+/g, '') === n || m.name === n);
    if (hit) out.push(hit.id);
  }
  return [...new Set(out)];
}

export function postMessage({ user, channelId, body, parentId = null }) {
  assertChatEnabled();
  const ch = authorizeChannel(user, channelId);
  need(!ch.archived, 409, 'archived', 'Channel is archived');
  const text = str(body, CHAT_MAX_BODY);
  need(text, 400, 'body_required', 'Message body is required');
  need(text.length <= CHAT_MAX_BODY, 400, 'too_long', `Message max length is ${CHAT_MAX_BODY} characters`);
  rateCheck(user.id, sha(text));

  if (parentId) {
    const parent = get('SELECT * FROM messages WHERE id=? AND channel_id=?', parentId, channelId);
    need(parent, 404, 'not_found', 'Parent message not found');
  }

  const id = uid();
  const at = nowIso();
  run('INSERT INTO messages(id,channel_id,sender_id,body,parent_id,created_at) VALUES(?,?,?,?,?,?)',
    id, channelId, user.id, text, parentId || null, at);
  const row = get('SELECT * FROM messages WHERE id=?', id);
  const mentioned = parseMentions(text, ch.team_id);
  for (const mid of mentioned) {
    run('INSERT INTO mentions(id,message_id,user_id,created_at) VALUES(?,?,?,?)', uid(), id, mid, at);
  }
  // Sender has read up to this message
  run(`INSERT INTO message_reads(user_id,channel_id,last_read_seq,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(user_id,channel_id) DO UPDATE SET last_read_seq=excluded.last_read_seq, updated_at=excluded.updated_at`,
    user.id, channelId, row.seq, at);
  audit(user.id, 'chat_post', { patient_id: ch.patient_id, detail: { channel_id: channelId, message_id: id, seq: row.seq } });
  const msg = publicMessage(row);
  broadcast(channelId, 'message', msg);
  queuePushNewMessage({ channelId, excludeUserId: user.id });
  return msg;
}

export function listMessages({ user, channelId, beforeSeq = null, afterSeq = null, limit = 50, parentId = undefined }) {
  assertChatEnabled();
  authorizeChannel(user, channelId);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  let sql = 'SELECT * FROM messages WHERE channel_id=?';
  const args = [channelId];
  if (parentId === null) { sql += ' AND parent_id IS NULL'; }
  else if (parentId) { sql += ' AND parent_id=?'; args.push(parentId); }
  if (beforeSeq != null && beforeSeq !== '') { sql += ' AND seq<?'; args.push(Number(beforeSeq)); }
  if (afterSeq != null && afterSeq !== '') { sql += ' AND seq>?'; args.push(Number(afterSeq)); }
  sql += ' ORDER BY seq DESC LIMIT ?';
  args.push(lim);
  const rows = all(sql, ...args).reverse();
  audit(user.id, 'chat_read', { detail: { channel_id: channelId, count: rows.length } });
  return { messages: rows.map(publicMessage) };
}

export function editMessage({ user, messageId, body }) {
  assertChatEnabled();
  const row = get('SELECT * FROM messages WHERE id=?', messageId);
  need(row, 404, 'not_found', 'Message not found');
  authorizeChannel(user, row.channel_id);
  need(row.sender_id === user.id, 403, 'forbidden', 'You can only edit your own messages');
  need(!row.deleted_at, 409, 'deleted', 'Message was deleted');
  const text = str(body, CHAT_MAX_BODY);
  need(text, 400, 'body_required', 'Message body is required');
  const at = nowIso();
  run('UPDATE messages SET body=?, edited_at=? WHERE id=?', text, at, messageId);
  const updated = publicMessage(get('SELECT * FROM messages WHERE id=?', messageId));
  audit(user.id, 'chat_edit', { detail: { channel_id: row.channel_id, message_id: messageId } });
  broadcast(row.channel_id, 'message_edited', updated);
  return updated;
}

export function deleteMessage({ user, messageId }) {
  assertChatEnabled();
  const row = get('SELECT * FROM messages WHERE id=?', messageId);
  need(row, 404, 'not_found', 'Message not found');
  authorizeChannel(user, row.channel_id);
  need(row.sender_id === user.id || user.role === 'admin', 403, 'forbidden', 'Not allowed to delete this message');
  if (row.deleted_at) return publicMessage(row);
  const at = nowIso();
  run('UPDATE messages SET deleted_at=?, body=? WHERE id=?', at, '', messageId);
  const updated = publicMessage(get('SELECT * FROM messages WHERE id=?', messageId));
  audit(user.id, 'chat_delete', { detail: { channel_id: row.channel_id, message_id: messageId } });
  broadcast(row.channel_id, 'message_deleted', updated);
  return updated;
}

export function markRead({ user, channelId, lastReadSeq }) {
  assertChatEnabled();
  authorizeChannel(user, channelId);
  const seq = Number(lastReadSeq);
  need(Number.isInteger(seq) && seq >= 0, 400, 'bad_seq', 'last_read_seq must be a non-negative integer');
  run(`INSERT INTO message_reads(user_id,channel_id,last_read_seq,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(user_id,channel_id) DO UPDATE SET
         last_read_seq=CASE WHEN excluded.last_read_seq>message_reads.last_read_seq THEN excluded.last_read_seq ELSE message_reads.last_read_seq END,
         updated_at=excluded.updated_at`,
    user.id, channelId, seq, nowIso());
  audit(user.id, 'chat_mark_read', { detail: { channel_id: channelId, last_read_seq: seq } });
  return { channel_id: channelId, last_read_seq: seq, unread: unreadFor(user.id, channelId) };
}

export function searchMessages({ user, q, limit = 50 }) {
  assertChatEnabled();
  const query = str(q, 100);
  need(query.length >= 2, 400, 'query_required', 'q must be at least 2 characters');
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const rows = all(
    `SELECT m.* FROM messages m
     JOIN channel_members cm ON cm.channel_id=m.channel_id AND cm.user_id=?
     WHERE m.deleted_at IS NULL AND m.body LIKE ? ESCAPE '\\'
     ORDER BY m.seq DESC LIMIT ?`,
    user.id, `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`, lim,
  );
  return { messages: rows.map(publicMessage) };
}

export function unreadSummary(user) {
  assertChatEnabled();
  const channels = listChannels(user);
  const total = channels.reduce((n, c) => n + c.unread, 0);
  return { total_unread: total, channels: channels.filter((c) => c.unread > 0).map((c) => ({ id: c.id, unread: c.unread, type: c.type, patient_id: c.patient_id })) };
}

/* ---------------- SSE ---------------- */

function sseWrite(res, { id, event, data }) {
  if (id != null) res.write(`id: ${id}\n`);
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function broadcast(channelId, event, data) {
  for (const sub of [...subscribers]) {
    if (!sub.channelIds.has(channelId)) continue;
    try {
      sseWrite(sub.res, { id: data.seq ?? Date.now(), event, data: { channel_id: channelId, ...data } });
    } catch {
      subscribers.delete(sub);
    }
  }
}

export function openStream({ user, req, res, lastEventId }) {
  assertChatEnabled();
  const channels = listChannels(user);
  const channelIds = new Set(channels.map((c) => c.id));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': ok\n\n');

  const since = Number(lastEventId);
  if (Number.isInteger(since) && since > 0 && channelIds.size) {
    const placeholders = [...channelIds].map(() => '?').join(',');
    const replay = all(
      `SELECT * FROM messages WHERE channel_id IN (${placeholders}) AND seq>? ORDER BY seq ASC LIMIT 500`,
      ...channelIds, since,
    );
    for (const row of replay) {
      sseWrite(res, { id: row.seq, event: 'message', data: { channel_id: row.channel_id, ...publicMessage(row) } });
    }
  }

  const sub = { userId: user.id, channelIds, res, lastHeartbeat: Date.now() };
  subscribers.add(sub);
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
      sub.lastHeartbeat = Date.now();
    } catch {
      clearInterval(heartbeat);
      subscribers.delete(sub);
    }
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    subscribers.delete(sub);
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  audit(user.id, 'chat_stream_open', { detail: { channels: channelIds.size } });
  return { __stream: true };
}

/* ---------------- push stub (generic payload only) ---------------- */

export function registerDevice({ user, platform, token }) {
  const p = str(platform, 20) || 'unknown';
  const t = str(token, 500);
  need(t.length >= 8, 400, 'token_required', 'device token is required');
  need(['ios', 'android', 'web', 'unknown'].includes(p), 400, 'bad_platform', 'platform must be ios, android, or web');
  const tokenHash = sha(t);
  run('INSERT OR IGNORE INTO chat_devices(id,user_id,platform,token_hash,created_at) VALUES(?,?,?,?,?)',
    uid(), user.id, p, tokenHash, nowIso());
  audit(user.id, 'chat_device_register', { detail: { platform: p } });
  return { ok: true, note: 'Token stored as hash only. Push providers must receive generic payloads with no PHI.' };
}

function queuePushNewMessage({ channelId, excludeUserId }) {
  const members = all('SELECT user_id FROM channel_members WHERE channel_id=?', channelId)
    .map((r) => r.user_id)
    .filter((id) => id !== excludeUserId);
  // Extension point: enqueue FCM/APNs with payload { title: 'New message', body: 'Open RoundsAI' } — never channel/patient/text.
  for (const uid_ of members) {
    const devices = all('SELECT id FROM chat_devices WHERE user_id=?', uid_);
    if (devices.length) {
      audit(null, 'chat_push_queued', { detail: { channel_id: channelId, user_id: uid_, devices: devices.length, payload: 'New message' } });
    }
  }
}

/* ---------------- admin retention / export ---------------- */

export function updateChatAdminSettings({ user, body }) {
  if (body.chat_enabled !== undefined) {
    setSetting('chat_enabled', !!body.chat_enabled);
    audit(user.id, 'admin_chat_switch', { detail: { enabled: !!body.chat_enabled } });
  }
  if (body.chat_retention_days !== undefined) {
    const d = Number(body.chat_retention_days);
    need(Number.isInteger(d) && d >= 1 && d <= 3650, 400, 'bad_retention', 'chat_retention_days must be 1–3650');
    setSetting('chat_retention_days', d);
    audit(user.id, 'admin_chat_retention', { detail: { days: d } });
  }
  if (body.chat_legal_hold !== undefined) {
    const next = !!body.chat_legal_hold;
    const prev = !!getSetting('chat_legal_hold', false);
    if (next !== prev) {
      const reason = str(body.chat_legal_hold_reason ?? body.reason, 2000);
      need(reason.length >= 3, 400, 'reason_required', 'A reason is required when changing legal hold');
      setSetting('chat_legal_hold', next);
      const at = nowIso();
      run(
        'INSERT INTO chat_hold_history(id,at,actor_id,hold,reason) VALUES(?,?,?,?,?)',
        uid(), at, user.id, next ? 1 : 0, reason,
      );
      audit(user.id, 'admin_chat_legal_hold', { detail: { hold: next, reason } });
    }
  }
  return chatSettings();
}

export function previewPurge({ days: overrideDays } = {}) {
  const configured = Number(getSetting('chat_retention_days', 90)) || 90;
  let days = configured;
  if (overrideDays !== undefined && overrideDays !== null && overrideDays !== '') {
    days = Number(overrideDays);
    need(Number.isInteger(days) && days >= 1 && days <= 3650, 400, 'bad_retention', 'days must be 1–3650');
  }
  const hold = !!getSetting('chat_legal_hold', false);
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const eligible = get('SELECT COUNT(*) AS n FROM messages WHERE created_at<?', cutoff)?.n || 0;
  return {
    retention_days: days,
    configured_retention_days: configured,
    cutoff,
    eligible_count: eligible,
    blocked: hold,
    blocked_reason: hold ? 'legal_hold' : null,
    last_purge: lastAuditAction('admin_chat_purge'),
    note: 'Counts only. No message content is returned. Scheduling is a backend concern; this API never auto-runs purge.',
  };
}

export function purgeExpiredMessages({ user } = {}) {
  const hold = !!getSetting('chat_legal_hold', false);
  const days = Number(getSetting('chat_retention_days', 90)) || 90;
  if (hold) {
    return {
      purged: 0,
      skipped: true,
      reason: 'legal_hold',
      retention_days: days,
      last_purge: lastAuditAction('admin_chat_purge'),
    };
  }
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const old = all('SELECT id FROM messages WHERE created_at<? LIMIT 5000', cutoff);
  tx(() => {
    for (const m of old) {
      run('DELETE FROM mentions WHERE message_id=?', m.id);
      run('DELETE FROM messages WHERE id=?', m.id);
    }
  });
  if (user) audit(user.id, 'admin_chat_purge', { detail: { purged: old.length, cutoff_day: cutoff.slice(0, 10) } });
  return {
    purged: old.length,
    skipped: false,
    retention_days: days,
    cutoff,
    last_purge: lastAuditAction('admin_chat_purge'),
  };
}

export function exportTeamChat({ user, teamId, reason }) {
  need(teamId, 400, 'team_required', 'team_id is required');
  const why = str(reason, 2000);
  need(why.length >= 3, 400, 'reason_required', 'Export reason is required (compliance audit)');
  const channels = all('SELECT * FROM channels WHERE team_id=?', teamId);
  const out = [];
  let messageCount = 0;
  for (const ch of channels) {
    const messages = all('SELECT seq,id,channel_id,sender_id,body,parent_id,created_at,edited_at,deleted_at FROM messages WHERE channel_id=? ORDER BY seq', ch.id);
    messageCount += messages.length;
    out.push({
      channel: { id: ch.id, name: ch.name, type: ch.type, patient_id: ch.patient_id, archived: !!ch.archived },
      messages,
    });
  }
  const exportId = uid();
  const at = nowIso();
  run(
    `INSERT INTO chat_export_requests(id,at,actor_id,reason,team_id,channel_count,message_count,format)
     VALUES(?,?,?,?,?,?,?,?)`,
    exportId, at, user.id, why, teamId, channels.length, messageCount, 'json',
  );
  audit(user.id, 'admin_chat_export', {
    detail: {
      export_id: exportId,
      team_id: teamId,
      channels: channels.length,
      message_count: messageCount,
      reason: why,
      format: 'json',
    },
  });
  return {
    export_id: exportId,
    exported_at: at,
    team_id: teamId,
    reason: why,
    channel_count: channels.length,
    message_count: messageCount,
    format: 'json',
    notice: 'Compliance export. Protect as PHI. This software does not claim HIPAA compliance. Download only — do not render in an admin UI.',
    channels: out,
  };
}

export function listExportHistory({ limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const total = get('SELECT COUNT(*) AS n FROM chat_export_requests')?.n || 0;
  const rows = all(
    `SELECT id, at, actor_id, reason, team_id, channel_count, message_count, format
     FROM chat_export_requests ORDER BY at DESC LIMIT ? OFFSET ?`,
    lim, off,
  );
  return { rows, total, limit: lim, offset: off };
}

export function listHoldHistory({ limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const total = get('SELECT COUNT(*) AS n FROM chat_hold_history')?.n || 0;
  const rows = all(
    `SELECT id, at, actor_id, hold, reason FROM chat_hold_history ORDER BY at DESC LIMIT ? OFFSET ?`,
    lim, off,
  ).map((r) => ({ ...r, hold: !!r.hold }));
  return { rows, total, limit: lim, offset: off };
}

/** Aggregated chat metrics only — no message text, channel titles, or participant lists. */
export function chatMetrics({ from, to } = {}) {
  const toDay = (to && isIsoDate(to) ? String(to).slice(0, 10) : nowIso().slice(0, 10));
  const fromDay = (from && isIsoDate(from) ? String(from).slice(0, 10) : new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
  need(fromDay <= toDay, 400, 'bad_range', 'from must be on or before to');

  const fromIso = `${fromDay}T00:00:00.000Z`;
  const toIso = `${toDay}T23:59:59.999Z`;

  const msgDays = all(
    `SELECT substr(created_at,1,10) AS day,
            COUNT(*) AS messages_posted,
            COUNT(DISTINCT channel_id) AS active_channels
     FROM messages WHERE created_at>=? AND created_at<=?
     GROUP BY substr(created_at,1,10) ORDER BY day`,
    fromIso, toIso,
  );
  const summarizeDays = all(
    `SELECT substr(created_at,1,10) AS day, COUNT(*) AS summarize_requests
     FROM artifacts WHERE operation='summarize_chat_thread' AND created_at>=? AND created_at<=?
     GROUP BY substr(created_at,1,10)`,
    fromIso, toIso,
  );
  const pushDays = all(
    `SELECT substr(at,1,10) AS day, COUNT(*) AS push_registrations
     FROM audit_log WHERE action='chat_device_register' AND at>=? AND at<=?
     GROUP BY substr(at,1,10)`,
    fromIso, toIso,
  );
  const rateDays = all(
    `SELECT substr(at,1,10) AS day, COUNT(*) AS rate_limit_rejections
     FROM audit_log WHERE action='chat_rate_limited' AND at>=? AND at<=?
     GROUP BY substr(at,1,10)`,
    fromIso, toIso,
  );
  const spamDays = all(
    `SELECT substr(at,1,10) AS day, COUNT(*) AS spam_rejections
     FROM audit_log WHERE action='chat_duplicate_rejected' AND at>=? AND at<=?
     GROUP BY substr(at,1,10)`,
    fromIso, toIso,
  );

  const byDay = new Map();
  const ensure = (day) => {
    if (!byDay.has(day)) {
      byDay.set(day, {
        day,
        active_channels: 0,
        messages_posted: 0,
        summarize_requests: 0,
        push_registrations: 0,
        rate_limit_rejections: 0,
        spam_rejections: 0,
      });
    }
    return byDay.get(day);
  };
  for (const r of msgDays) {
    const d = ensure(r.day);
    d.active_channels = r.active_channels;
    d.messages_posted = r.messages_posted;
  }
  for (const r of summarizeDays) ensure(r.day).summarize_requests = r.summarize_requests;
  for (const r of pushDays) ensure(r.day).push_registrations = r.push_registrations;
  for (const r of rateDays) ensure(r.day).rate_limit_rejections = r.rate_limit_rejections;
  for (const r of spamDays) ensure(r.day).spam_rejections = r.spam_rejections;

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const totals = days.reduce(
    (acc, d) => ({
      active_channels: acc.active_channels + d.active_channels,
      messages_posted: acc.messages_posted + d.messages_posted,
      summarize_requests: acc.summarize_requests + d.summarize_requests,
      push_registrations: acc.push_registrations + d.push_registrations,
      rate_limit_rejections: acc.rate_limit_rejections + d.rate_limit_rejections,
      spam_rejections: acc.spam_rejections + d.spam_rejections,
    }),
    {
      active_channels: 0,
      messages_posted: 0,
      summarize_requests: 0,
      push_registrations: 0,
      rate_limit_rejections: 0,
      spam_rejections: 0,
    },
  );

  return {
    from: fromDay,
    to: toDay,
    days,
    totals,
    note: 'Aggregates only. No message text, channel titles, or participant lists. Per-user breakdown deferred pending privacy policy.',
  };
}

/** Messages for AI summarize — caller must already authorize channel. Soft-deleted omitted. */
export function threadMessagesForAi(channelId, { limit = 80 } = {}) {
  return all(
    `SELECT id, seq, sender_id, body, parent_id, created_at FROM messages
     WHERE channel_id=? AND deleted_at IS NULL ORDER BY seq DESC LIMIT ?`,
    channelId, Math.min(limit, 120),
  ).reverse();
}
