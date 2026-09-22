import express from "express";
import type { Request, Response, NextFunction } from "express";
import type pg from "pg";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  customerSchema,
  followSchema,
  passwordSchema,
  settingsSchema,
  userSchema,
} from "../shared/contracts.ts";
import type { CustomerInput, User } from "../shared/contracts.ts";
import { transaction } from "./db.ts";
import {
  addDays,
  businessDay,
  hashPassword,
  hashToken,
  HttpError,
  requireAdmin,
  toCustomer,
  toUser,
  verifyPassword,
} from "./domain.ts";
import * as repo from "./repository.ts";
import { createWhatsAppService, assignment } from "./whatsapp/service.ts";
import { waConfig, type WaConfig } from "./whatsapp/security.ts";
import type { GraphApi } from "./whatsapp/graph.ts";
import {
  registerWhatsAppWebhook,
  registerWhatsAppRoutes,
} from "./whatsapp/routes.ts";
import { registerQuoting } from "./quoting/routes.ts";
import { registerSupplyRoutes } from "./supply/routes.ts";

declare global {
  namespace Express {
    interface Request {
      actor: User;
      sessionHash: string;
      csrf: string;
    }
  }
}
type Options = {
  origin: string;
  production?: boolean;
  sessionHours?: number;
  serveStatic?: boolean;
  whatsapp?: { config: WaConfig; graph?: GraphApi };
};
export function createApp(pool: pg.Pool, options: Options) {
  const app = express(),
    secure = !!options.production,
    cookie = secure ? "__Host-autinberg" : "autinberg_session";
  const whatsapp = createWhatsAppService(
    pool,
    options.whatsapp?.config || waConfig(options.origin),
    options.whatsapp?.graph,
  );
  if (secure && !options.origin.startsWith("https://"))
    throw new Error("生产环境 APP_ORIGIN 必须为 HTTPS");
  app.disable("x-powered-by");
  // 生产 compose 只有 Caddy 一层入口，Node 端口不对外发布。
  // Docker 内 Caddy 不是 loopback，否则会把所有员工误计为同一登录限流 IP。
  app.set("trust proxy", secure ? 1 : "loopback");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            ...(whatsapp.config.appId ? ["https://connect.facebook.net"] : []),
          ],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: [
            "'self'",
            ...(whatsapp.config.appId
              ? ["https://www.facebook.com", "https://graph.facebook.com"]
              : []),
          ],
          frameSrc: [
            "'self'",
            ...(whatsapp.config.appId ? ["https://www.facebook.com"] : []),
          ],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: secure ? [] : null,
        },
      },
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    }),
  );
  registerWhatsAppWebhook(app, whatsapp);
  app.use(express.json({ limit: "3mb" }));
  app.use(cookieParser());
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/api/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  });
  app.use("/api", (req, _res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("origin") !== options.origin
    )
      throw new HttpError(403, "请求来源无效");
    next();
  });
  const loginLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "登录过于频繁，请稍后重试" },
  });
  app.post("/api/auth/login", loginLimit, async (req, res) => {
    const input = z
      .object({
        email: z.email().transform((v) => v.toLowerCase()),
        password: z.string().min(1).max(128),
      })
      .parse(req.body);
    const key = hashToken(input.email),
      result = await pool.query(
        "SELECT count,until_at FROM login_attempts WHERE key=$1",
        [key],
      );
    if (
      result.rowCount &&
      result.rows[0].count >= 10 &&
      new Date(result.rows[0].until_at) > new Date()
    )
      throw new HttpError(429, "账号登录尝试过多，请15分钟后重试");
    const row = (
      await pool.query("SELECT * FROM users WHERE email=$1", [input.email])
    ).rows[0];
    const valid = await verifyPassword(
      input.password,
      row?.password_hash ||
        (await hashPassword("unavailable-account-timing-pad")),
    );
    if (!row?.active || !valid) {
      await pool.query(
        `INSERT INTO login_attempts(key,count,until_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN login_attempts.until_at<now() THEN 1 ELSE login_attempts.count+1 END,until_at=CASE WHEN login_attempts.until_at<now() THEN now()+interval '15 minutes' ELSE login_attempts.until_at END`,
        [key],
      );
      throw new HttpError(401, "邮箱、密码错误或账号已停用");
    }
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex"),
      expires = new Date(Date.now() + (options.sessionHours || 12) * 3600000);
    await transaction(pool, async (db) => {
      const current = (
        await db.query(
          "SELECT active,password_hash FROM users WHERE id=$1 FOR SHARE",
          [row.id],
        )
      ).rows[0];
      if (!current.active || current.password_hash !== row.password_hash)
        throw new HttpError(401, "账号状态已变更");
      await db.query("DELETE FROM login_attempts WHERE key=$1", [key]);
      await db.query(
        "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,$4)",
        [hashToken(token), row.id, csrf, expires],
      );
      await repo.audit(db, toUser(row), "登录", row.id);
    });
    res.cookie(cookie, token, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/",
      expires,
    });
    res.json({ user: toUser(row), csrf });
  });
  app.use("/api", async (req, _res, next) => {
    const token = req.cookies[cookie];
    if (typeof token !== "string") throw new HttpError(401, "请先登录");
    req.sessionHash = hashToken(token);
    const result = await pool.query(
      "SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true",
      [req.sessionHash],
    );
    if (!result.rowCount)
      throw new HttpError(401, "会话已过期或账号已停用，请重新登录");
    req.actor = toUser(result.rows[0]);
    req.csrf = result.rows[0].csrf;
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.get("x-csrf-token") !== req.csrf
    )
      throw new HttpError(403, "安全校验失败，请刷新页面重试");
    next();
  });
  app.get("/api/auth/me", async (req, res) =>
    res.json({
      user: req.actor,
      csrf: req.csrf,
      settings: await repo.settings(pool),
    }),
  );
  app.get("/api/auth/owners", async (req, res) => res.json([req.actor]));
  app.post("/api/auth/logout", async (req, res) => {
    await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
      req.sessionHash,
    ]);
    res.clearCookie(cookie, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/",
    });
    res.json({ ok: true });
  });
  // 同一写请求携带相同幂等键时返回已保存结果；事务包含业务更新、历史和审计。
  const mutate = async (
    req: Request,
    res: Response,
    run: (db: pg.PoolClient) => Promise<unknown>,
  ) => {
    const key = z.uuid().parse(req.get("idempotency-key")),
      hash = hashToken(req.method + req.path + JSON.stringify(req.body));
    const value = await transaction(pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        req.actor.id + key,
      ]);
      const prior = await db.query(
        "SELECT request_hash,response FROM idempotency_keys WHERE user_id=$1 AND key=$2",
        [req.actor.id, key],
      );
      if (prior.rowCount) {
        if (prior.rows[0].request_hash !== hash)
          throw new HttpError(409, "重复请求内容已变化");
        return prior.rows[0].response;
      }
      const session = await db.query(
        "SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND u.active AND s.expires_at>now()",
        [req.sessionHash],
      );
      if (!session.rowCount) throw new HttpError(401, "会话已失效");
      const response = await run(db);
      await db.query(
        "INSERT INTO idempotency_keys(user_id,key,request_hash,response) VALUES($1,$2,$3,$4)",
        [req.actor.id, key, hash, JSON.stringify(response)],
      );
      return response;
    });
    res.json(value);
  };
  app.use("/api", (req, _res, next) => {
    if (["logistics", "technical"].includes(req.actor.role) && !req.path.startsWith("/quoting/") && req.path !== "/profile")
      throw new HttpError(403, "该岗位仅可访问已授权的报价任务");
    if (req.actor.role === "factory" && !req.path.startsWith("/supply/") && req.path !== "/profile")
      throw new HttpError(403, "工厂账号仅可访问本工厂产品、订单和生产反馈");
    next();
  });
  registerWhatsAppRoutes(app, whatsapp, mutate);
  registerQuoting(app, pool, mutate);
  registerSupplyRoutes(app, pool, mutate);
  app.get("/api/customers", async (req, res) =>
    res.json(await repo.listCustomers(pool, req.actor, req.query)),
  );
  app.get("/api/customers/:id", async (req, res) => {
    const c = await repo.customer(pool, req.actor, String(req.params.id));
    res.json({
      customer: toCustomer(c, await repo.settings(pool)),
      records: await repo.records(pool, req.actor, {
        customerId: c.id,
        ...req.query,
      }),
    });
  });
  app.post("/api/customers", async (req, res) =>
    mutate(req, res, (db) =>
      repo.createCustomer(db, req.actor, customerSchema.parse(req.body)),
    ),
  );
  app.put("/api/customers/:id", async (req, res) =>
    mutate(req, res, async (db) => {
      const input = customerSchema.parse(req.body),
        row = await repo.customer(db, req.actor, String(req.params.id), true);
      repo.checkVersion(row, input.version);
      if (!input.company.trim() && !row.wa_id)
        throw new HttpError(400, "公司名称必填");
      if (
        req.actor.role !== "admin" &&
        input.ownerId !== undefined &&
        input.ownerId !== row.owner_id
      )
        throw new HttpError(403, "销售不能修改负责人");
      const owner = input.ownerId || row.owner_id;
      await repo.activeOwner(db, owner);
      const dup = await repo.duplicates(db, req.actor, input, row.id);
      if (dup.length && !input.allowDuplicate)
        throw new HttpError(409, "发现疑似重复客户，请核对", {
          duplicates: dup,
        });
      const {
        version: _v,
        allowDuplicate: _d,
        ownerId: _o,
        next: _n,
        ...data
      } = input;
      await db.query(
        `UPDATE customers SET company=$2,grade=$3,stage=$4,data=$5,owner_id=$6,next_follow_up=$7,updated_at=now(),version=version+1,won_at=CASE WHEN $4='已成交' AND stage<>'已成交' THEN now() WHEN $4<>'已成交' THEN NULL ELSE won_at END WHERE id=$1`,
        [
          row.id,
          input.company,
          input.grade,
          input.stage,
          JSON.stringify(data),
          owner,
          input.next || row.next_follow_up,
        ],
      );
      if (owner !== row.owner_id) {
        await repo.notifyAssignment(db, row.id, owner);
        if (row.wa_id)
          await assignment(
            db,
            row.id,
            row.owner_id,
            owner,
            req.actor.id,
            "管理员编辑客户负责人",
          );
      }
      await repo.audit(db, req.actor, "编辑客户", row.id, {
        company: input.company,
        grade: [row.grade, input.grade],
        owner: [row.owner_id, owner],
      });
      return toCustomer(
        await repo.customer(db, req.actor, row.id),
        await repo.settings(db),
      );
    }),
  );
  for (const action of ["delete", "restore"])
    app.post(`/api/customers/:id/${action}`, async (req, res) =>
      mutate(req, res, async (db) => {
        requireAdmin(req.actor);
        const input = z
            .object({ version: z.number().int().positive() })
            .strict()
            .parse(req.body),
          row = await repo.customer(
            db,
            req.actor,
            String(req.params.id),
            true,
            true,
          );
        repo.checkVersion(row, input.version);
        await db.query(
          `UPDATE customers SET deleted_at=${action === "delete" ? "now()" : "NULL"},updated_at=now(),version=version+1 WHERE id=$1`,
          [row.id],
        );
        await repo.audit(
          db,
          req.actor,
          action === "delete" ? "删除客户" : "恢复客户",
          row.id,
        );
        return { ok: true };
      }),
    );
  app.post("/api/customers/:id/follow-ups", async (req, res) =>
    mutate(req, res, async (db) => {
      const input = followSchema.parse(req.body),
        row = await repo.customer(db, req.actor, String(req.params.id), true);
      repo.checkVersion(row, input.version);
      const config = await repo.settings(db),
        next =
          input.next ||
          addDays(
            businessDay(config.timezone),
            config.cycles[row.grade as keyof typeof config.cycles],
          ),
        id = randomUUID();
      await db.query(
        "INSERT INTO follow_up_records(id,customer_id,user_id,method,content,response,plan,next_follow_up) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          row.id,
          req.actor.id,
          input.method,
          input.content,
          input.response,
          input.plan,
          next,
        ],
      );
      await db.query(
        "UPDATE customers SET last_follow_up=now(),next_follow_up=$2,updated_at=now(),version=version+1 WHERE id=$1",
        [row.id, next],
      );
      await repo.audit(db, req.actor, "保存跟进", row.id);
      return { id, next };
    }),
  );
  app.get("/api/records", async (req, res) =>
    res.json(await repo.records(pool, req.actor, req.query)),
  );
  app.get("/api/summary", async (req, res) => {
    const config = await repo.settings(pool),
      today = businessDay(config.timezone),
      s = repo.scope(req.actor, "c", 3),
      p = [today, config.timezone, ...s.params],
      where = `${s.sql} AND c.deleted_at IS NULL`;
    const metric = (
      await pool.query(
        `SELECT count(*)::int AS total,count(*) FILTER(WHERE next_follow_up=$1::date)::int AS today,count(*) FILTER(WHERE next_follow_up<$1::date)::int AS overdue,count(*) FILTER(WHERE grade='A')::int AS a,count(*) FILTER(WHERE (created_at AT TIME ZONE $2)::date>=date_trunc('month',$1::date)::date)::int AS month,count(*) FILTER(WHERE (won_at AT TIME ZONE $2)::date>=date_trunc('month',$1::date)::date)::int AS won FROM customers c WHERE ${where}`,
        p,
      )
    ).rows[0];
    const group = async (expression: string) => {
      const range = repo.scope(req.actor);
      return (
        await pool.query(
          `SELECT ${expression} AS label,count(*)::int AS count FROM customers c JOIN users u ON u.id=c.owner_id WHERE ${range.sql} AND c.deleted_at IS NULL GROUP BY 1 ORDER BY count DESC`,
          range.params,
        )
      ).rows;
    };
    const [grades, countries, sources, stages, owners, priority] =
      await Promise.all([
        group("c.grade"),
        group("coalesce(nullif(c.data->>'country',''),'未填写')"),
        group("coalesce(nullif(c.data->>'source',''),'未填写')"),
        group("c.stage"),
        group("u.name"),
        repo.listCustomers(pool, req.actor, { limit: 8 }),
      ]);
    res.json({
      today,
      metrics: metric,
      grades,
      countries,
      sources,
      stages,
      owners,
      priority: priority.items,
    });
  });
  app.get("/api/notifications", async (req, res) => {
    await repo.refreshNotifications(pool);
    const s = repo.scope(req.actor, "c", 1);
    const config = await repo.settings(pool);
    const result = await pool.query(
      `SELECT n.id,n.title,n.kind,r.read_at AS "readAt",n.created_at AS "createdAt",c.id AS "customerId",coalesce(nullif(c.company,''),c.data->>'contact','WhatsApp新客户') AS company,u.name AS owner FROM notifications n JOIN customers c ON c.id=n.customer_id JOIN users u ON u.id=c.owner_id LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=$${s.params.length + 1} WHERE ${s.sql} AND c.deleted_at IS NULL AND n.user_id=c.owner_id AND (n.kind IN ('assignment','whatsapp','whatsapp_timeout') OR (n.due_date=c.next_follow_up AND (n.created_at AT TIME ZONE $${s.params.length + 2})::date=$${s.params.length + 3}::date)) ORDER BY n.created_at DESC LIMIT 200`,
      [
        ...s.params,
        req.actor.id,
        config.timezone,
        businessDay(config.timezone),
      ],
    );
    res.json(result.rows);
  });
  app.post("/api/notifications/:id/read", async (req, res) =>
    mutate(req, res, async (db) => {
      const s = repo.scope(req.actor, "c", 2),
        result = await db.query(
          `SELECT n.id FROM notifications n JOIN customers c ON c.id=n.customer_id WHERE n.id::text=$1 AND ${s.sql} AND c.deleted_at IS NULL AND n.user_id=c.owner_id`,
          [String(req.params.id), ...s.params],
        );
      if (!result.rowCount) throw new HttpError(404, "提醒不存在或无权访问");
      if (z.object({ read: z.boolean() }).parse(req.body).read)
        await db.query(
          "INSERT INTO notification_reads(notification_id,user_id) VALUES($1,$2) ON CONFLICT(notification_id,user_id) DO UPDATE SET read_at=now()",
          [result.rows[0].id, req.actor.id],
        );
      else
        await db.query(
          "DELETE FROM notification_reads WHERE notification_id=$1 AND user_id=$2",
          [result.rows[0].id, req.actor.id],
        );
      return { ok: true };
    }),
  );
  app.get("/api/team", async (req, res) => {
    requireAdmin(req.actor);
    const config = await repo.settings(pool);
    const result = await pool.query(
      `SELECT u.id,u.name,u.email,u.role,u.active,u.version,u.avatar,count(c.id)::int AS customers,count(c.id) FILTER(WHERE c.grade='A')::int AS a,count(c.id) FILTER(WHERE c.next_follow_up=$1)::int AS today,count(c.id) FILTER(WHERE c.next_follow_up<$1)::int AS overdue FROM users u LEFT JOIN customers c ON c.owner_id=u.id AND c.deleted_at IS NULL GROUP BY u.id ORDER BY u.created_at`,
      [businessDay(config.timezone)],
    );
    res.json(result.rows);
  });
  app.post("/api/team", async (req, res) => {
    requireAdmin(req.actor);
    const input = userSchema.parse(req.body);
    if (input.role === "factory") throw new HttpError(400, "请在合作工厂管理中邀请工厂账号");
    if (!input.password) throw new HttpError(400, "必须设置员工初始密码");
    const hash = await hashPassword(input.password);
    return mutate(req, res, async (db) => {
      const id = randomUUID();
      await db.query(
        "INSERT INTO users(id,name,email,password_hash,role,active) VALUES($1,$2,$3,$4,$5,$6)",
        [id, input.name, input.email, hash, input.role, input.active],
      );
      await repo.audit(db, req.actor, "新增员工", id, { name: input.name });
      return { id };
    });
  });
  app.put("/api/team/:id", async (req, res) => {
    requireAdmin(req.actor);
    const input = userSchema.parse(req.body),
      password = input.password ? await hashPassword(input.password) : null;
    if (input.role === "factory") throw new HttpError(400, "请在合作工厂管理中维护工厂账号");
    return mutate(req, res, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(825116)");
      const row = (
        await db.query("SELECT * FROM users WHERE id::text=$1 FOR UPDATE", [
          String(req.params.id),
        ])
      ).rows[0];
      if (!row) throw new HttpError(404, "员工不存在");
      repo.checkVersion(row, input.version);
      if (
        row.role === "admin" &&
        row.active &&
        (!input.active || input.role !== "admin")
      ) {
        const n = (
          await db.query(
            "SELECT count(*)::int AS n FROM users WHERE active AND role='admin'",
          )
        ).rows[0].n;
        if (n <= 1) throw new HttpError(400, "必须保留至少一名启用的管理员");
      }
      await db.query(
        "UPDATE users SET name=$2,email=$3,role=$4,active=$5,password_hash=coalesce($6,password_hash),version=version+1 WHERE id=$1",
        [row.id, input.name, input.email, input.role, input.active, password],
      );
      await db.query("DELETE FROM sessions WHERE user_id=$1", [row.id]);
      await repo.audit(db, req.actor, "编辑员工/撤销会话", row.id, {
        active: input.active,
        role: input.role,
        passwordReset: !!password,
      });
      return { ok: true };
    });
  });
  app.put("/api/profile", async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(80),
        avatar: z
          .string()
          .max(500000)
          .refine(
            (v) =>
              !v ||
              /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v),
            "请选择 PNG/JPEG/WebP 头像",
          ),
        version: z.number().int().positive(),
        currentPassword: z.string().max(128).optional(),
        password: passwordSchema.optional(),
      })
      .strict()
      .parse(req.body);
    const hash = input.password ? await hashPassword(input.password) : null;
    return mutate(req, res, async (db) => {
      const row = (
        await db.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
          req.actor.id,
        ])
      ).rows[0];
      repo.checkVersion(row, input.version);
      if (
        hash &&
        (!input.currentPassword ||
          !(await verifyPassword(input.currentPassword, row.password_hash)))
      )
        throw new HttpError(400, "当前密码错误");
      await db.query(
        "UPDATE users SET name=$2,avatar=$3,password_hash=coalesce($4,password_hash),version=version+1 WHERE id=$1",
        [row.id, input.name, input.avatar, hash],
      );
      if (hash)
        await db.query("DELETE FROM sessions WHERE user_id=$1", [row.id]);
      await repo.audit(db, req.actor, "修改个人资料", row.id, {
        passwordChanged: !!hash,
      });
      return { ok: true, relogin: !!hash };
    });
  });
  app.get("/api/settings", async (_req, res) =>
    res.json(await repo.settings(pool)),
  );
  app.put("/api/settings", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const input = settingsSchema.parse(req.body),
        row = (
          await db.query("SELECT version FROM settings WHERE id=1 FOR UPDATE")
        ).rows[0];
      repo.checkVersion(row, input.version);
      const { version: _v, ...data } = input;
      await db.query(
        "UPDATE settings SET data=$1,version=version+1 WHERE id=1",
        [JSON.stringify(data)],
      );
      await repo.audit(db, req.actor, "修改系统规则", "1", data);
      return repo.settings(db);
    }),
  );
  app.get("/api/audit", async (req, res) => {
    requireAdmin(req.actor);
    res.json(
      (
        await pool.query(
          'SELECT a.id,a.action,a.entity_id AS "entityId",a.details,a.created_at AS date,u.name AS "user" FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 200',
        )
      ).rows,
    );
  });
  app.get("/api/export", async (req, res) => {
    const data = await transaction(pool, async (db) => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const config = await repo.settings(db),
        s = repo.scope(req.actor);
      const rows = (
        await db.query(
          `SELECT c.*,u.name AS owner FROM customers c JOIN users u ON u.id=c.owner_id WHERE ${s.sql} AND c.deleted_at IS NULL ORDER BY c.created_at`,
          s.params,
        )
      ).rows;
      const recordScope =
        req.actor.role === "admin" ? "TRUE" : "c.owner_id=$1 AND f.user_id=$1";
      const history = (
        await db.query(
          `SELECT f.*,c.company FROM follow_up_records f JOIN customers c ON c.id=f.customer_id WHERE ${recordScope} AND c.deleted_at IS NULL`,
          req.actor.role === "admin" ? [] : [req.actor.id],
        )
      ).rows;
      await repo.audit(db, req.actor, "导出数据", "export", {
        count: rows.length,
      });
      return {
        format: "autinberg-export-v1",
        exportedAt: new Date().toISOString(),
        customers: rows.map((r) => toCustomer(r, config)),
        records: history,
      };
    });
    res.set(
      "Content-Disposition",
      'attachment; filename="autinberg-customers.json"',
    );
    res.json(data);
  });
  app.post("/api/import/preview", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const input = z
        .object({
          customers: z
            .array(z.record(z.string(), z.unknown()))
            .min(1)
            .max(1000),
          ownerMap: z.record(z.string(), z.uuid()),
          backedUp: z.literal(true),
        })
        .parse(req.body);
      const rows: {
        index: number;
        data: CustomerInput;
        fingerprint: string;
        alreadyImported: boolean;
        duplicates: { id: string; company: string }[];
      }[] = [];
      for (let i = 0; i < input.customers.length; i++) {
        const legacy = input.customers[i],
          ownerId =
            input.ownerMap[String(legacy.ownerId || legacy.owner || "未分配")];
        if (!ownerId) throw new HttpError(400, `第${i + 1}行负责人尚未映射`);
        await repo.activeOwner(db, ownerId);
        const mapped = {
          ...legacy,
          company: legacy.company || legacy.companyName,
          contact: legacy.contact || legacy.contactName || "",
          product: legacy.product || legacy.interestedProduct || "",
          grade: legacy.grade || legacy.level || "C",
          stage:
            legacy.stage === "谈判"
              ? "谈判中"
              : legacy.stage || legacy.salesStage || "新询盘",
          next: legacy.next || legacy.nextFollowUpAt,
          ownerId,
        };
        const allowed = Object.fromEntries(
          Object.entries(mapped).filter(
            ([key]) =>
              key in customerSchema.shape &&
              !["version", "allowDuplicate"].includes(key),
          ),
        );
        const parsed = customerSchema.safeParse(allowed);
        if (!parsed.success)
          throw new HttpError(
            400,
            `第${i + 1}行校验失败：${parsed.error.issues.map((x) => x.path.join(".") + ":" + x.message).join("；")}`,
          );
        const data = parsed.data,
          fingerprint = hashToken(
            JSON.stringify([
              legacy.id || "",
              data.company.toLowerCase(),
              data.email.toLowerCase(),
              data.phone,
              data.ownerId,
            ]),
          );
        const exists = (
          await db.query(
            "SELECT customer_id FROM imported_rows WHERE fingerprint=$1",
            [fingerprint],
          )
        ).rowCount;
        const fileDuplicates = rows
          .filter((previous) =>
            ["company", "email", "phone", "whatsapp", "website"].some((key) => {
              const a = String(previous.data[key as keyof CustomerInput] || "")
                .trim()
                .toLowerCase();
              const b = String(data[key as keyof CustomerInput] || "")
                .trim()
                .toLowerCase();
              return a !== "" && a === b;
            }),
          )
          .map((previous) => ({
            id: "",
            company: `文件第${previous.index + 1}行：${previous.data.company}`,
          }));
        rows.push({
          index: i,
          data,
          fingerprint,
          alreadyImported: !!exists,
          duplicates: [
            ...(await repo.duplicates(db, req.actor, data)),
            ...fileDuplicates,
          ],
        });
      }
      const id = randomUUID();
      await db.query(
        "INSERT INTO import_batches(id,user_id,rows) VALUES($1,$2,$3)",
        [id, req.actor.id, JSON.stringify(rows)],
      );
      return { id, rows };
    }),
  );
  app.post("/api/import/:id/commit", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const input = z
        .object({
          include: z.array(z.number().int().nonnegative()).max(1000),
          confirmed: z.literal(true),
        })
        .parse(req.body);
      const batch = (
        await db.query(
          "SELECT * FROM import_batches WHERE id::text=$1 AND user_id=$2 FOR UPDATE",
          [String(req.params.id), req.actor.id],
        )
      ).rows[0];
      if (!batch) throw new HttpError(404, "预检批次不存在");
      if (batch.committed_at) throw new HttpError(409, "该批次已经导入");
      const imported = [];
      for (const row of batch.rows as {
        index: number;
        data: CustomerInput;
        fingerprint: string;
      }[]) {
        if (!input.include.includes(row.index)) continue;
        await db.query("SELECT pg_advisory_xact_lock(825115)");
        if (
          (
            await db.query("SELECT 1 FROM imported_rows WHERE fingerprint=$1", [
              row.fingerprint,
            ])
          ).rowCount
        )
          continue;
        const c = await repo.createCustomer(db, req.actor, {
          ...row.data,
          allowDuplicate: true,
        });
        await db.query(
          "INSERT INTO imported_rows(fingerprint,customer_id,batch_id) VALUES($1,$2,$3)",
          [row.fingerprint, c.id, batch.id],
        );
        imported.push({ id: c.id, company: c.company, ownerId: c.ownerId });
      }
      await db.query(
        "UPDATE import_batches SET committed_at=now() WHERE id=$1",
        [batch.id],
      );
      await repo.audit(db, req.actor, "导入旧客户", batch.id, {
        count: imported.length,
      });
      return { count: imported.length, customers: imported };
    }),
  );
  app.use("/api", (_req, _res) => {
    throw new HttpError(404, "接口不存在");
  });
  if (options.serveStatic) {
    app.use(express.static(path.resolve("dist")));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(path.resolve("dist/index.html")),
    );
  }
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof HttpError) {
        res
          .status(error.status)
          .json({ error: error.message, details: error.details });
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: error.issues
            .map((x) => x.path.join(".") + ": " + x.message)
            .join("；"),
        });
        return;
      }
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "该邮箱或记录已存在，请检查后重试" });
        return;
      }
      if ((error as { type?: string }).type === "entity.parse.failed") {
        res.status(400).json({ error: "请求内容格式错误" });
        return;
      }
      console.error(
        "Request failed:",
        _req.path.includes("whatsapp")
          ? "WhatsApp request error (details redacted)"
          : error instanceof Error
            ? error.message
            : "unknown",
      );
      res
        .status(500)
        .json({ error: "服务器暂时无法保存或读取数据，请稍后重试" });
    },
  );
  return app;
}
