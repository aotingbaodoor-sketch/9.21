import { database } from "./db.ts";
import { createApp } from "./app.ts";
import { refreshNotifications } from "./repository.ts";
import { createWhatsAppService } from "./whatsapp/service.ts";
import { waConfig } from "./whatsapp/security.ts";
import { createLinkedWorker } from "./whatsapp/linked-worker.ts";
if (!process.env.DATABASE_URL)
  throw new Error("缺少 DATABASE_URL，请配置服务器环境变量");
const pool = database(process.env.DATABASE_URL),
  port = Number(process.env.PORT || 3001);
const app = createApp(pool, {
  origin: process.env.APP_ORIGIN || "http://127.0.0.1:5173",
  production: process.env.NODE_ENV === "production",
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  serveStatic: process.env.NODE_ENV === "production",
});
const whatsapp = createWhatsAppService(pool, waConfig());
const linked = createLinkedWorker(pool, waConfig());
const linkedTimer = setInterval(() => {
  linked.tick().catch(() => console.error("关联设备后台任务失败，请检查连接状态；未输出凭据"));
}, 2500);
linkedTimer.unref();
const waTimer = setInterval(() => {
  whatsapp
    .tick()
    .catch(() => console.error("WhatsApp后台任务失败，请检查集成状态"));
}, 3000);
waTimer.unref();
await pool.query("SELECT 1 FROM settings WHERE id=1");
const server = app.listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log(`AUTINBERG CRM 服务已启动，端口 ${port}`),
);
const timer = setInterval(() => {
  refreshNotifications(pool).catch(() => console.error("提醒更新失败"));
  pool.query("DELETE FROM sessions WHERE expires_at<now()").catch(() => {});
}, 60000);
timer.unref();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    clearInterval(timer);
    clearInterval(waTimer);
    clearInterval(linkedTimer);
    server.close(() => {
      linked.stop().then(() => pool.end()).then(() => process.exit(0));
    });
  });
