import './env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { registerAuth, requireAuth } from './auth.js';
import { sendError } from './errors.js';
import { GatewayClient } from './gateway.js';
import { registerRoutes } from './routes.js';
import { startWorkers } from './workers.js';

const config = loadConfig();
const db = createDb(config.databaseUrl);
const app = Fastify({ logger: true, requestIdHeader: 'x-request-id' });

await app.register(cors, { origin: config.webOrigin, credentials: true });
await app.register(cookie);
await app.register(jwt, { secret: config.jwtSecret });
await app.register(websocket);

app.setErrorHandler((error, request, reply) => sendError(request, reply, error));
await registerAuth(app, db);
await registerRoutes(app, db, new GatewayClient(config.gatewayUrl));

app.get('/ws', { websocket: true }, (socket) => {
  let authenticated = false;
  let lastSeq = 0;
  const timer = setTimeout(() => socket.close(1008, 'Authentication timeout'), 5000);
  const sendSince = async (since: number) => {
    const events = (
      await db.query(
        'SELECT seq,type,payload FROM frontend_events WHERE seq>$1 ORDER BY seq LIMIT 1000',
        [since],
      )
    ).rows;
    for (const event of events) {
      socket.send(
        JSON.stringify({ seq: Number(event.seq), type: event.type, payload: event.payload }),
      );
      lastSeq = Number(event.seq);
    }
    if (events.length === 1000) await sendSince(Number(events.at(-1).seq));
  };
  socket.on('message', async (raw: { toString(): string }) => {
    if (authenticated) return;
    try {
      const msg = JSON.parse(raw.toString()) as {
        type?: string;
        accessToken?: string;
        sinceSeq?: number;
      };
      if (msg.type !== 'auth' || !msg.accessToken) throw new Error();
      const accessToken = msg.accessToken;
      if (!accessToken) throw new Error();
      const request = { jwtVerify: () => app.jwt.verify(accessToken) } as any;
      await requireAuth(request, db);
      authenticated = true;
      lastSeq = msg.sinceSeq ?? 0;
      clearTimeout(timer);
      socket.send(JSON.stringify({ type: 'auth', success: true }));
      await sendSince(lastSeq);
    } catch {
      socket.close(1008, 'Unauthorized');
    }
  });
  const listener = setInterval(() => {
    if (authenticated && socket.readyState === 1)
      void sendSince(lastSeq).catch(() => socket.close());
  }, 500);
  socket.on('close', () => {
    clearInterval(listener);
    clearTimeout(timer);
  });
});

const latestMigration = 2;
const current = Number(
  (await db.query('SELECT max(version) version FROM schema_migrations')).rows[0]?.version ?? 0,
);
if (current < latestMigration)
  throw new Error(
    `Database schema ${current} is behind required ${latestMigration}; run npm run db:migrate`,
  );

const workers = startWorkers(db, config);
const shutdown = async () => {
  workers.stop();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await app.listen({ port: config.port, host: '0.0.0.0' });
