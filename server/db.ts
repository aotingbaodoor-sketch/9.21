import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {migrationChecksum,matchesMigrationChecksum} from './migration-checksum.ts';
pg.types.setTypeParser(1082, (value) => value); // DATE 是业务日，不做本机时区转换。
export function database(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
  // pg emits idle-connection errors with a Client (and connection parameters).
  // Do not let Node dump credentials through an unhandled error event.
  pool.on('error',()=>console.error('数据库空闲连接中断，将重新连接；未输出连接参数'));
  return pool;
}
export type Db = pg.Pool | pg.PoolClient;
export async function transaction<T>(
  pool: pg.Pool,
  run: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const value = await run(db);
    await db.query("COMMIT");
    return value;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function migrate(pool: pg.Pool) {
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(825114)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())",
    );
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
    for (const name of (await readdir(dir))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(`${dir}/${name}`, "utf8"),
        checksum = migrationChecksum(sql);
      const exists = await db.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (exists.rowCount) {
        if (!matchesMigrationChecksum(sql,exists.rows[0].checksum))
          throw new Error(`已应用迁移被修改：${name}`);
        continue;
      }
      await db.query(sql);
      await db.query(
        "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
        [name, checksum],
      );
    }
  });
}
