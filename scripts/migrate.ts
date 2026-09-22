import { database, migrate } from "../server/db.ts";
if (!process.env.DATABASE_URL) throw new Error("缺少 DATABASE_URL");
const pool = database(process.env.DATABASE_URL);
try {
  await migrate(pool);
  console.log("数据库迁移完成（不会清空已有业务数据）");
} finally {
  await pool.end();
}
