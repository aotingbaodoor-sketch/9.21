import { randomUUID } from "node:crypto";
import { database, transaction } from "../server/db.ts";
import { hashPassword } from "../server/domain.ts";
import { userSchema } from "../shared/contracts.ts";
if (!process.env.DATABASE_URL) throw new Error("缺少 DATABASE_URL");
const input = userSchema.parse({
  name: process.env.ADMIN_NAME || "管理员",
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
  role: "admin",
});
if (!input.password)
  throw new Error("请通过服务器环境变量 ADMIN_PASSWORD 指定至少12位密码");
const pool = database(process.env.DATABASE_URL),
  hash = await hashPassword(input.password);
try {
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(825116)");
    if ((await db.query("SELECT 1 FROM users WHERE role='admin'")).rowCount)
      throw new Error(
        "管理员已存在，请在员工管理中创建其他账号；初始化不会覆盖现有密码",
      );
    await db.query(
      "INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), input.name, input.email, hash, "admin"],
    );
  });
  console.log("管理员初始化完成。请清除 ADMIN_PASSWORD 环境变量。");
} finally {
  await pool.end();
}
