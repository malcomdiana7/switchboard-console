import './env.js';
import { randomUUID } from 'node:crypto';
import { createDb } from './db.js';
import { hashPassword } from './password.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const db = createDb(databaseUrl);
try {
  for (const [username, role] of [
    ['admin', 'admin'],
    ['viewer', 'viewer'],
  ] as const) {
    await db.query(
      `INSERT INTO users(id,username,password_hash,role) VALUES ($1,$2,$3,$4)
       ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role`,
      [randomUUID(), username, hashPassword(username), role],
    );
  }
  for (const id of ['account-01', 'account-02', 'account-03', 'account-04']) {
    await db.query('INSERT INTO accounts(id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  }
} finally {
  await db.end();
}
