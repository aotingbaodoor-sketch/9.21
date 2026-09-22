# Railway 上线核对

本项目使用 React/Vite + Express + PostgreSQL。`npm run build:crm` 是实际构建入口；Docker 包含 PDF 渲染所需 Chromium 和中文字体。`railway.json` 配置部署前增量迁移和数据库健康检查。

## 配置

- 连接指定仓库 `aotingbaodoor-sketch/9.21`。不要授权无关仓库，不要把本机数据库复制到公网。
- 在 Railway 服务的 Variables 中设置服务端 `DATABASE_URL`（Supabase 提供的 SSL 数据库连接串）、`APP_ORIGIN`（生成的 HTTPS 域名）、`NODE_ENV=production`、`HOST=0.0.0.0`。端口使用 Railway 注入的 `PORT`。
- 密码和连接串仅存于服务端密钥设置，不使用 `VITE_` 或 `NEXT_PUBLIC_` 前缀，不提交 Git，也不发聊天。
- 当前认证由服务端 Cookie、CSRF 和角色检查实现，并非 Supabase Auth。Supabase Data API 不应暴露 CRM 数据表；生产连接前需配置 RLS/授权并验证匿名访问被拒绝。
- 首位管理员通过 `node build/scripts/create-admin.js` 初始化，临时使用 `ADMIN_EMAIL`、`ADMIN_NAME`、`ADMIN_PASSWORD`，完成后移除密码变量。脚本拒绝覆盖已有管理员。
- 不自动开通付费套餐，不自动启用 Meta 消息发送。真实产品价、汇率、货代价、银行信息由公司核实后填写。

## 验收

部署成功后核对 `/api/health`、HTTPS 登录、Secure/HttpOnly Cookie、两销售和两工厂账号隔离、PDF 下载、数据库重启持久化以及独立数据库恢复。应从另一台设备验证，不能用 `127.0.0.1` 代替正式网址。

目前照片和视频由数据库保存，尚未迁移至 Supabase Storage；单文件上限 8MB。文件不得公开访问。正式大量视频使用前必须完成私有 Storage 和授权下载改造。

参考：[Railway 配置文档](https://docs.railway.com/config-as-code/reference)、[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)。
