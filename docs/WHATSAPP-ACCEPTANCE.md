# WhatsApp 增量版交付与验收记录

日期：2026-09-21。结论：**代码、增量数据库、签名接收器、权限、队列及本地模拟联调通过；尚未完成真实 Meta / 公网生产验收。**

## 实际环境与工程检查

- Windows、Node.js 24.14、PostgreSQL 18、React/Vite + Express；保留原有界面与业务功能。
- 本地入口 `http://127.0.0.1:5173/login`、API 3001、本地业务库55432。HTTP检查：登录页200、健康检查200、未登录集成接口401、未配置机密的Webhook503（安全关闭，非接入成功）。
- 测试采用独立数据库和随机账号；WhatsApp测试 HTTP4499/PG55449；原CRM测试 HTTP4399/PG55439。Meta传输是依赖注入的替身，生产传输固定官方域名，无“模拟模式”环境开关。
- Browser plugin / `browser`技能未列出，按 frontend-testing-debugging 使用项目 Playwright + 已安装 Edge。桌面1440×1000、移动390×844；不是实体手机测试。后续可启用专用 Browser 插件开展交互验收。

| 命令 | 最终结果 |
| --- | --- |
| `npm run lint` | 通过，警告视为失败 |
| `npm run typecheck` | 通过，前后端严格类型检查 |
| `npm test` | 4项通过 |
| `npm run build` | 通过；前端、服务端、迁移和CLI完成打包 |
| `npm run test:integration` | 11组通过，退出码0 |
| `npm run test:whatsapp` | 14组通过，退出码0；真实数据库/HTTP/浏览器，模拟Meta传输 |

曾遇到 Windows 沙箱内 tsx 的 `uv_os_get_passwd ENOMEM`，经批准在主机环境重跑通过；不是把失败的测试忽略。浏览器最初把登录前 `/auth/me` 的预期401计为错误，已仅排除此明确预期响应并重跑。

## 14组 WhatsApp 检查

1. AES-GCM凭据加密/解密、拒绝错误密钥、国际号码标准化、HMAC和24小时边界。
2. 管理员创建销售A/B、各自真实登录、号码唯一绑定、跨员工号码接口拒绝、永久Token不回显且加密入库。
3. 授权服务端模拟：缺HTTPS拒绝、会话绑定本人、防跨账号使用、一次性消费。**官方弹窗真实授权待验证**。
4. GET订阅验证、伪造POST拒绝、先持久化后ACK、同批/不同批重复消息幂等、一个客户一条记录、A/B归属及越权接口404、待确认信息和版本冲突。
5. 图片/语音/文档入库及缓存、文件内容/Range鉴权下载、其他销售和匿名访问拒绝；联系人、地址、引用和未知类型保留。**真实语音/视频播放待验证**。
6. 注入资料提取写库异常，消息仍保存、产生管理员告警。
7. 人工回复排队幂等、状态早于HTTP响应和乱序不降级、明确失败重试、结果不明不盲目重发、迟到回执修复、24小时窗口、模板审批/参数/同意校验。
8. 30/120/1440分钟去重提醒，按最早未回复消息计时；已读标记只影响本人。
9. 客户联系两名销售时不复制、不暴露其他客户；管理员移交、三种后续入站规则、归属历史保留。
10. 后台发送前重新校验客户归属；Token失效与未知号码事件保留重试、管理员可见明确告警。
11. 独立数据库完整恢复（含媒体、绑定和加密凭据）、拒绝非空库覆盖、旧会话不恢复、应用与PostgreSQL真实重启后数据保留。
12. 桌面/移动：登录 → 集成状态/收件箱搜索 → 客户聊天 → 手机人工回复 → 刷新看到已发送 → 越权页面及接口拒绝。统计每日数据、管理员归属筛选分页接口也实际检查。
13. 停用员工后旧API/浏览器会话401；停用号码后续入站交管理员，移交历史保留。
14. 断开仅清除CRM凭据，客户消息不删除；同员工可重新绑定。没有调用Meta注销/迁移接口。

## 前端QA

