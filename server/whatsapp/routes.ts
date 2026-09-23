import express from "express";
import type { Express, Request, Response } from "express";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "../db.ts";
import { hashToken, HttpError, requireAdmin, businessDay } from "../domain.ts";
import * as repo from "../repository.ts";
import { waRulesSchema, waSendSchema } from "../../shared/whatsapp.ts";
import { setupChecks } from "./readiness.ts";
import { verifyAppToken } from "./graph.ts";
import {
  accounts,
  account,
  accountToken,
  assignment,
  bindAccount,
  connectionError,
  conversation,
  rules,
  templateView,
  verifyPhone,
  type WhatsAppService,
} from "./service.ts";
import {
  encrypt,
  equalSecret,
  hasKey,
  redact,
  verifySignature,
  windowOpen,
} from "./security.ts";
type Mutate = (
  req: Request,
  res: Response,
  run: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
const metaId = z.string().regex(/^\d{5,30}$/);

export function registerWhatsAppWebhook(
  app: Express,
  service: WhatsAppService,
) {
  const { pool, config } = service;
  app.get("/api/whatsapp/webhook", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!config.verifyToken) throw new HttpError(503, "Webhook验证未配置");
    if (
      req.query["hub.mode"] !== "subscribe" ||
      typeof req.query["hub.verify_token"] !== "string" ||
      !equalSecret(req.query["hub.verify_token"], config.verifyToken)
    )
      throw new HttpError(403, "Webhook验证失败");
    const challenge = z.string().max(500).parse(req.query["hub.challenge"]);
    await pool.query(
      "UPDATE whatsapp_settings SET last_verified_at=now() WHERE id=1",
    );
    res.type("text/plain").send(challenge);
  });
  // 必须在express.json之前获取原始字节；不依赖浏览器会话、Origin或伪造的JSON字段。
  app.post(
    "/api/whatsapp/webhook",
    express.raw({ type: "application/json", limit: "1mb", inflate: false }),
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (!config.appSecret || !hasKey(config))
        throw new HttpError(503, "Webhook服务端机密配置不完整");
      if (
        !Buffer.isBuffer(req.body) ||
        !verifySignature(
          req.body,
          req.get("x-hub-signature-256"),
          config.appSecret,
        )
      ) {
        await pool.query(
          "UPDATE whatsapp_settings SET signature_failures=signature_failures+1 WHERE id=1",
        );
        throw new HttpError(401, "Webhook签名无效");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(req.body.toString("utf8"));
      } catch {
        throw new HttpError(400, "Webhook JSON无效");
      }
      if (!payload || typeof payload !== "object")
        throw new HttpError(400, "Webhook内容无效");
      const key = hashToken(req.body.toString("utf8")),
        id = randomUUID();
      // 先持久化队列再确认接收，外部Meta调用、媒体下载均不阻塞HTTP确认。
      await transaction(pool, async (db) => {
        await db.query(
          "INSERT INTO whatsapp_webhook_events(id,event_key,payload_encrypted) VALUES($1,$2,$3) ON CONFLICT(event_key) DO NOTHING",
          [id, key, encrypt(JSON.stringify(redact(payload)), config)],
        );
        await db.query(
          "UPDATE whatsapp_settings SET last_received_at=now() WHERE id=1",
        );
      });
      res.status(200).json({ received: true });
    },
  );
}

