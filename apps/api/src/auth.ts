import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import { AppError } from './errors.js';
import { verifyPassword } from './password.js';

type Claims = { sub: string; sid: string; gen: number; role: 'admin' | 'viewer'; username: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const refreshCookie = {
  path: '/api/auth',
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 86400,
};

export async function registerAuth(app: FastifyInstance, db: Db) {
  async function accessToken(claims: Claims) {
    return app.jwt.sign(claims, { expiresIn: '15m' });
  }
  function makeRefresh(sessionId: string) {
    return `${sessionId}.${randomBytes(32).toString('base64url')}`;
  }

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    const user = (await db.query('SELECT * FROM users WHERE username=$1', [body.username])).rows[0];
    if (!user || !body.password || !verifyPassword(user.password_hash, body.password))
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid credentials');
    const sid = randomUUID();
    const family = randomUUID();
    const refresh = makeRefresh(sid);
    await db.query(
      `INSERT INTO auth_sessions(id,user_id,family_id,current_refresh_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days')`,
      [sid, user.id, family, hash(refresh)],
    );
    reply.setCookie('refreshToken', refresh, refreshCookie);
    return {
      accessToken: await accessToken({
        sub: user.id,
        sid,
        gen: 0,
        role: user.role,
        username: user.username,
      }),
    };
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    const token = request.cookies.refreshToken;
    const sid = token?.split('.')[0];
    if (!token || !sid) throw new AppError(401, 'UNAUTHORIZED', 'Refresh token required');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const session = (
        await client.query(
          `SELECT s.*,u.username,u.role FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 FOR UPDATE`,
          [sid],
        )
      ).rows[0];
      if (!session || session.revoked_at || new Date(session.expires_at) <= new Date())
        throw new AppError(401, 'UNAUTHORIZED', 'Session expired');
      const supplied = hash(token);
      if (session.previous_refresh_hash === supplied) {
        await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE family_id=$1', [
          session.family_id,
        ]);
        await client.query('COMMIT');
        throw new AppError(401, 'UNAUTHORIZED', 'Refresh token reuse detected');
      }
      if (session.current_refresh_hash !== supplied)
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid refresh token');
      const next = makeRefresh(sid);
      const generation = session.generation + 1;
      await client.query(
        'UPDATE auth_sessions SET previous_refresh_hash=current_refresh_hash,current_refresh_hash=$1,generation=$2 WHERE id=$3',
        [hash(next), generation, sid],
      );
      await client.query('COMMIT');
      reply.setCookie('refreshToken', next, refreshCookie);
      return {
        accessToken: await accessToken({
          sub: session.user_id,
          sid,
          gen: generation,
          role: session.role,
          username: session.username,
        }),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const claims = await requireAuth(request, db);
    await db.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1', [claims.sid]);
    reply.clearCookie('refreshToken', refreshCookie);
    return { ok: true };
  });
}

export async function requireAuth(request: FastifyRequest, db: Db, admin = false): Promise<Claims> {
  let claims: Claims;
  try {
    claims = await request.jwtVerify<Claims>();
  } catch {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  const session = (
    await db.query('SELECT generation,revoked_at,expires_at FROM auth_sessions WHERE id=$1', [
      claims.sid,
    ])
  ).rows[0];
  if (
    !session ||
    session.revoked_at ||
    session.generation !== claims.gen ||
    new Date(session.expires_at) <= new Date()
  )
    throw new AppError(401, 'UNAUTHORIZED', 'Session is no longer valid');
  if (admin && claims.role !== 'admin')
    throw new AppError(403, 'FORBIDDEN', 'Administrator permission required');
  return claims;
}