| 检查 | 结果/证据 |
| --- | --- |
| 页面身份/非空 | 登录后指定路由和标题/主要区块出现 |
| 框架错误覆盖层 | 桌面、移动截图未见Vite错误覆盖层 |
| 控制台/运行时 | 桌面无非预期控制台错误；桌面/移动无捕获的JS运行异常；预期401/404单独处理 |
| 交互 | 手机收件箱搜索命中、回复提交提示、刷新后显示消息及已发送状态；跨销售访问明确拒绝 |
| 响应式 | 390px无文档横向溢出；回复表单/按钮可见，已检查截图；原CRM手机导航、新增/跟进回归亦通过 |
| 未覆盖 | 平板、实体iOS/Android、弱网长时运行、屏幕阅读器/完整无障碍审计、高并发压测 |

技能影响：沿用环境检查与React实践保持现有栈；PostgreSQL实践用于查询索引、短事务和队列锁；前端测试/visual-qa用于实际浏览器与移动截图检查，而非只凭构建通过交付。

## 原始证据

- WhatsApp运行ID：`b9501481-8890-4611-ad5e-177088d53396`，完成于2026-09-21 21:35:41（上海）。系统临时目录 `autinberg-whatsapp-test/<运行ID>/results.json`；同目录有 `desktop-integration.png`、`mobile-chat.png`、`mobile-reply.png`。
- 原CRM回归ID：`ea3ad402-8dcd-4b9a-abb3-be3eeaeb7b7e`，完成于2026-09-21 21:36:03（上海）。系统临时目录 `autinberg-qa/<运行ID>/results.json`。
- 证据截图中的号码、App ID、Graph版本、客户均为隔离测试值，**不能复制到生产配置，也不是正式接入截图**。临时目录可能被系统清理，测试脚本可重现。

## 现有数据保护与迁移

升级前 `backups/pre-whatsapp-20260921.json`，升级后 `backups/post-whatsapp-20260921.json`，均在忽略目录，仅本机保留。完整备份含密码哈希等个人信息，请加密复制到独立存储。

实际执行003增量迁移。升级前后业务库账号均1、客户均0、跟进均0，已有管理员保留，没有创建演示员工/客户，也没有重置管理员密码。浏览器旧localStorage没有清除或自动导入。这一计数只说明当前服务端库，不能用来推断其他浏览器是否还有旧数据。

## 文件清单

新增：

- `server/migrations/003_whatsapp.sql`：增量表、字段、索引。
- `server/whatsapp/security.ts`、`graph.ts`、`service.ts`、`routes.ts`：加密/签名、官方传输、事务队列/去重/状态/提醒、鉴权API。
- `shared/whatsapp.ts`：共享协议和校验。
- `src/app/WhatsApp.tsx`、`whatsapp-signup.ts`：集成、员工绑定、收件箱、聊天/媒体/模板、归属处理、统计、官方授权入口。
- `scripts/whatsapp-bind.ts`：服务端已有Cloud API号码绑定。
- `tests/whatsapp.integration.ts`：隔离数据库/HTTP/浏览器自动验收。
- `docs/WHATSAPP.md`、本文件：中文配置、运维、限制与测试。

修改：

- `server/app.ts`、`index.ts`：Webhooks原始请求入口、权限路由、CSP及后台任务。
- `server/repository.ts`、`domain.ts`、`shared/contracts.ts`：负责人范围、待分配池、未读/预览、联系时间及未填公司保护。
- `server/backup.ts`：全量备份恢复包括WhatsApp表。
- `src/app/CRM.tsx`、`pages.tsx`、`ui.tsx`、`forms.tsx`、`api.ts`、`src/App.css`：菜单/标签/提醒、表单、轮询及移动样式。
- `package.json`、`package-lock.json`：绑定/测试命令、号码解析依赖。
- `.env.example`、`.env.production.example`、`compose.yaml`、`README.md`：服务器变量与部署说明。

## 未验收的外部条件与下一步

1. 可部署的VPS/SSH或主机控制台入口、域名DNS及HTTPS、目标服务器网络、备份目标。当前只有本机入口，不是公网地址。
2. Meta Business/App验证及审核、WABA/Phone Number ID、测试外部号码、正式所需权限、受支持Graph版本。
3. 在服务器安全配置App Secret、Verify Token、独立加密密钥及Token；不要在聊天或Git公开。
4. Meta配置公司HTTPS Webhook并订阅messages，先绑定测试号码，实测外部设备收到回复、真实媒体及状态回执。
5. 如用现有Business App号码，完成Coexistence、地区/账号资格和手机App/历史影响核验，再另行确认正式接入。当前未迁移、未注销任何号码。

本次没有购买服务，没有把模拟测试称作真实WhatsApp送达。完整操作步骤见 [WHATSAPP.md](WHATSAPP.md)。
