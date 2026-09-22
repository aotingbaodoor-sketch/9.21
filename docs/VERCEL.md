# Vercel 部署

当前正式构建是 **Vite + Express Node 服务**，不是已经验证的 Next.js/Vercel 部署。仓库保留 `pages/[[...slug]].tsx` 和 `pages/api/[...path].ts` 适配文件，但 `npm run build` 实际执行 `build:crm`。不能据此宣称 Vercel 可以直接上线。

当前推荐按 `docs/RAILWAY.md` 部署完整 Node 容器，保留 PDF Chromium 渲染和 WhatsApp 后台任务。下列 Vercel 内容仅作为将来迁移的待验证参考；需要重新验证函数请求大小、PDF 浏览器运行时和独立后台任务后才能使用。

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
