# 奥汀堡 CRM：WhatsApp 官方接入与运维

本版只使用 Meta WhatsApp Business Platform Cloud API、官方 Embedded Signup 和签名 Webhook。没有 WhatsApp Web 自动化、扫码托管、破解接口、员工密码收集或 AI 自动发送。

**重要：本地模拟接口测试不等于真实 WhatsApp 收发验收。** 真实接入还需要公司 HTTPS 服务、Meta 企业/App 权限、测试 WABA/号码、Token 及 Webhook 配置。当前不承诺历史聊天同步，也不自动注册、注销、删除或迁移现有号码。

## 1. 先保护现有号码

在连接正式号码前，由号码持有人和管理员在 Meta 后台逐项确认：

- 是否还在 WhatsApp Business App 使用；是否已有 Cloud API 绑定。
- 企业验证、显示名称审核、国家/地区及账号是否允许所需能力。
- 官方 Coexistence 是否对该账号/号码开放，接入后手机 App 是否可继续使用。
- 联系人、历史消息、设备和备份有什么影响；是否确实需要迁移。
- 如涉及迁移，先备份、明确影响并单独获得持有人确认。本 CRM 的绑定命令不执行迁移。

资格只能在实际 Meta 账号中核验，不能凭一个电话号码判断。本版 Embedded Signup 支持接收正式授权结果，但 **Coexistence 上线流程、历史同步以及真实账号授权均待验证**。先用 Meta 测试号码验收，再决定正式号码路线。

## 2. 数据与升级

在现有 PostgreSQL 上执行增量迁移 `server/migrations/003_whatsapp.sql`，不删除原客户、员工或跟进。升级前先在旧版本执行 `npm run db:backup`，保留对应代码版本；迁移后重新备份。

```bash
npm ci
npm run db:setup
npm run build
npm start
```

生产 Docker 部署沿用 README：应用、数据库和 Caddy 一起部署。`compose.yaml` 从服务器的 `.env.production` 为应用注入机密；必须保持 `postgres_data` 持久卷，不得使用 `down -v`。公网数据库端口不开放。

WhatsApp 绑定、身份索引、客户、会话、消息、发送状态、归属历史、待确认资料、未读记录和队列全部在 PostgreSQL。原始 Webhook 事件以 AES-256-GCM 加密保存；消息用于界面展示，数据库及备份本身仍含个人信息，必须限制访问并加密备份。媒体经服务端从 Meta 下载、以 base64 缓存在数据库（单文件上限25MB），不保存带 Token 的公开下载地址。大量媒体部署需监测数据库容量；本版尚未接入对象存储或自动清理保留期。

## 3. 服务端环境变量

使用 `.env.example` / `.env.production.example`。所有秘密只能留在服务器环境或受访问控制的机密存储，不能添加 `VITE_` 前缀、提交 Git 或粘贴到客户备注。

| 变量 | 用途 |
| --- | --- |
| `APP_ORIGIN` | 公司完整 HTTPS 源站地址，无末尾斜杠 |
| `WHATSAPP_APP_ID` | Meta App ID，可显示在配置页 |
| `WHATSAPP_APP_SECRET` | 校验原始请求签名和服务端授权交换，不能回显 |
| `WHATSAPP_VERIFY_TOKEN` | 自行生成的高强度随机 Webhook 验证值，与 Meta 配置一致 |
| `WHATSAPP_ENCRYPTION_KEY` | 独立32字节随机密钥，64位十六进制；必须离线单独备份 |
| `WHATSAPP_GRAPH_VERSION` | 在 Meta 控制台确认受支持的 `v数字.数字` 版本；无隐式默认版本 |
| `WHATSAPP_SIGNUP_CONFIG_ID` | Facebook Login for Business / Embedded Signup 正式配置 ID |
| `WHATSAPP_TOKEN_*` | 已有公司 Cloud API 号码使用的服务端 Token 引用，按需设置 |

加密密钥可在服务器通过 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成，直接存入服务器机密存储。**重新部署时不得随意重生成加密密钥**，否则已有授权和待处理事件无法解密。授权模式的 Token 加密在数据库，引用模式的 Token 值只在对应环境变量；两个模式都不会返回给浏览器或管理员界面。

