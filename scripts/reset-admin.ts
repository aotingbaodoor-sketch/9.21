import { database } from "../server/db.ts";
import { hashPassword } from "../server/domain.ts";

const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || "");
const name = String(process.env.ADMIN_NAME || "管理员").trim();

if (!process.env.DATABASE_URL) throw new Error("缺少 DATABASE_URL");
if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("管理员邮箱格式无效");
if (password.length < 12) throw new Error("CRM 管理员密码至少需要 12 位");
if (!name || name.length > 80) throw new Error("管理员姓名无效");

const pool = database(process.env.DATABASE_URL);
try {
  const admins = await pool.query("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 2");
  if (admins.rows.length !== 1) throw new Error("只能在恰有一名管理员的初始化环境中重置账号");
  const duplicate = await pool.query("SELECT id FROM users WHERE email=$1 AND id<>$2", [email, admins.rows[0].id]);
  if (duplicate.rowCount) throw new Error("该邮箱已属于另一名员工，不能覆盖");
  const passwordHash = await hashPassword(password);
  await pool.query("UPDATE users SET email=$2,name=$3,password_hash=$4,active=true,version=version+1 WHERE id=$1", [admins.rows[0].id, email, name, passwordHash]);
  await pool.query("DELETE FROM sessions WHERE user_id=$1", [admins.rows[0].id]);
  console.log("管理员账号已安全重置，请返回 CRM 使用新邮箱和密码登录。");
} finally {
  await pool.end();
}