export function registerWhatsAppRoutes(
  app: Express,
  service: WhatsAppService,
  mutate: Mutate,
) {
  const { pool, config, graph } = service;
  app.get("/api/whatsapp/config", async (req, res) => {
    const state = (
      await pool.query("SELECT * FROM whatsapp_settings WHERE id=1")
    ).rows[0];
    const admin = req.actor.role === "admin";
    res.json({
      ...(admin ? {
        setupChecks: setupChecks(config),
        messageEvidence: (await pool.query(`SELECT a.id AS "accountId",
          count(m.id) FILTER (WHERE m.direction='inbound')::int AS "inboundCount",
          count(m.id) FILTER (WHERE m.direction='outbound' AND m.whatsapp_message_id IS NOT NULL)::int AS "acceptedCount",
          count(m.id) FILTER (WHERE m.direction='outbound' AND m.delivered_at IS NOT NULL)::int AS "deliveredCount",
          max(m.message_timestamp) FILTER (WHERE m.direction='inbound') AS "lastInboundAt",
          max(m.delivered_at) AS "lastDeliveredAt"
          FROM whatsapp_accounts a LEFT JOIN whatsapp_messages m ON m.account_id=a.id
          GROUP BY a.id ORDER BY a.created_at`)).rows,
      } : {}),
      appId: config.appId,
      graphVersion: config.graphVersion,
      signupConfigId: config.signupConfigId,
      signupAvailable: !!(
        config.appId &&
        config.appSecret &&
        config.verifyToken &&
        config.signupConfigId &&
        config.graphVersion &&
        hasKey(config) &&
        config.origin.startsWith("https://")
      ),
      appSecretConfigured: !!config.appSecret,
      verifyTokenConfigured: !!config.verifyToken,
      encryptionKeyConfigured: hasKey(config),
      callbackUrl: config.origin + "/api/whatsapp/webhook",
      publicHttps: config.origin.startsWith("https://"),
      lastVerifiedAt: state.last_verified_at,
      lastReceivedAt: state.last_received_at,
      signatureFailures: admin ? state.signature_failures : 0,
      rules: await rules(pool),
      accounts: await accounts(pool, req.actor),
      alerts: admin
        ? (
            await pool.query(
              'SELECT id,title,code,created_at AS "createdAt" FROM whatsapp_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100',
            )
          ).rows
        : [],
      events: admin
        ? (
            await pool.query(
              'SELECT id,status,attempts,error_message AS "errorMessage",received_at AS "receivedAt",processed_at AS "processedAt" FROM whatsapp_webhook_events ORDER BY received_at DESC LIMIT 50',
            )
          ).rows
        : [],
    });
  });
  app.put("/api/whatsapp/settings", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const input = waRulesSchema.parse(req.body),
        row = (
          await db.query(
            "SELECT version FROM whatsapp_settings WHERE id=1 FOR UPDATE",
          )
        ).rows[0];
      repo.checkVersion(row, input.version);
      const { version: _v, ...data } = input;
      await db.query(
        "UPDATE whatsapp_settings SET data=$1,version=version+1 WHERE id=1",
        [JSON.stringify(data)],
      );
      await repo.audit(db, req.actor, "修改WhatsApp归属及提醒规则", "1", data);
      return rules(db);
    }),
  );
  app.post("/api/whatsapp/signup/start", async (req, res) =>
    mutate(req, res, async (db) => {
      if (!(
        config.appId &&
        config.appSecret &&
        config.verifyToken &&
        config.graphVersion &&
        config.signupConfigId &&
        hasKey(config) &&
        config.origin.startsWith("https://")
      ))
        throw new HttpError(
          503,
          "正式授权尚未配置，请管理员先完成Meta及HTTPS设置",
        );
      z.object({ existingCloudApiConfirmed: z.literal(true) })
        .strict()
        .parse(req.body);
      const id = randomUUID();
      await db.query(
        "INSERT INTO whatsapp_signup_sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
        [id, req.actor.id],
      );
      return { id };
    }),
  );
  app.post("/api/whatsapp/signup/complete", async (req, res) => {
    const input = z
      .object({
        sessionId: z.uuid(),
        code: z.string().min(10).max(4096),
        wabaId: metaId,
        phoneNumberId: metaId,
      })
      .strict()
      .parse(req.body);
    // 授权会话绑定CRM用户且一次性消费；不能把别人的授权结果绑定到自己。
    const session = await pool.query(
      "UPDATE whatsapp_signup_sessions SET consumed_at=now() WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING id",
      [input.sessionId, req.actor.id],
    );
    if (!session.rowCount)
      throw new HttpError(409, "授权会话已过期或已使用，请重新连接");
    const token = await graph.exchangeCode(input.code);
    await verifyAppToken(graph, config, token);
    const phone = await verifyPhone(
      graph,
      input.wabaId,
      input.phoneNumberId,
      token,
    );
    // 不调用register/deregister，不自动迁移Business App号码；注册前置步骤由号码持有人在Meta确认。
    await graph.request(`${input.wabaId}/subscribed_apps`, token, "POST", {});
    res.json(
      await bindAccount(
        pool,
        config,
        {
          userId: req.actor.id,
          wabaId: input.wabaId,
          phone,
          token,
          subscriptionStatus: "subscribed",
        },
        req.actor,
      ),
    );
  });
  app.post("/api/whatsapp/accounts/:id/test", async (req, res) => {
    const a = await account(pool, String(req.params.id), req.actor);
    try {
      const token = accountToken(a, config),
        phone = await verifyPhone(graph, a.waba_id, a.phone_number_id, token);
      const apps = await graph.request<{
        data: { whatsapp_business_api_data?: { id?: string }; id?: string }[];
      }>(`${a.waba_id}/subscribed_apps`, token);
      const subscribed = apps.data?.some(
        (x) => (x.whatsapp_business_api_data?.id || x.id) === config.appId,
      );
      await pool.query(
        "UPDATE whatsapp_accounts SET connection_status='connected',last_checked_at=now(),last_error=NULL,last_error_code=NULL,subscription_status=$2,display_phone_number=$3,verified_name=$4,updated_at=now() WHERE id=$1 AND connection_status<>'disconnected'",
        [
          a.id,
          subscribed ? "subscribed" : "not_subscribed",
          phone.display_phone_number,
          phone.verified_name || "",
        ],
      );
      await pool.query(
        "UPDATE whatsapp_alerts SET resolved_at=now() WHERE event_key=$1",
        [`connection:${a.id}`],
      );
      res.json({
        ok: true,
        subscriptionStatus: subscribed ? "subscribed" : "not_subscribed",
      });
    } catch (error) {
      await connectionError(pool, a, error);
      throw error;
    }
  });
  app.post("/api/whatsapp/accounts/:id/disconnect", async (req, res) =>
    mutate(req, res, async (db) => {
      const a = await account(db, String(req.params.id), req.actor, true),
        input = z
          .object({ version: z.number().int(), confirm: z.literal(true) })
          .strict()
          .parse(req.body);
      repo.checkVersion(a, input.version);
      await db.query(
        "UPDATE whatsapp_accounts SET connection_status='disconnected',token_encrypted=NULL,token_reference=NULL,version=version+1,updated_at=now() WHERE id=$1",
        [a.id],
      );
      await repo.audit(
        db,
        req.actor,
        "断开CRM WhatsApp绑定（保留号码及历史）",
        a.id,
      );
      return { ok: true };
    }),
  );
  app.post("/api/whatsapp/accounts/:id/assign", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const a = await account(db, String(req.params.id), undefined, true),
        input = z
          .object({ userId: z.uuid(), version: z.number().int() })
          .strict()
          .parse(req.body);
      repo.checkVersion(a, input.version);
      await repo.activeOwner(db, input.userId);
      await db.query(
        "UPDATE whatsapp_accounts SET user_id=$2,version=version+1,updated_at=now() WHERE id=$1",
        [a.id, input.userId],
      );
      await repo.audit(db, req.actor, "变更WhatsApp号码员工", a.id, {
        from: a.user_id,
        to: input.userId,
      });
      return { ok: true };
    }),
  );
  app.post("/api/whatsapp/accounts/:id/templates/sync", async (req, res) => {
    const a = await account(pool, String(req.params.id), req.actor);
    try {
      const token = accountToken(a, config);
      const items: Record<string, unknown>[] = [];
      let after = "";
      for (let page = 0; page < 20; page++) {
        const result = await graph.request<{
          data: Record<string, unknown>[];
          paging?: { next?: string; cursors?: { after?: string } };
        }>(
          `${a.waba_id}/message_templates?fields=id,name,status,language,category,components&limit=100${after ? "&after=" + encodeURIComponent(after) : ""}`,
          token,
        );
        items.push(...result.data);
        if (!result.paging?.next || !result.paging.cursors?.after) break;
        after = result.paging.cursors.after;
      }
      await transaction(pool, async (db) => {
        await db.query(
          "UPDATE whatsapp_templates SET status='UNKNOWN' WHERE account_id=$1",
          [a.id],
        );
        for (const t of items)
          await db.query(
            "INSERT INTO whatsapp_templates(account_id,template_id,name,language,status,category,components) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,template_id) DO UPDATE SET name=EXCLUDED.name,language=EXCLUDED.language,status=EXCLUDED.status,category=EXCLUDED.category,components=EXCLUDED.components,synced_at=now()",
            [
              a.id,
              t.id,
              t.name,
              t.language,
              t.status,
              t.category,
              JSON.stringify(t.components || []),
            ],
          );
      });
      res.json({ count: items.length });
    } catch (error) {
      await connectionError(pool, a, error);
      throw error;
    }
  });
  app.get("/api/whatsapp/accounts/:id/templates", async (req, res) => {
    const a = await account(pool, String(req.params.id), req.actor);
    res.json(
      (
        await pool.query(
          "SELECT * FROM whatsapp_templates WHERE account_id=$1 ORDER BY name,language",
          [a.id],
        )
      ).rows.map(templateView),
    );
  });
  app.get("/api/whatsapp/conflicts", async (req, res) => {
    if (req.actor.role !== "admin") {
      const count = (
        await pool.query(
          "SELECT count(*)::int AS n FROM whatsapp_conversations v JOIN whatsapp_accounts a ON a.id=v.account_id WHERE v.conflict AND a.user_id=$1",
          [req.actor.id],
        )
      ).rows[0].n;
      res.json({
        count,
        message: count ? "该号码可能已经存在，请联系管理员处理" : "",
        items: [],
      });
      return;
    }
    const items = (
      await pool.query(
        `SELECT v.id,v.customer_id AS "customerId",coalesce(nullif(c.company,''),c.data->>'contact','WhatsApp新客户') AS company,c.owner_id AS "ownerId",u.name AS owner,c.version,c.wa_needs_assignment AS "needsAssignment",c.deleted_at AS "deletedAt",a.display_phone_number AS "displayPhoneNumber",receiver.name AS receiver,v.wa_id AS "waId",v.conflict_reason AS reason FROM whatsapp_conversations v JOIN customers c ON c.id=v.customer_id JOIN users u ON u.id=c.owner_id JOIN whatsapp_accounts a ON a.id=v.account_id JOIN users receiver ON receiver.id=a.user_id WHERE v.conflict OR c.wa_needs_assignment ORDER BY v.first_message_at DESC LIMIT 200`,
      )
    ).rows;
    res.json({ count: items.length, items });
  });
  app.post("/api/whatsapp/assignments", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const input = z
        .object({
          customers: z
            .array(
              z.object({ id: z.uuid(), version: z.number().int().positive() }),
            )
            .min(1)
            .max(200),
          ownerId: z.uuid(),
          reason: z.string().trim().min(1).max(300),
        })
        .strict()
        .parse(req.body);
      await repo.activeOwner(db, input.ownerId);
      for (const target of [...input.customers].sort((a, b) =>
        a.id.localeCompare(b.id),
      )) {
        const c = await repo.customer(db, req.actor, target.id, true, true);
        repo.checkVersion(c, target.version);
        if (c.deleted_at)
          throw new HttpError(409, "请先在回收站恢复客户，再处理WhatsApp归属");
        if (!c.wa_id) throw new HttpError(400, "只能在此分配WhatsApp客户");
        await db.query(
          "UPDATE customers SET owner_id=$2,wa_needs_assignment=false,version=version+1,updated_at=now() WHERE id=$1",
          [c.id, input.ownerId],
        );
        await assignment(
          db,
          c.id,
          c.owner_id,
          input.ownerId,
          req.actor.id,
          input.reason,
        );
        await db.query(
          "UPDATE whatsapp_conversations SET conflict=false,conflict_reason=NULL WHERE customer_id=$1",
          [c.id],
        );
        await db.query(
          "UPDATE whatsapp_alerts SET resolved_at=now() WHERE event_key IN(SELECT 'conflict:'||id::text FROM whatsapp_conversations WHERE customer_id=$1)",
          [c.id],
        );
        await repo.notifyAssignment(db, c.id, input.ownerId);
      }
      await repo.audit(db, req.actor, "批量分配WhatsApp客户", "whatsapp", {
        count: input.customers.length,
        ownerId: input.ownerId,
      });
      return { count: input.customers.length };
    }),
  );
  app.get("/api/whatsapp/customers/:id/chat", async (req, res) => {
    const c = await repo.customer(pool, req.actor, String(req.params.id));
    const visibility = req.actor.role === "admin" ? "TRUE" : "NOT v.conflict AND v.account_id IN (SELECT id FROM whatsapp_accounts WHERE provider='cloud' OR user_id=(SELECT owner_id FROM customers WHERE id=v.customer_id))";
    const conversations = (
      await pool.query(
        `SELECT a.provider,v.id,v.account_id AS "accountId",a.display_phone_number AS "displayPhoneNumber",v.wa_id AS "waId",a.user_id AS "userId",u.name AS "userName",v.last_inbound_at AS "lastInboundAt",v.conflict,a.connection_status AS "connectionStatus",u.active FROM whatsapp_conversations v JOIN whatsapp_accounts a ON a.id=v.account_id JOIN users u ON u.id=a.user_id WHERE v.customer_id=$1 AND ${visibility} ORDER BY v.first_message_at`,
        [c.id],
      )
    ).rows.map((v) => ({
      ...v,
      canSend:
        !v.conflict &&
        !c.wa_needs_assignment &&
        v.active &&
        v.connectionStatus === "connected" &&
        (req.actor.role === "admin" || v.userId === req.actor.id),
      windowOpen: v.provider === 'linked' || windowOpen(v.lastInboundAt),
    }));
    const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1)),
      limit = 50;
    const total = (
      await pool.query(
        `SELECT count(*)::int AS n FROM whatsapp_messages m JOIN whatsapp_conversations v ON v.id=m.conversation_id WHERE m.customer_id=$1 AND ${visibility}`,
        [c.id],
      )
    ).rows[0].n;
    const messages = (
      await pool.query(
        `SELECT m.id,m.conversation_id AS "conversationId",m.customer_id AS "customerId",m.whatsapp_message_id AS "whatsappMessageId",m.direction,m.message_type AS "messageType",m.text_content AS "textContent",m.message_timestamp AS "messageTimestamp",m.delivery_status AS "deliveryStatus",m.media_id AS "mediaId",m.media_mime_type AS "mediaMimeType",m.media_filename AS "mediaFilename",media.status AS "mediaStatus",m.reply_to_message_id AS "replyToMessageId",quoted.text_content AS "quotedText",m.error_code AS "errorCode",m.error_message AS "errorMessage",m.content,u.name AS "ownerName" FROM whatsapp_messages m JOIN whatsapp_conversations v ON v.id=m.conversation_id JOIN users u ON u.id=m.owner_id LEFT JOIN whatsapp_media media ON media.message_id=m.id LEFT JOIN whatsapp_messages quoted ON quoted.whatsapp_message_id=m.reply_to_message_id AND quoted.conversation_id=v.id WHERE m.customer_id=$1 AND ${visibility} ORDER BY m.message_timestamp DESC,m.id DESC LIMIT $2 OFFSET $3`,
        [c.id, limit, (page - 1) * limit],
      )
    ).rows.reverse();
    const suggestions = (
      await pool.query(
        `SELECT s.id,s.field,s.value,s.evidence,s.method,s.status FROM whatsapp_suggestions s JOIN whatsapp_messages m ON m.id=s.message_id JOIN whatsapp_conversations v ON v.id=m.conversation_id WHERE s.customer_id=$1 AND s.status='pending' AND ${visibility} ORDER BY m.message_timestamp DESC LIMIT 50`,
        [c.id],
      )
    ).rows;
    const assignments = (
      await pool.query(
        'SELECT a.id,f.name AS "fromName",t.name AS "toName",a.reason,a.created_at AS "createdAt" FROM whatsapp_assignments a LEFT JOIN users f ON f.id=a.from_user_id JOIN users t ON t.id=a.to_user_id WHERE a.customer_id=$1 ORDER BY a.created_at DESC LIMIT 100',
        [c.id],
      )
    ).rows;
    res.json({
      conversations,
      messages,
      suggestions,
      assignments,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      total,
      customerVersion: c.version,
      needsAssignment: c.wa_needs_assignment,
    });
  });
  app.post("/api/whatsapp/conversations/:id/read", async (req, res) =>
    mutate(req, res, async (db) => {
      const v = await conversation(db, req.actor, String(req.params.id));
      await db.query(
        "INSERT INTO whatsapp_reads(conversation_id,user_id) VALUES($1,$2) ON CONFLICT(conversation_id,user_id) DO UPDATE SET read_at=now()",
        [v.id, req.actor.id],
      );
      return { ok: true };
    }),
  );
  app.post("/api/whatsapp/send", async (req, res) =>
    mutate(req, res, async (db) => {
      const input = waSendSchema.parse(req.body),
        v = await conversation(db, req.actor, input.conversationId, true),
        a = await account(db, v.account_id);
      if (v.conflict || v.wa_needs_assignment)
        throw new HttpError(409, "请管理员先处理客户归属");
      if (
        !a.active ||
        a.connection_status !== "connected" ||
        (req.actor.role === "sales" && a.user_id !== req.actor.id)
      )
        throw new HttpError(
          403,
          "只能使用本人绑定且正常连接的WhatsApp号码发送",
        );
      if (a.provider !== 'linked') accountToken(a, config);
      if (a.provider === 'linked' && (input.templateId || input.replyToId)) throw new HttpError(400, '扫码模式当前仅支持普通文字回复');
      const open = a.provider === 'linked' || windowOpen(v.last_inbound_at);
      if (!input.templateId && !open)
        throw new HttpError(409, "已超过24小时回复窗口，请选择已审核模板");
      let content: unknown = {},
        type = "text",
        text = input.text;
      if (input.templateId) {
        if (!input.consentConfirmed)
          throw new HttpError(400, "发送模板前请确认客户同意接收此类消息");
        const row = (
          await db.query(
            "SELECT * FROM whatsapp_templates WHERE account_id=$1 AND template_id=$2",
            [a.id, input.templateId],
          )
        ).rows[0];
        if (
          !row ||
          row.status !== "APPROVED" ||
          new Date(row.synced_at).getTime() < Date.now() - 86400000
        )
          throw new HttpError(
            409,
            "模板未审核通过或状态超过24小时，请先同步模板",
          );
        const template = templateView(row);
        if (!template.supported)
          throw new HttpError(
            400,
            "本版只支持文本正文参数模板，请使用不含动态媒体或按钮的模板",
          );
        if (input.templateParameters.length !== template.parameterCount)
          throw new HttpError(400, "模板参数数量不匹配");
        type = "template";
        text = `[模板 ${template.name} / ${template.language}] ${input.templateParameters.join(" / ")}`;
        content = {
          templateId: input.templateId,
          template: {
            name: template.name,
            language: { code: template.language },
            ...(template.parameterCount
              ? {
                  components: [
                    {
                      type: "body",
                      parameters: input.templateParameters.map((t) => ({
                        type: "text",
                        text: t,
                      })),
                    },
                  ],
                }
              : {}),
          },
        };
      }
      let reply: string | null = null;
      if (input.replyToId) {
        const quoted = (
          await db.query(
            "SELECT whatsapp_message_id FROM whatsapp_messages WHERE id=$1 AND conversation_id=$2",
            [input.replyToId, v.id],
          )
        ).rows[0];
        if (!quoted?.whatsapp_message_id)
          throw new HttpError(400, "引用消息不属于当前会话或尚未发送");
        reply = quoted.whatsapp_message_id;
      }
      const id = randomUUID();
      await db.query(
        `INSERT INTO whatsapp_messages(id,conversation_id,customer_id,owner_id,requested_by_id,account_id,phone_number_id,wa_id,direction,message_type,text_content,reply_to_message_id,content,message_timestamp,delivery_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'outbound',$9,$10,$11,$12,now(),'queued')`,
        [
          id,
          v.id,
          v.customer_id,
          v.owner_id,
          req.actor.id,
          a.id,
          a.phone_number_id,
          v.wa_id,
          type,
          text,
          reply,
          JSON.stringify(content),
        ],
      );
      await repo.audit(db, req.actor, "排队发送WhatsApp消息", id, {
        customerId: v.customer_id,
        type,
      });
      return { id, status: "queued" };
    }),
  );
  app.post("/api/whatsapp/messages/:id/retry", async (req, res) =>
    mutate(req, res, async (db) => {
      const m = (
        await db.query(
          "SELECT * FROM whatsapp_messages WHERE id::text=$1 FOR UPDATE",
          [String(req.params.id)],
        )
      ).rows[0];
      if (!m) throw new HttpError(404, "消息不存在");
      const v = await conversation(db, req.actor, m.conversation_id),
        a = await account(db, m.account_id);
      if (req.actor.role === "sales" && a.user_id !== req.actor.id)
        throw new HttpError(403, "无权使用原发送号码");
      if (m.direction !== "outbound" || m.delivery_status !== "failed")
        throw new HttpError(
          409,
          "仅明确发送失败的消息可重试；结果不明时请等待状态回执",
        );
      if (a.provider !== 'linked' && m.message_type === "text" && !windowOpen(v.last_inbound_at))
        throw new HttpError(409, "回复窗口已结束，请改用审核模板");
      await db.query(
        "UPDATE whatsapp_messages SET delivery_status='queued',requested_by_id=$2,whatsapp_message_id=NULL,error_code=NULL,error_message=NULL,available_at=now(),locked_at=NULL WHERE id=$1",
        [m.id, req.actor.id],
      );
      return { id: m.id };
    }),
  );
  app.post("/api/whatsapp/suggestions/:id/review", async (req, res) =>
    mutate(req, res, async (db) => {
      const input = z
        .object({ accept: z.boolean(), version: z.number().int().positive() })
        .strict()
        .parse(req.body);
      const s = (
        await db.query(
          "SELECT * FROM whatsapp_suggestions WHERE id::text=$1 FOR UPDATE",
          [String(req.params.id)],
        )
      ).rows[0];
      if (!s) throw new HttpError(404, "待确认信息不存在");
      const c = await repo.customer(db, req.actor, s.customer_id, true);
      const m = (
        await db.query(
          "SELECT conversation_id FROM whatsapp_messages WHERE id=$1",
          [s.message_id],
        )
      ).rows[0];
      await conversation(db, req.actor, m.conversation_id);
      repo.checkVersion(c, input.version);
      if (s.status !== "pending") throw new HttpError(409, "该信息已处理");
      if (input.accept) {
        if (
          [
            "company",
            "contact",
            "country",
            "city",
            "email",
            "product",
            "quantity",
            "inquiry",
          ].includes(s.field)
        ) {
          await db.query(
            "UPDATE customers SET data=jsonb_set(data,ARRAY[$2],$3::jsonb),company=CASE WHEN $2='company' THEN $4 ELSE company END,version=version+1,updated_at=now() WHERE id=$1",
            [c.id, s.field, JSON.stringify(s.value), s.value],
          );
        } else {
          await db.query(
            "UPDATE customers SET data=jsonb_set(data,'{inquiry}',to_jsonb(coalesce(data->>'inquiry','')||$2::text)),version=version+1,updated_at=now() WHERE id=$1",
            [c.id, `\n${s.field}: ${s.value}`],
          );
        }
      }
      await db.query(
        "UPDATE whatsapp_suggestions SET status=$2,reviewed_by=$3,reviewed_at=now() WHERE id=$1",
        [s.id, input.accept ? "accepted" : "rejected", req.actor.id],
      );
      await repo.audit(
        db,
        req.actor,
        input.accept ? "确认WhatsApp提取资料" : "忽略WhatsApp提取资料",
        s.id,
        { field: s.field },
      );
      return { ok: true };
    }),
  );
  app.get("/api/whatsapp/messages/:id/media", async (req, res) => {
    const m = (
      await pool.query("SELECT * FROM whatsapp_messages WHERE id::text=$1", [
        String(req.params.id),
      ])
    ).rows[0];
    if (!m) throw new HttpError(404, "消息不存在");
    await conversation(pool, req.actor, m.conversation_id);
    const media = (
      await pool.query("SELECT * FROM whatsapp_media WHERE message_id=$1", [
        m.id,
      ])
    ).rows[0];
    if (media?.status !== "ready")
      throw new HttpError(409, "媒体仍在下载或暂时不可用，请稍后重试");
    const bytes = Buffer.from(media.content_base64, "base64"),
      mime = String(media.mime_type || "application/octet-stream");
    const inline =
      /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|aac|amr|wav)|video\/(mp4|3gpp))(;.*)?$/i.test(
        mime,
      );
    res.set({
      "Content-Type": mime,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(m.media_filename || "whatsapp-media")}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
    });
    const range = req.get("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        res.status(416).end();
        return;
      }
      const start = Number(match[1]),
        end = Math.min(
          bytes.length - 1,
          match[2] ? Number(match[2]) : bytes.length - 1,
        );
      if (start > end || start >= bytes.length) {
        res.status(416).set("Content-Range", `bytes */${bytes.length}`).end();
        return;
      }
      res
        .status(206)
        .set("Content-Range", `bytes ${start}-${end}/${bytes.length}`)
        .send(bytes.subarray(start, end + 1));
      return;
    }
    res.send(bytes);
  });
  app.post("/api/whatsapp/messages/:id/media/retry", async (req, res) =>
    mutate(req, res, async (db) => {
      const m = (
        await db.query("SELECT * FROM whatsapp_messages WHERE id::text=$1", [
          String(req.params.id),
        ])
      ).rows[0];
      if (!m) throw new HttpError(404, "消息不存在");
      await conversation(db, req.actor, m.conversation_id);
      await db.query(
        "UPDATE whatsapp_media SET status='pending',attempts=0,available_at=now() WHERE message_id=$1 AND status<>'ready'",
        [m.id],
      );
      return { ok: true };
    }),
  );
  app.post("/api/whatsapp/events/:id/retry", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const result = await db.query(
        "UPDATE whatsapp_webhook_events SET status='retry',attempts=0,available_at=now(),locked_at=NULL WHERE id::text=$1 AND status IN ('failed','retry') RETURNING id",
        [String(req.params.id)],
      );
      if (!result.rowCount)
        throw new HttpError(409, "只有失败或等待重试的事件可重新处理");
      await repo.audit(
        db,
        req.actor,
        "重试WhatsApp接收事件",
        result.rows[0].id,
      );
      return { ok: true };
    }),
  );
  app.get("/api/whatsapp/summary", async (req, res) => {
    const s = repo.scope(req.actor, "c"),
      settings = await repo.settings(pool),
      params = [...s.params, businessDay(settings.timezone), settings.timezone],
      day = `$${s.params.length + 1}`,
      zone = `$${s.params.length + 2}`;
    const metrics = (
      await pool.query(
        `SELECT count(*)::int AS total,count(*) FILTER(WHERE (c.created_at AT TIME ZONE ${zone})::date=${day}::date)::int AS today,count(*) FILTER(WHERE c.stage='已成交')::int AS won,count(*) FILTER(WHERE c.wa_needs_assignment)::int AS pool FROM customers c WHERE c.wa_id IS NOT NULL AND c.deleted_at IS NULL AND ${s.sql}`,
        params,
      )
    ).rows[0];
    const unread = (
      await pool.query(
        `SELECT count(*)::int AS n FROM whatsapp_messages m JOIN whatsapp_conversations v ON v.id=m.conversation_id JOIN customers c ON c.id=m.customer_id LEFT JOIN whatsapp_reads r ON r.conversation_id=v.id AND r.user_id=$${s.params.length + 1} WHERE ${s.sql} AND c.deleted_at IS NULL AND ${req.actor.role === "admin" ? "TRUE" : "NOT v.conflict"} AND m.direction='inbound' AND m.created_at>coalesce(r.read_at,'epoch')`,
        [...s.params, req.actor.id],
      )
    ).rows[0].n;
    const grouping = async (expression: string) =>
      (
        await pool.query(
          `SELECT ${expression} AS label,count(*)::int AS count FROM customers c WHERE c.wa_id IS NOT NULL AND c.deleted_at IS NULL AND ${s.sql} GROUP BY 1 ORDER BY count DESC`,
          s.params,
        )
      ).rows;
    const reminder = (await rules(pool)).reminderMinutes[0];
    const employees = (
      await pool.query(
        `SELECT u.id,u.name,count(DISTINCT c.id)::int AS customers,count(DISTINCT CASE WHEN m.direction='inbound' THEN c.id END)::int AS inquiries,count(DISTINCT CASE WHEN m.direction='outbound' AND m.sent_at IS NOT NULL THEN c.id END)::int AS replied FROM customers c JOIN users u ON u.id=c.owner_id LEFT JOIN whatsapp_messages m ON m.customer_id=c.id LEFT JOIN whatsapp_conversations v ON v.id=m.conversation_id WHERE c.wa_id IS NOT NULL AND c.deleted_at IS NULL AND ${s.sql} AND ${req.actor.role === "admin" ? "TRUE" : "NOT coalesce(v.conflict,false)"} GROUP BY u.id ORDER BY u.name`,
        s.params,
      )
    ).rows;
    const response = (
      await pool.query(
        `SELECT coalesce(avg(EXTRACT(epoch FROM (outgoing.first_reply-v.first_message_at)))/60,0)::float AS "averageFirstReplyMinutes",count(*) FILTER(WHERE unanswered.first_at<=now()-$${s.params.length + 1}::int*interval '1 minute')::int AS "overdueConversations" FROM whatsapp_conversations v JOIN customers c ON c.id=v.customer_id LEFT JOIN LATERAL(SELECT min(m.sent_at) AS first_reply FROM whatsapp_messages m WHERE m.conversation_id=v.id AND m.direction='outbound' AND m.sent_at>=v.first_message_at) outgoing ON true LEFT JOIN LATERAL(SELECT min(m.message_timestamp) AS first_at FROM whatsapp_messages m WHERE m.conversation_id=v.id AND m.direction='inbound' AND m.message_timestamp>coalesce(v.last_outbound_at,'epoch')) unanswered ON true WHERE ${s.sql} AND c.deleted_at IS NULL AND ${req.actor.role === "admin" ? "TRUE" : "NOT v.conflict"}`,
        [...s.params, reminder],
      )
    ).rows[0];
    res.json({
      metrics: { ...metrics, unread, ...response },
      employees,
      daily: (
        await pool.query(
          `SELECT (c.created_at AT TIME ZONE ${zone})::date::text AS day,count(*)::int AS count FROM customers c WHERE c.wa_id IS NOT NULL AND c.deleted_at IS NULL AND ${s.sql} AND (c.created_at AT TIME ZONE ${zone})::date>=${day}::date-29 GROUP BY 1 ORDER BY 1 DESC`,
          params,
        )
      ).rows,
      countries: await grouping(
        "coalesce(nullif(c.data->>'country',''),'未确认')",
      ),
      products: await grouping(
        "coalesce(nullif(c.data->>'product',''),'未确认')",
      ),
      accounts: await accounts(pool, req.actor),
    });
  });
  app.get("/api/whatsapp/assignment-candidates", async (req, res) => {
    requireAdmin(req.actor);
    const input = z
      .object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        ownerId: z.uuid().optional(),
      })
      .parse(req.query);
    const filter =
      "c.wa_id IS NOT NULL AND c.deleted_at IS NULL AND ($1::uuid IS NULL OR c.owner_id=$1)";
    const total = (
      await pool.query(
        `SELECT count(*)::int AS n FROM customers c WHERE ${filter}`,
        [input.ownerId || null],
      )
    ).rows[0].n;
    const items = (
      await pool.query(
        `SELECT c.id,coalesce(nullif(c.company,''),c.data->>'contact','WhatsApp新客户') AS name,c.owner_id AS "ownerId",c.version FROM customers c WHERE ${filter} ORDER BY c.created_at,c.id LIMIT 100 OFFSET $2`,
        [input.ownerId || null, (input.page - 1) * 100],
      )
    ).rows;
    res.json({
      items,
      total,
      page: input.page,
      pages: Math.max(1, Math.ceil(total / 100)),
    });
  });
  app.get("/api/whatsapp/inbox", async (req, res) => {
    const s = repo.scope(req.actor, "c");
    const items = (
      await pool.query(
        `SELECT c.id,coalesce(nullif(c.company,''),c.data->>'contact','WhatsApp新客户') AS name,c.owner_id AS "ownerId",c.version,c.last_contact_at AS "lastContactAt",c.wa_needs_assignment AS "needsAssignment",(SELECT m.text_content FROM whatsapp_messages m JOIN whatsapp_conversations v ON v.id=m.conversation_id WHERE m.customer_id=c.id AND ${req.actor.role === "admin" ? "TRUE" : "NOT v.conflict AND v.account_id IN (SELECT id FROM whatsapp_accounts WHERE provider='cloud' OR user_id=c.owner_id)"} ORDER BY m.message_timestamp DESC LIMIT 1) AS preview FROM customers c WHERE c.wa_id IS NOT NULL AND c.deleted_at IS NULL AND ${s.sql} ORDER BY c.last_contact_at DESC LIMIT 100`,
        s.params,
      )
    ).rows;
    res.json(items);
  });
}
