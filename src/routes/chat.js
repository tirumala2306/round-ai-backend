import { authorizePatient } from '../auth.js';
import * as C from '../chat.js';
import * as O from '../ai/orchestrator.js';

export function chatRoutes(r) {
  r.get('/channels', ({ user }) => C.listChannels(user));
  r.post('/channels', ({ user, body }) => C.createChannel({ user, body: body || {} }));
  r.get('/channels/unread', ({ user }) => C.unreadSummary(user));
  r.get('/channels/search', ({ user, query }) => C.searchMessages({ user, q: query.q, limit: Number(query.limit) || 50 }));

  r.get('/channels/:id/messages', ({ user, params, query }) => C.listMessages({
    user,
    channelId: params.id,
    beforeSeq: query.before_seq,
    afterSeq: query.after_seq,
    limit: Number(query.limit) || 50,
    parentId: query.parent_id === '' ? null : (query.parent_id || undefined),
  }));

  r.post('/channels/:id/messages', ({ user, params, body }) => C.postMessage({
    user,
    channelId: params.id,
    body: body?.body,
    parentId: body?.parent_id || null,
  }));

  r.patch('/messages/:id', ({ user, params, body }) => C.editMessage({ user, messageId: params.id, body: body?.body }));
  r.delete('/messages/:id', ({ user, params }) => C.deleteMessage({ user, messageId: params.id }));

  r.post('/channels/:id/read', ({ user, params, body }) => C.markRead({
    user, channelId: params.id, lastReadSeq: body?.last_read_seq,
  }));

  r.get('/patients/:id/channel', ({ user, params }) => {
    C.assertChatEnabled();
    const patient = authorizePatient(user, params.id);
    const ch = C.ensurePatientChannel({ patient, createdBy: user.id });
    const listed = C.listChannels(user).find((c) => c.id === ch.id);
    return listed || {
      id: ch.id, team_id: ch.team_id, name: ch.name, type: ch.type,
      patient_id: ch.patient_id, archived: !!ch.archived, created_at: ch.created_at, unread: 0,
    };
  });

  r.post('/channels/:id/summarize', (ctx) => O.summarizeChatThread({ user: ctx.user, channelId: ctx.params.id }));

  r.post('/chat/devices', ({ user, body }) => C.registerDevice({
    user, platform: body?.platform, token: body?.token,
  }));

  r.get('/stream', (ctx) => C.openStream({
    user: ctx.user,
    req: ctx.req,
    res: ctx.res,
    lastEventId: ctx.req.headers['last-event-id'] || ctx.query.last_event_id,
  }));
}
