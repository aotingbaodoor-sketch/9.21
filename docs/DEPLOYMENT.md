# 公司部署步骤

当前代码为完整 Node 服务 + PostgreSQL，不是静态托管项目。下面是待在实际服务器执行的步骤；本机没有 Docker，公共部署尚未验证。

## 需要提供的条件

- Linux 服务器的管理权限，安装 Docker Engine + Compose；建议至少2核、4GB内存、独立持久磁盘。
- 公司域名或子域名，例如 crm.你的域名，将 A/AAAA 记录指向服务器。公网80/443可访问。
- 确定首位管理员邮箱，由管理员设置高强度密码。
- 确定备份存储位置和负责人员。数据库不用开放公网5432。

## 初次部署

1. 把代码传到服务器，复制 `.env.production.example` 为 `.env.production`，权限设为仅部署人员可读。填写 CRM_HOST、HTTPS APP_ORIGIN、随机数据库密码和对应 DATABASE_URL，不提交到 Git。
2. 执行 `docker compose --env-file .env.production up -d --build`。应用在启动前执行增量迁移；不会创建演示账号。数据库存储在具名卷，应用镜像更新不会清空数据。
3. 通过服务器临时环境变量设置 ADMIN_EMAIL、ADMIN_NAME、ADMIN_PASSWORD（至少12位）。执行：

```bash
docker compose --env-file .env.production exec -e ADMIN_EMAIL -e ADMIN_NAME -e ADMIN_PASSWORD app node build/scripts/create-admin.js
```

4. 清除临时密码变量。Caddy 在域名解析和80/443连通后申请 HTTPS 证书。访问所配置域名，用管理员账号创建员工、分配测试客户，分别从销售电脑和手机进行验收。
5. 如使用外部托管 PostgreSQL，使用该服务提供的验证证书连接串配置 DATABASE_URL，并由部署人员按实际网络修改 compose 数据库依赖。不要把连接串放进任何 VITE_ 变量。

默认应用只信任一层 Caddy 反向代理，供登录 IP 限流使用；Node 的3001端口只在容器内部连通，不得直接开放公网。如更换代理拓扑，需同步审查 `server/app.ts` 的 trust proxy 设置，不能无条件信任任意转发头。

## 更新和回滚

先备份，再执行 `docker compose --env-file .env.production up -d --build`。不要执行 `down -v`，不要删除数据库卷。数据库迁移为增量且带校验；回滚需匹配数据库迁移版本，优先在独立恢复库验证后切换，而不是覆盖生产库。

## 生产备份

由具备服务器权限的人员运行（不是员工浏览器导出）：

```bash
docker compose --env-file .env.production exec app node build/scripts/backup.js backup /tmp/autinberg-backup.json
docker compose --env-file .env.production cp app:/tmp/autinberg-backup.json ./autinberg-backup.json
```

每次使用不同文件名，文件已存在时命令会拒绝覆盖。将主机文件加密、复制到独立存储，并限制权限。容器/tmp内文件不是长期备份。也可以从 PostgreSQL 容器调用 pg_dump 获取原生备份，或使用托管数据库自动备份。建议每日备份及更新前备份。

恢复到新建测试数据库：按 README 的 db:setup → RESTORE_DATABASE_URL → db:restore 流程。先验证数据数量、历史、账号和规则，再维护切换。恢复后必须重新登录。

## 上线复核（目标服务器待验证）

- 域名解析正确、HTTPS证书有效、HTTP跳转HTTPS、Cookie带Secure和HttpOnly。
- PostgreSQL端口不暴露公网，服务重启后数据保留，备份已异地保存且已恢复演练。
- 管理员、销售A、销售B各自设备登录，越权API返回404/403，停用会话返回401。
- 手机登录、搜索、新增、跟进通过；应用日志没有敏感密码或连接串。
- 仅初始化授权管理员，无自动演示账号，无公共密码。

源码测试和本地真实数据库测试不能替代此服务器的上线验收。
