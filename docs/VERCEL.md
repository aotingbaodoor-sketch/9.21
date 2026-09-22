# Vercel 部署

本项目已迁移为 Next.js：`pages/[[...slug]].tsx` 承接 CRM 前端路由，`pages/api/[...path].ts` 承接原有 Express API。Vercel 不需要、也不应配置浏览器端数据库密钥。

## Vercel 环境变量

在 Vercel 项目 Settings → Environment Variables 中设置：

```text
DATABASE_URL=Supabase PostgreSQL 的 server-side connection string
APP_ORIGIN=https://你的正式域名
SESSION_HOURS=12
```

只有在启用 WhatsApp 官方 Cloud API 后才设置对应的 `WHATSAPP_*` 服务端变量。不要添加 `NEXT_PUBLIC_` 前缀，也不要提交 `.env`。

## 数据库

先将 `server/migrations/` 的增量 SQL 应用到 Supabase PostgreSQL，再部署 Vercel。首次管理员通过受控服务器环境或后续管理员功能初始化；不得在源码中设置默认账号或密码。

## 验证

1. 在 Vercel 导入 GitHub 仓库，Framework 识别为 Next.js。
2. 填写环境变量后部署；Vercel 自动执行 `npm run build`。
3. 打开 `/api/health`，应返回 `status: ok`。
4. 从正式域名登录，确认 Cookie、客户权限和 API 请求均正常。
