import './env.js';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const db = createDb(databaseUrl);

try {
  await db.query('SELECT pg_advisory_lock(872341)');
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const applied = new Set(
    (await db.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map(
      (r) => r.version,
    ),
  );
  const files = (await readdir(resolve(root, 'db/migrations')))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = Number(file.split('_')[0]);
    if (applied.has(version)) continue;
    await db.query(await readFile(resolve(root, 'db/migrations', file), 'utf8'));
    console.log(`Applied migration ${file}`);
  }
} finally {
  await db.query('SELECT pg_advisory_unlock(872341)').catch(() => undefined);
  await db.end();
}
