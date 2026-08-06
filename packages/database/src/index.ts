import pg from 'pg';

const { Pool } = pg;

export type DatabasePool = InstanceType<typeof Pool>;

export function createDatabasePool(connectionString: string): DatabasePool {
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3_000,
  });
}

export async function checkDatabase(pool: DatabasePool): Promise<void> {
  await pool.query('SELECT 1');
}
