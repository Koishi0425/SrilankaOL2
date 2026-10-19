import type { DatabaseClient, DatabasePool } from '@srilanka/database';
export async function authTransaction<T>(
  database: DatabasePool,
  operation: (db: DatabaseClient) => Promise<T>,
) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    const result = await operation(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
