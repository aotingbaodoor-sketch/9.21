# 奥汀堡CRM · AUTINBERG CRM

佛山奥汀堡建材公司销售团队使用的轻量 CRM。React/Vite 前端配合 Express/TypeScript 服务端与 PostgreSQL，共享同一个数据库。保留深灰侧栏、金色强调和中文业务界面。

## 运行条件与安装

需要 Node.js 24+、npm 与 PostgreSQL 18。正式环境需要一台可运行 Docker Compose 的服务器、域名及 HTTPS。服务器数据库不对外暴露。

```bash
npm ci
```

### 本地开发（真实 PostgreSQL，无演示账号）

在第一个终端运行：

```bash
npm run db:local
```

它启动仅监听 127.0.0.1:55432 的本地 PostgreSQL，第一次生成随机数据库密码到被 Git 忽略的 `.local/database.json`，并且**只在不存在时**生成 `.env`。不创建任何用户或客户，不覆盖已有配置。保持该终端运行。

另一个终端运行：

```bash
npm run db:setup
```

已有 PostgreSQL 时，将 `.env.example` 复制为 `.env` 并设置 `DATABASE_URL`，跳过 `db:local`。数据库迁移是增量迁移，重复运行不会清空数据；已应用迁移有校验，不要修改历史迁移文件。

### 初始化首位管理员

不能通过网页注册管理员。服务器操作人员临时设置 `ADMIN_EMAIL`、`ADMIN_NAME`、`ADMIN_PASSWORD`，然后运行：

```bash
npm run admin:init
```

密码至少12位，使用自己的高强度密码。**没有默认公共密码，没有自动演示账号。** 已有管理员时初始化命令拒绝覆盖。初始化后删除临时密码环境变量。

PowerShell 示例（密码隐藏输入）：

```powershell
$env:ADMIN_EMAIL = '填写你的管理员邮箱'
$env:ADMIN_NAME = '管理员'
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host '管理员初始密码，至少12位' -AsSecureString)).Password
npm run admin:init
Remove-Item Env:ADMIN_PASSWORD
```

启动应用：

```bash
npm run dev
```

打开 http://127.0.0.1:5173 。必须与 `APP_ORIGIN` 一致；开发代理将 /api 转给 3001 端口。此地址仅供本机开发，团队使用方式见 [部署说明](docs/DEPLOYMENT.md)。

生产构建与启动：

```bash
npm run build
npm start
```

生产需 `NODE_ENV=production`、HTTPS `APP_ORIGIN` 和数据库地址。前端和 /api 由同一 Node 服务提供，不要只上传 dist 文件。

## 使用流程

1. 管理员登录，在“员工管理”创建独立销售账号，可以修改角色、停用或重置密码。
2. 管理员添加客户并选择负责人；销售新增客户时负责人只能是自己。
3. 点击公司名称查看资料和跟进时间线，点击“跟进”保存内容、客户反馈、下一步计划和下次日期。
4. 工作台、今日跟进、提醒中心、统计均从服务器读取，不再使用前端种子数组。
5. 管理员可将客户移入回收站并恢复，原有跟进记录保留。
6. 员工可在“系统设置 → 个人资料”修改姓名、头像和密码。没有员工管理及系统规则修改权限。

客户支持等级、销售阶段、国家、来源、负责人、跟进状态、标签筛选，搜索公司/联系人/联系方式，分页和受权限限制的 JSON 导出。详情提供邮箱、电话、WhatsApp、网址和复制操作。采用单客户负责人分配；第一版未提供批量分配。

## ABCD 与日期

“系统设置”中管理员可修改周期，默认 A=1、B=3、C=7、D=30 天；默认业务时区 Asia/Shanghai。

下次跟进保存为 PostgreSQL DATE，跟进发生时间保存为 timestamptz。今天由服务端按配置时区计算。保存跟进时在同一事务内新增记录并更新最后/下次跟进。手动日期优先，留空按等级在业务日期上增加周期。修改周期只影响之后的计算，不会重写已保存的日期。

## 数据具体保存在哪里

- 正式部署：PostgreSQL 服务的 `postgres_data` 持久卷。容器/应用重启、镜像更新不删除这个卷。禁止使用 `docker compose down -v` 清理生产环境。
- 本地开发：Windows 默认使用用户目录 `AUTINBERG-CRM-data/<项目标识>/postgres`，避开 PostgreSQL 对中文路径的编码限制；Linux 使用项目下 `.local/postgres`。可通过 LOCAL_DB_DIR 指定持久目录，启动时会打印实际位置。数据库密码保存在本项目 `.local/database.json`。停止服务不会删除数据。
- 隔离测试：Windows 数据目录为系统临时目录 `autinberg-test-db/<随机运行ID>/postgres`，Linux 为 `.test-data/<随机运行ID>/postgres`，与业务库完全分离。不自动清空业务库。
- 浏览器只接收授权数据和 HttpOnly 会话 Cookie；客户、员工、跟进、设置、提醒、审计日志均在数据库。localStorage 不再作为业务数据或权限依据。
- 表：users、sessions、customers、follow_up_records、notifications、settings、audit_logs、import_batches、imported_rows、idempotency_keys 等。客户扩展资料和标签存于 JSONB；负责人、等级、阶段和业务日期为独立索引字段。

## 保护旧浏览器数据

旧版数据 `abcrm` / `ab-customers` 不会被删除。管理员进入“旧数据导入”：

