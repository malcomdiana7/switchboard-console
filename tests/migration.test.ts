import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('database migration', () => {
  it('creates the complete schema', async () => {
    const db = new PGlite();
    const directory = new URL('../db/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).sort()) {
      await db.exec(await readFile(new URL(file, directory), 'utf8'));
    }
    const result = await db.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(result.rows).toEqual([{ version: 1 }, { version: 2 }]);
    await db.close();
  }, 30_000);
});
