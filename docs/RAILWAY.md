# Railway 上线核对

本项目使用 React/Vite + Express + PostgreSQL。`npm run build:crm` 是实际构建入口；Docker 包含 PDF 渲染所需 Chromium 和中文字体。Docker 启动命令先执行增量迁移，成功后才启动服务。迁移使用事务锁和文件校验，不会重复执行已应用迁移；失败时不启动网站。

Railway 已停用新服务对旧式 Config as Code 的支持，已有用户也将在 2026-12-01 停用。仓库中的 `railway.json` 仅保留给旧服务兼容使用，不能作为新服务配置成功的证明。新服务须核对控制台实际配置：Dockerfile 构建、使用 Docker 默认启动命令、健康检查路径 `/api/health`。若设置自定义启动命令，应使用 `sh -c 'node build/scripts/migrate.js && exec node build/server/index.js'`，不要绕过迁移。参考：[Railway 官方弃用说明](https://docs.railway.com/config-as-code)。

## 配置

- 连接指定仓库 `aotingbaodoor-sketch/9.21`。不要授权无关仓库，不要把本机数据库复制到公网。
- 在 Railway 服务的 Variables 中设置服务端 `DATABASE_URL`（Supabase 提供的 SSL 数据库连接串）、`APP_ORIGIN`（生成的 HTTPS 域名）、`NODE_ENV=production`、`HOST=0.0.0.0`。端口使用 Railway 注入的 `PORT`。
- 密码和连接串仅存于服务端密钥设置，不使用 `VITE_` 或 `NEXT_PUBLIC_` 前缀，不提交 Git，也不发聊天。
- Supabase 的 IPv4 Session pooler 可将密码单独保存为 Railway 的 `PGPASSWORD`，`DATABASE_URL` 中不包含密码，避免特殊字符编码错误。示例：`postgresql://postgres.PROJECT_REF@POOLER_HOST:5432/postgres?sslmode=verify-full&sslrootcert=/app/config/supabase-prod-ca.crt`。主机、端口和项目标识以 Supabase Connect 面板为准。不要把 `PGPASSWORD` 填成邮箱或 GitHub 密码。
- Docker 内置的是 Supabase 官方公共 CA 证书，不是私钥或客户端凭据。来源：`https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`（从项目 Database Settings 下载入口核对）。通过 `sslmode=verify-full` 校验证书与主机名；不要设置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或 `sslmode=no-verify`。供应商轮换 CA 后应重新核验并更新该公共证书。
- 当前认证由服务端 Cookie、CSRF 和角色检查实现，并非 Supabase Auth。迁移008为CRM表启用RLS并撤销公共、anon、authenticated权限；后端使用受信任的表所有者连接。Supabase项目应关闭Data API和自动公开新表，生产连接后还需复测实际匿名访问被拒绝。
- 首位管理员通过 `node build/scripts/create-admin.js` 初始化，临时使用 `ADMIN_EMAIL`、`ADMIN_NAME`、`ADMIN_PASSWORD`，完成后移除密码变量。脚本拒绝覆盖已有管理员。
- 不自动开通付费套餐，不自动启用 Meta 消息发送。真实产品价、汇率、货代价、银行信息由公司核实后填写。

## 验收

部署成功后核对 `/api/health`、HTTPS 登录、Secure/HttpOnly Cookie、两销售和两工厂账号隔离、PDF 下载、数据库重启持久化以及独立数据库恢复。应从另一台设备验证，不能用 `127.0.0.1` 代替正式网址。

目前照片和视频由数据库保存，尚未迁移至 Supabase Storage；单文件上限 8MB。文件不得公开访问。正式大量视频使用前必须完成私有 Storage 和授权下载改造。

参考：[Railway 配置文档](https://docs.railway.com/config-as-code/reference)、[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)。