## 4. Meta 后台配置（由有权限的管理员操作）

1. 创建或选择公司的 Meta Business Portfolio，按实际用途完成企业信息和要求的验证。
2. 创建 Meta App，添加 WhatsApp 产品。先使用测试 WABA/测试号码，记录 WABA ID、Phone Number ID。
3. 如要用正式号码，先完成第1节保护检查，再由持有人在官方流程添加及验证号码、核对显示名称。不要直接把正在手机 App 使用的号码注销。
4. 在服务器配置上表变量；账号授权应具备所需的 `whatsapp_business_management` 与 `whatsapp_business_messaging` 权限。临时测试 Token 只用于测试，过期后不应继续用于生产。
5. Webhook 回调填写：`https://你的CRM域名/api/whatsapp/webhook`。Verify Token 必须与服务器值一致。GET 验证成功后，订阅 `messages` 字段；消息及状态回执均由此进入。
6. 订阅应用到目标 WABA。安全绑定命令 / Embedded Signup 完成时调用官方 `WABA_ID/subscribed_apps`；后台“测试连接”会核对当前 App 的订阅状态。
7. 为已有公司 Cloud API 号码配置正式服务端 Token；或配置 Facebook Login for Business / Embedded Signup（App 域名、HTTPS、所需权限/审核、配置 ID 等需按实际 Meta 控制台确认）。未完成官方 App 审核/访问级别时，不能假设任意员工企业均可授权。
8. 在 Meta 测试界面添加允许的测试接收人；让测试外部号码给业务测试号码发第一条消息。
9. 在 CRM 核对联系人、来源、负责人、唯一客户、聊天和未读；人工回复，确认外部设备收到消息及送达/已读回执。
10. 完成下方真实验收清单与备份恢复检查后，再切换正式环境。客户同意、模板审核及收费由公司管理员确认，不自动群发。