1. 在原先保存数据的网址和浏览器打开，点击“备份并读取当前浏览器旧客户”，或上传已经导出的 JSON。
2. 原始备份下载到电脑，核对旧负责人对应的正式员工账号。不同网址的浏览器存储互相隔离，不能自动读取其他网址的数据。
3. 点击预检，检查重复公司、邮箱、电话、WhatsApp、网址及已导入状态。重复项默认不勾选。
4. 明确选择要导入的客户后确认。导入为事务，保留源文件，不覆盖已有客户。
5. 下载导入回执，逐个点击客户核对。核对成功后也无需删除旧数据，建议保留原始备份。

该入口迁移客户资料。旧原型没有持久保存跟进内容；如果其他旧版本中确有跟进数据，原始备份中的 records 必须保留，不能把客户导入当作跟进记录导入。服务器完整历史迁移请使用数据库备份恢复。

## 登录与权限

密码使用独立随机盐的 scrypt 哈希。随机会话令牌只以哈希保存在服务器，会话默认12小时过期，生产 Cookie 为 Secure、HttpOnly、SameSite=Strict。登录有账号/IP 限流；写请求要求同源、CSRF 令牌和幂等键。

服务端对详情、搜索、跟进、统计、提醒、导出进行负责人范围限制；销售不能改负责人或管理员工。员工停用、编辑角色或重置密码会撤销已有会话。每次请求重新查询账号启用状态；不能靠猜ID访问别人客户。

客户、设置、员工编辑携带版本号，旧版本返回409，不会静默覆盖。前端会显示错误并保留表单供核对；取消后重新打开可读取最新版本。同一写请求重试使用同一幂等键，数据库事务避免重复保存。

## 备份与恢复

```bash
npm run db:backup
# 或指定一个尚不存在的备份文件
npm run db:backup -- backups/manual-backup.json
```

备份包含客户、员工密码哈希、历史、设置、提醒、审计、导入与幂等记录，使用一致性快照并附 SHA256 校验。备份包含敏感信息，应加密后复制到独立存储，限制访问，定期演练。普通客户导出不是完整数据库备份。

恢复**只能到新建、无业务数据的独立数据库**：

1. 使用备份对应版本的代码，对新的恢复数据库运行 `db:setup`。
2. 保留当前业务库的 `DATABASE_URL`，将新库地址设置为 `RESTORE_DATABASE_URL`。
3. 设置 `CONFIRM_RESTORE=EMPTY_DATABASE_ONLY`，运行下列命令：

```bash
npm run db:restore -- backups/manual-backup.json
```

4. 检查恢复后的客户数量、历史、员工与规则。恢复后会话不恢复，所有员工重新登录。
5. 验证通过后再在维护窗口切换应用的数据库地址。不得直接覆盖运行中的数据库。

恢复器拒绝非空目标、源/目标相同、损坏备份和迁移版本不一致。原文件与原数据库均保留。正式环境也可使用 PostgreSQL 原生 pg_dump/pg_restore 或托管数据库快照。

## 工程与验证

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
```

综合测试会自行创建独立 PostgreSQL、管理员和销售A/B，启动 4399 测试服务，在 55439 启动测试数据库；不会使用 DATABASE_URL，也不会导入生产数据。两个测试端口须空闲。Windows 使用已安装的 Edge 无头浏览器；Linux 先运行 `npx playwright install --with-deps chromium`。截图默认保存在系统临时目录，可用 ARTIFACT_DIR 指定。

- `src/crm/`：路由、业务页面、表单、报价、供应链与会话 UI；没有明文账号表。
- `shared/contracts.ts`：共享类型和表单/API 校验。
- `server/app.ts`：接口、认证、权限与事务写入。
- `server/repository.ts`：客户查询、统一范围限制、提醒等数据库访问。
- `server/migrations/`：只新增的数据库迁移。
- `scripts/`：管理员初始化、迁移、本地数据库、备份恢复。
- `tests/`：日期/密码及真实数据库、浏览器验收。
- `Dockerfile`、`compose.yaml`、`deploy/Caddyfile`：整套服务部署。

品牌目前使用 AUTINBERG / 奥汀堡文字标识，没有编造正式 Logo。提供官方 Logo 后，可在登录和侧栏品牌组件中接入原图并保持比例。系统名称和公司名称可在管理员设置中修改。

## 验收状态与上线阻塞

### WhatsApp 官方集成增量版

新增员工号码管理、签名 Webhook、持久队列、客户自动录入与跨员工重复处理、聊天/鉴权媒体、人工回复与模板、未读/超时提醒、归属移交和统计。沿用现有真实账号及服务端权限，不使用 WhatsApp Web、不收集员工 WhatsApp 密码。

完整配置、号码保护、员工授权、安全绑定命令、测试方法及外部待办见 [WhatsApp接入说明](docs/WHATSAPP.md)；增量迁移为 `server/migrations/003_whatsapp.sql`，环境变量样例已补充。后台入口：`/whatsapp`、`/whatsapp/account`、`/whatsapp/integration`；客户详情有“WhatsApp聊天”标签。运行 `npm run test:whatsapp` 验证隔离模拟链路，不能当成真实 WhatsApp 收发成功。

已实际通过 lint、严格类型检查、生产构建、4项单元测试、11组原CRM真实数据库/API/桌面和手机尺寸回归、14组WhatsApp隔离测试（仅Meta传输模拟），包括独立数据库恢复演练。原版结果见 [验收记录](docs/ACCEPTANCE.md)，本次最新运行和外部待办见 [WhatsApp验收记录](docs/WHATSAPP-ACCEPTANCE.md)。未执行的环境和流程不列为已验收。

用户已提供过主机服务商登录信息，但仍未确认可用VPS、服务器部署入口、域名DNS和正式数据库；服务商登录不等于已获得上述资源。公共 HTTPS 上线、证书签发、公司设备外网访问以及目标服务器 Docker 部署仍为待验证。没有购买服务、没有虚构上线网址。开发测试通过不等于已完成公司服务器上线验收。
