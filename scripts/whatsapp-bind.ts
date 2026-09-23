import { z } from "zod";
import { database } from "../server/db.ts";
import { waConfig, hasKey } from "../server/whatsapp/security.ts";
import { graphApi, verifyAppToken } from "../server/whatsapp/graph.ts";
import { bindAccount, verifyPhone } from "../server/whatsapp/service.ts";

// 仅限部署管理员在服务器执行；Token值从环境变量读取，不接收命令行明文。
const input = z
  .object({
    email: z.email(),
    waba: z.string().regex(/^\d{5,30}$/),
    phone: z.string().regex(/^\d{5,30}$/),
    reference: z.string().regex(/^WHATSAPP_TOKEN_[A-Z0-9_]+$/),
  })
  .parse({
    email: process.env.WHATSAPP_BIND_EMAIL,
    waba: process.env.WHATSAPP_BIND_WABA_ID,
    phone: process.env.WHATSAPP_BIND_PHONE_ID,
    reference: process.env.WHATSAPP_BIND_TOKEN_ENV,
  });
if (process.env.WHATSAPP_BIND_CONFIRMED !== "EXISTING_CLOUD_API_ONLY")
  throw new Error(
    "请先确认是已有Cloud API号码，并设置 WHATSAPP_BIND_CONFIRMED=EXISTING_CLOUD_API_ONLY；本命令不注册、注销或迁移号码",
  );
const config = waConfig(),
  token = process.env[input.reference];
if (
  !hasKey(config) ||
  !token ||
  !process.env.DATABASE_URL ||
  !config.appId ||
  !config.appSecret ||
  !config.verifyToken ||
  !config.graphVersion
)
  throw new Error("缺少数据库、独立加密密钥或服务端Token环境变量");
const pool = database(process.env.DATABASE_URL),
  graph = graphApi(config);
try {
  const user = (
    await pool.query(
      "SELECT id FROM users WHERE lower(email)=lower($1) AND active",
      [input.email],
    )
  ).rows[0];
  if (!user) throw new Error("绑定员工不存在或已停用");
  await verifyAppToken(graph, config, token);
  const phone = await verifyPhone(graph, input.waba, input.phone, token);
  await graph.request(`${input.waba}/subscribed_apps`, token, "POST", {});
  const result = await bindAccount(
    pool,
    config,
    {
      userId: user.id,
      wabaId: input.waba,
      phone,
      tokenReference: input.reference,
      subscriptionStatus: "subscribed",
    },
    null,
  );
  console.log(
    `绑定已保存，ID=${result.id}。请使用Meta测试号码验证收发；服务端Token环境变量须持续保留，不得公开。`,
  );
} catch {
  console.error(
    "绑定未完成。请检查服务端配置、员工、号码归属及官方权限；原号码不会被迁移或注销。",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