官方资料入口：[Meta维护的Cloud API参考](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)、[Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview)、[Business App接入说明](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)、[WhatsApp商业消息政策](https://business.whatsapp.com/policy)。Meta 控制台权限与资格以实际账号为准，不能把入口存在当成资格确认。

## 5. 员工绑定

### A. 员工独立正式授权

CRM登录 → 我的 WhatsApp（或系统设置里的入口）→ 确認号码前置检查 → 准备 Meta 官方授权 → 打开 Meta 官方授权。

使用 Meta 官方页面登录和授权，不向 CRM 提供 WhatsApp 密码。浏览器仅将一次性 code 和 WABA/号码 ID 交给服务器。服务器验证授权会话、App、权限和号码归属后绑定。会话10分钟有效且一次性使用，不能把已绑定其他员工的号码抢到自己名下。此路径真实 Meta 验收待完成。

### B. 已有公司 Cloud API 号码由部署管理员安全绑定

在服务器机密存储或受保护的 `.env` 设置以下变量（下面均为说明，不是真实凭据）：

```dotenv
WHATSAPP_TOKEN_SALES_A=<服务器正式Token>
WHATSAPP_BIND_EMAIL=<已创建且在职的CRM员工邮箱>
WHATSAPP_BIND_WABA_ID=<对应WABA ID>
WHATSAPP_BIND_PHONE_ID=<对应Phone Number ID>
WHATSAPP_BIND_TOKEN_ENV=WHATSAPP_TOKEN_SALES_A
WHATSAPP_BIND_CONFIRMED=EXISTING_CLOUD_API_ONLY
```

```bash
npm run whatsapp:bind
# 已构建的服务器 / Docker 容器：
node build/scripts/whatsapp-bind.js
```

命令验证官方 WABA/号码后保存映射，不执行 `register` 或 `deregister`。每个号码只能有一名绑定员工。完成后保留运行所需的 `WHATSAPP_TOKEN_SALES_A`，清除临时 `WHATSAPP_BIND_*` 即可。Docker 可在服务器配置后重建应用再用 `docker compose --env-file .env.production exec app node build/scripts/whatsapp-bind.js` 执行。不得把 Token 放进命令行参数、截图或聊天。

断开连接需要明确确认：只断开 CRM 并清除其本地凭据，不注销号码，不删除客户/聊天，不自动撤销 Meta WABA 订阅。后续事件会保留待管理员处理。重新授权或重新运行绑定命令可恢复连接；号码移交需要管理员先调整绑定员工，客户移交是单独操作。

## 6. 销售使用与规则

- 新消息按 `phone_number_id` 映射员工。全球 `wa_id` 唯一身份索引 + 标准化号码/电话/邮箱/公司与国家匹配防止重复。跨员工疑似重复不复制客户，管理员核对；普通员工只收到通用提示。
- 自动客户的公司/国家/产品保持空白，联系人来自 profile 或“WhatsApp新客户”，默认 C/新询盘/今日待跟进。收到消息更新首次/最后联系，不冒充销售已完成跟进。
- 文字规则只提取明确信息放入待确认区；确认才写客户字段，版本冲突返回409。无外部 AI 模型，不声称已启用 AI。
- 客户详情 → WhatsApp 聊天，查看最新50条，翻页查看更早历史。收件箱显示最近100位客户；完整客户可在客户管理中搜索/分页。显式“标记已读”只影响本人。
- 只允许当前负责人使用本人绑定的正常号码发送；管理员可代为处理。归属变化后历史保留，但不会把原员工的号码自动借给新员工发送。
- 24小时窗口内支持人工文本/引用回复，窗口外必须使用已审核模板并确认客户同意。模板在“我的WhatsApp”同步，缓存超过24小时要求重新同步；第一版发送只支持静态文字和正文位置参数模板，动态媒体、按钮、命名参数模板仅展示而不允许发送。
- 明确发送失败可以重试；超时/断连导致结果不明，标记“待确认”并等待官方回执，不盲目重发。状态按 sent/delivered/read 防止乱序降级。
- 新消息提醒与30/120/1440分钟未回复提醒可在集成设置调整；按最早未回复消息计时并去重。Webhooks 队列每3秒处理，页面5–15秒可见时刷新。
- 管理员可选择移交后消息归属：保持当前负责人、号码绑定员工、待分配池；新发现的跨员工重复始终先由管理员确认。停用员工旧会话立即失效，后续入站保留给管理员处理。

## 7. 安全、备份与运行

Webhook HMAC-SHA256 验证原始字节，密钥缺失返回503，伪造签名返回401。先持久化加密事件再返回200；事件哈希和 `whatsapp_message_id` 双重幂等。数据库事务保护建客户/消息/通知，提取失败有保存点隔离。后台使用行锁领取任务；接收失败最多8次指数退避，再由管理员排查及重试。外部网络调用不占持久数据库事务锁。

监测“WhatsApp集成”中的接收时间、事件成功状态、重试/失败、签名失败次数、连接告警；同时监控应用进程、PostgreSQL容量、备份、HTTPS证书和网络访问 Meta 能力。没有消息时不能仅凭接收时间认定服务异常。当前没有接入短信/邮件告警或外部监控平台。

`npm run db:backup` 包含 WhatsApp 全部业务表、媒体和待处理队列；不恢复会话或短期授权会话。恢复到相同迁移版本的独立空库，验证后再切换连接。必须同时安全恢复原加密密钥、App Secret、正式 Token 环境变量；数据库备份不包含这些服务器机密。不要启动恢复演练库的发送 worker 连接真实 Meta，避免重放待发送任务。演练使用网络隔离和测试传输。

## 8. 实际测试与真实验收区分

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
npm run test:whatsapp
```

WhatsApp测试使用独立 PostgreSQL（55449）、HTTP（4499）和随机管理员/销售A/B，直接注入签名 Webhook，使用测试 Meta 传输替身及 Edge 桌面/390px移动视口。不会读取正式 DATABASE_URL 或向任何真实 WhatsApp 号码发消息。测试结果以控制台 `ALL ... PASSED` 和系统临时目录 `autinberg-whatsapp-test/<runId>/results.json` 为准。详情见 [WhatsApp验收记录](WHATSAPP-ACCEPTANCE.md)。

真实外部验收待办：HTTPS回调可达、Meta App审核/权限、测试WABA和两名员工号码授权、两个外部客户设备真实收发、实际媒体显示/播放下载、送达/已读回执、Token撤销、断开重连、Coexistence资格及手机App影响、公司手机网络和目标服务器备份演练。以上未验证前不能称为真实WhatsApp生产验收通过。
