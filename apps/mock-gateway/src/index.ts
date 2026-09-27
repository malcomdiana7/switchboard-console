import './env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';

type EventRow = { eventId: number; type: string; [key: string]: unknown };
type Group = {
  id: string;
  creatorAccountId: string;
  members: Set<string>;
  admins: Set<string>;
  invite?: { link: string; readyAt: number; expired: boolean };
  messages: Map<string, Array<{ msgId: string; sentAt: number }>>;
  writable: boolean;
};
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
const accounts = new Map<string, { platformUserId: string; online: boolean; terminal?: string }>();
const groups = new Map<string, Group>();
const media = new Map<string, { bytes: Buffer; contentType: string }>();
const events: EventRow[] = [];
const clients = new Set<{ raw: any; last: number }>();
let eventId = 0;
const account = (id: string) => {
  let a = accounts.get(id);
  if (!a) {
    a = { platformUserId: `pu-${id}`, online: false };
    accounts.set(id, a);
  }
  return a;
};
const error = (reply: any, status: number, code: string, extra = {}) =>
  reply.code(status).send({ code, ...extra });
function push(type: string, data: Record<string, unknown>, duplicate = false) {
  const row = { eventId: ++eventId, type, ...data };
  events.push(row);
  for (const c of clients)
    if (row.eventId > c.last) {
      c.raw.write(frame(row));
      c.last = row.eventId;
      if (duplicate) c.raw.write(frame(row));
    }
}
const frame = (e: EventRow) => `id: ${e.eventId}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
function available(reply: any, id: string) {
  const a = account(id);
  if (a.terminal)
    return error(
      reply,
      a.terminal === 'suspended' ? 403 : 401,
      a.terminal === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'SESSION_EXPIRED',
    );
  if (!a.online) return error(reply, 409, 'ACCOUNT_OFFLINE');
  return a;
}

app.post('/accounts/:id/connect', (req, reply) => {
  const { id } = req.params as any;
  const a = account(id);
  if (a.terminal)
    return error(
      reply,
      a.terminal === 'suspended' ? 403 : 401,
      a.terminal === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'SESSION_EXPIRED',
    );
  a.online = true;
  return { platformUserId: a.platformUserId };
});
app.post('/accounts/:id/disconnect', (req) => {
  account((req.params as any).id).online = false;
  return {};
});
app.post('/groups', (req, reply) => {
  const { creatorAccountId } = req.body as any;
  const a = available(reply, creatorAccountId);
  if (!a) return;
  const id = `grp-${randomUUID()}`;
  groups.set(id, {
    id,
    creatorAccountId,
    members: new Set([a.platformUserId]),
    admins: new Set(),
    messages: new Map(),
    writable: true,
  });
  return { groupId: id };
});
app.post('/groups/:id/invite', (req, reply) => {
  const g = groups.get((req.params as any).id);
  if (!g) return error(reply, 404, 'GROUP_NOT_FOUND');
  const link = `invite-${randomUUID()}`;
  g.invite = { link, readyAt: Date.now() + 300, expired: false };
  return { inviteLink: link, readyAfterMs: 300 };
});
app.post('/groups/:id/join', (req, reply) => {
  const g = groups.get((req.params as any).id);
  const { accountId, inviteLink } = req.body as any;
  if (!g) return error(reply, 404, 'GROUP_NOT_FOUND');
  const a = available(reply, accountId);
  if (!a) return;
  if (g.members.has(a.platformUserId)) return error(reply, 409, 'ALREADY_MEMBER');
  if (!g.invite || g.invite.link !== inviteLink || g.invite.expired)
    return error(reply, 410, 'INVITE_EXPIRED');
  if (Date.now() < g.invite.readyAt) return error(reply, 409, 'INVITE_NOT_READY');
  setTimeout(
    () => {
      g.members.add(a.platformUserId);
      push('member_joined', { groupId: g.id, platformUserId: a.platformUserId });
    },
    100 + Math.random() * 300,
  );
  reply.code(202);
  return { accepted: true };
});
app.post('/groups/:id/promote', (req, reply) => {
  const g = groups.get((req.params as any).id);
  const { byAccountId, accountId } = req.body as any;
  if (!g) return error(reply, 404, 'GROUP_NOT_FOUND');
  const target = account(accountId);
  if (byAccountId !== g.creatorAccountId) return error(reply, 403, 'NO_PERMISSION');
  if (!g.members.has(target.platformUserId)) return error(reply, 409, 'NOT_MEMBER_YET');
  g.admins.add(target.platformUserId);
  return {};
});
app.post('/groups/:id/leave', (req, reply) => {
  const g = groups.get((req.params as any).id);
  const { accountId } = req.body as any;
  if (!g) return error(reply, 404, 'GROUP_NOT_FOUND');
  const a = available(reply, accountId);
  if (!a) return;
  g.members.delete(a.platformUserId);
  g.admins.delete(a.platformUserId);
  setTimeout(() => push('member_left', { groupId: g.id, platformUserId: a.platformUserId }), 50);
  return {};
});
app.post('/groups/:id/kick', (req, reply) => {
  const g = groups.get((req.params as any).id);
  const { byAccountId, targetPlatformUserId } = req.body as any;
  if (!g) return error(reply, 404, 'GROUP_NOT_FOUND');
  if (!g.members.has(account(g.creatorAccountId).platformUserId))
    return error(reply, 409, 'OWNER_LEFT');
  const by = account(byAccountId);
  if (byAccountId !== g.creatorAccountId && !g.admins.has(by.platformUserId))
    return error(reply, 403, 'NO_PERMISSION');
  g.members.delete(targetPlatformUserId);
  setTimeout(
    () => push('member_left', { groupId: g.id, platformUserId: targetPlatformUserId }),
    50,
  );
  return { kicked: true };
});
app.get('/groups/:id/members', (req) => {
  const g = groups.get((req.params as any).id);
  return [...(g?.members ?? [])].map((platformUserId) => ({ platformUserId }));
});
app.post('/groups/:id/send', (req, reply) => {
  const g = groups.get((req.params as any).id);
  const { accountId, clientMsgId, text } = req.body as any;
  if (!g) return error(reply, 404, 'GROUP_NOT_FOUND');
  const a = available(reply, accountId);
  if (!a) return;
  if (!g.writable) return error(reply, 403, 'GROUP_WRITE_FORBIDDEN');
  if (!g.members.has(a.platformUserId)) return error(reply, 403, 'SENDER_NOT_IN_GROUP');
  const msgId = `msg-${randomUUID()}`,
    sentAt = Date.now();
  const rows = g.messages.get(clientMsgId) ?? [];
  rows.push({ msgId, sentAt });
  g.messages.set(clientMsgId, rows);
  setTimeout(
    () => {
      push('message_sent', { clientMsgId, msgId, sentAt });
      push('message', {
        groupId: g.id,
        msgId,
        senderPlatformUserId: a.platformUserId,
        text,
        sentAt,
      });
    },
    80 + Math.random() * 250,
  );
  reply.code(202);
  return { accepted: true };
});
app.get('/groups/:id/messages/by-client-id/:clientId', (req, reply) => {
  const g = groups.get((req.params as any).id);
  const rows = g?.messages.get((req.params as any).clientId);
  if (!rows?.length) return reply.code(404).send({});
  return rows[0];
});
app.get('/events', (req, reply) => {
  const since = Number((req.query as any).since ?? eventId);
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const event of events) if (event.eventId > since) raw.write(frame(event));
  const client = { raw, last: Math.max(since, eventId) };
  clients.add(client);
  const keep = setInterval(() => raw.write(': keepalive\n\n'), 15000);
  raw.on('close', () => {
    clearInterval(keep);
    clients.delete(client);
  });
});
app.get('/media/:id', (req, reply) => {
  const item = media.get((req.params as any).id);
  if (!item) return reply.code(404).send({});
  return reply.type(item.contentType).send(item.bytes);
});

app.post('/__control/message', (req) => {
  const b = req.body as any;
  const msgId = b.msgId ?? `msg-${randomUUID()}`,
    sentAt = b.sentAt ?? Date.now();
  push(
    'message',
    {
      groupId: b.groupId,
      msgId,
      senderPlatformUserId: b.senderPlatformUserId,
      text: b.text,
      sentAt,
      ...(b.mediaUrl ? { mediaUrl: b.mediaUrl } : {}),
    },
    b.duplicate,
  );
  return { msgId, sentAt };
});
app.post('/__control/media', (req) => {
  const body = req.body as any;
  const id = body.id ?? randomUUID();
  media.set(id, {
    bytes: Buffer.from(body.base64 ?? 'iVBORw0KGgo=', 'base64'),
    contentType: body.contentType ?? 'image/png',
  });
  return { id, mediaUrl: `/media/${id}` };
});
app.post('/__control/account-status', (req) => {
  const b = req.body as any;
  account(b.accountId).terminal = b.status;
  push('account_status', b);
  return { ok: true };
});
app.post('/__control/group-writable', (req) => {
  const b = req.body as any;
  const g = groups.get(b.groupId);
  if (g) g.writable = b.writable;
  return { ok: !!g };
});

await app.listen({ port: Number(process.env.GATEWAY_MOCK_PORT ?? 4100), host: '0.0.0.0' });
