import pg from 'pg';

const { Pool } = pg;
export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export function createDb(connectionString: string): Db {
  return new Pool({ connectionString, max: 20 });
}

export async function transaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function emitEvent(
  client: Pick<DbClient, 'query'>,
  type: string,
  payload: unknown,
): Promise<void> {
  await client.query('INSERT INTO frontend_events(type,payload) VALUES ($1,$2)', [type, payload]);
  await client.query(`SELECT pg_notify('frontend_events', $1)`, [type]);
}
