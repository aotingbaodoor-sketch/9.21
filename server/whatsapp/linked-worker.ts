import makeWASocket, {
  DisconnectReason,
  jidNormalizedUser,
  normalizeMessageContent,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { transaction } from "../db.ts";
import { linkedAuth, openLinked, sealLinked } from "./linked-auth.ts";
import { encrypt, hasKey, normalizeNumber, type WaConfig } from "./security.ts";
import { createWhatsAppService } from "./service.ts";

type Running = {
  socket: WASocket;
  generation: number;
  open: boolean;
  work: Promise<void>;
};
// One dedicated DB connection holds a session advisory lock, fencing overlapping Railway deployments.
export function createLinkedWorker(
  pool: pg.Pool,
  config: WaConfig,
  socketFactory: typeof makeWASocket = makeWASocket,
) {
  const running = new Map<string, Running>();
  const retry = new Map<string, { at: number; attempts: number }>();
  const service = createWhatsAppService(pool, config);
  let leader: pg.PoolClient | null = null,
    busy = false,
    stopped = false;
  const silent = pino({ level: "silent" });
  const endAll = () => {
    for (const r of running.values()) r.socket.end(undefined);
    running.clear();
  };
  async function start(user: string, generation: number) {
    await pool.query(
      "UPDATE whatsapp_linked_sessions SET status='connecting',qr_encrypted=NULL,qr_expires_at=NULL WHERE user_id=$1 AND generation=$2 AND desired",
      [user, generation],
    );
    const auth = await linkedAuth(pool, user, config);
    // Do not use file auth, stdout QR, historical sync, group imports or automatic replies.
    const socket = socketFactory({
      auth: auth.state,
      logger: silent,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false,
      browser: ["AUTINBERG CRM", "Chrome", "1.0"],
      getMessage: async () => undefined,
    });
    const r: Running = {
      socket,
      generation,
      open: false,
      work: Promise.resolve(),
    };
    running.set(user, r);
    const current = () => !stopped && !!leader && running.get(user) === r;
    const serial = (fn: () => Promise<void>) => {
      r.work = r.work
        .then(async () => {
          if (current()) await fn();
        })
        .catch(async () => {
          if (current())
            await pool
              .query(
                "UPDATE whatsapp_linked_sessions SET error='设备处理失败，记录已保留；请检查连接状态' WHERE user_id=$1",
                [user],
              )
              .catch(() => {});
        });
    };
    socket.ev.on("creds.update", () => serial(auth.save));
    socket.ev.on("connection.update", (update) =>
      serial(async () => {
        if (update.qr)
          await pool.query(
            "UPDATE whatsapp_linked_sessions SET status='qr',qr_encrypted=$2,qr_expires_at=now()+interval '45 seconds',error=NULL WHERE user_id=$1 AND generation=$3 AND desired",
            [user, encrypt(update.qr, config), generation],
          );
        if (update.connection === "open") {
          const number = normalizeNumber(
            jidNormalizedUser(socket.user?.id || "").split("@")[0],
          );
          if (!number) throw new Error("No verified device number");
          try {
            await transaction(pool, async (db) => {
              await db.query("SELECT pg_advisory_xact_lock(825118)");
              const session = (
                await db.query(
                  "SELECT * FROM whatsapp_linked_sessions WHERE user_id=$1 AND desired AND generation=$2 FOR UPDATE",
                  [user, generation],
                )
              ).rows[0];
              if (!session) throw new Error("Stale connect");
              const existing = (
                await db.query(
                  "SELECT * FROM whatsapp_accounts WHERE regexp_replace(display_phone_number,'[^0-9]','','g')=$1 FOR UPDATE",
                  [number],
                )
              ).rows[0];
              if (
                existing &&
                (existing.user_id !== user || existing.provider !== "linked")
              )
                throw new Error("Number already owned");
              const id = existing?.id || randomUUID();
              if (session.account_id && session.account_id !== id)
                await db.query(
                  "UPDATE whatsapp_accounts SET connection_status='disconnected' WHERE id=$1",
                  [session.account_id],
                );
              await db.query(
                "INSERT INTO whatsapp_accounts(id,user_id,waba_id,phone_number_id,display_phone_number,token_reference,provider,subscription_status) VALUES($1,$2,'linked',$3,$4,'LINKED_DEVICE','linked','not_applicable') ON CONFLICT(id) DO UPDATE SET connection_status='connected',last_error=NULL,connected_at=now(),version=whatsapp_accounts.version+1",
                [id, user, "linked:" + number, "+" + number],
              );
              await db.query(
                "UPDATE whatsapp_linked_sessions SET status='connected',account_id=$2,phone=$3,qr_encrypted=NULL,qr_expires_at=NULL,error=NULL WHERE user_id=$1",
                [user, id, "+" + number],
              );
            });
            r.open = true;
            retry.delete(user);
          } catch {
            await pool.query(
              "UPDATE whatsapp_linked_sessions SET desired=false,status='error',qr_encrypted=NULL,error='号码无法绑定：可能已属于其他员工或官方接入，请管理员核对；没有转移任何客户' WHERE user_id=$1",
              [user],
            );
            running.delete(user);
            socket.end(undefined);
          }
        }
        if (update.connection === "close") {
          r.open = false;
          const code = (
            update.lastDisconnect?.error as { output?: { statusCode?: number } }
          )?.output?.statusCode;
          const terminal =
            code === DisconnectReason.loggedOut ||
            code === DisconnectReason.badSession ||
            code === DisconnectReason.connectionReplaced;
          const attempts = (retry.get(user)?.attempts || 0) + 1;
          retry.set(user, {
            attempts,
            at:
              Date.now() +
              (code === DisconnectReason.restartRequired
                ? 1000
                : Math.min(60000, 2000 * 2 ** Math.min(attempts, 5))),
          });
          await pool.query(
            "UPDATE whatsapp_linked_sessions SET status=$2,desired=CASE WHEN $3 THEN false ELSE desired END,qr_encrypted=NULL,qr_expires_at=NULL,error=$4 WHERE user_id=$1 AND generation=$5",
            [
              user,
              terminal ? "expired" : "reconnecting",
              terminal,
              terminal
                ? "设备授权失效或被另一连接替换，请在手机核对后重新连接"
                : "连接已断开，后台正在重连",
              generation,
            ],
          );
          await pool.query(
            "UPDATE whatsapp_accounts SET connection_status='disconnected' WHERE id=(SELECT account_id FROM whatsapp_linked_sessions WHERE user_id=$1)",
            [user],
          );
          running.delete(user);
          if (
            code === DisconnectReason.loggedOut ||
            code === DisconnectReason.badSession
          )
            await pool.query(
              "DELETE FROM whatsapp_linked_auth WHERE user_id=$1",
              [user],
            );
        }
      }),
    );
    socket.ev.on("messages.upsert", (event) => {
      if (event.type !== "notify") return;
      serial(async () => {
        for (const message of event.messages) {
          if (message.key.fromMe || !message.key.id || !message.message)
            continue;
          const jid = message.key.remoteJid || "";
          if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid"))
            continue;
          await pool.query(
            "INSERT INTO whatsapp_linked_events(id,user_id,event_key,encrypted_payload,account_id) SELECT $1,$2,$3,$4,account_id FROM whatsapp_linked_sessions WHERE user_id=$2 AND account_id IS NOT NULL ON CONFLICT(user_id,event_key) DO NOTHING",
            [
              randomUUID(),
              user,
              message.key.id,
              sealLinked(message, user, "message", message.key.id, config),
            ],
          );
        }
      });
    });
    socket.ev.on("messages.update", (updates) =>
      serial(async () => {
        for (const { key, update } of updates) {
          if (!key.fromMe || !key.id || !update.status) continue;
          const status =
            update.status >= 4
              ? "read"
              : update.status >= 3
                ? "delivered"
                : update.status >= 2
                  ? "sent"
                  : null;
          if (!status) continue;
          await pool.query(
            `UPDATE whatsapp_messages SET delivery_status=$3,delivered_at=CASE WHEN $3 IN ('delivered','read') THEN coalesce(delivered_at,now()) ELSE delivered_at END,read_at=CASE WHEN $3='read' THEN coalesce(read_at,now()) ELSE read_at END WHERE whatsapp_message_id=$1 AND account_id=(SELECT account_id FROM whatsapp_linked_sessions WHERE user_id=$2) AND direction='outbound' AND CASE delivery_status WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'sent' THEN 2 ELSE 0 END < $4`,
            ["linked:" + user + ":" + key.id, user, status, update.status],
          );
        }
      }),
    );
  }
  async function inbound() {
    const events = (
      await pool.query(
        "SELECT e.*,a.phone_number_id FROM whatsapp_linked_events e JOIN whatsapp_accounts a ON a.id=e.account_id WHERE e.processed_at IS NULL AND e.attempts<8 AND (e.attempts=0 OR e.created_at < now()-e.attempts*interval '1 minute') ORDER BY e.created_at LIMIT 20",
      )
    ).rows;
    for (const event of events) {
      try {
        const message = openLinked(
          event.encrypted_payload,
          event.user_id,
          "message",
          event.event_key,
          config,
        ) as WAMessage;
        let jid = message.key.remoteJid || "";
        if (jid.endsWith("@lid"))
          jid =
            message.key.remoteJidAlt ||
            (await running
              .get(event.user_id)
              ?.socket.signalRepository.lidMapping.getPNForLID(jid)) ||
            "";
        if (!jid.endsWith("@s.whatsapp.net"))
          throw new Error("Phone mapping unavailable");
        const number = normalizeNumber(jidNormalizedUser(jid).split("@")[0]);
        if (!number) throw new Error("Phone mapping unavailable");
        const content = normalizeMessageContent(message.message);
        const text =
          content?.conversation || content?.extendedTextMessage?.text;
        await transaction(pool, async (db) => {
          await service.processPayload(db, {
            object: "whatsapp_business_account",
            entry: [
              {
                id: "linked",
                changes: [
                  {
                    field: "messages",
                    value: {
                      metadata: { phone_number_id: event.phone_number_id },
                      contacts: [
                        {
                          wa_id: number,
                          profile: { name: message.pushName || "" },
                        },
                      ],
                      messages: [
                        {
                          id: "linked:" + event.user_id + ":" + event.event_key,
                          from: number,
                          timestamp: String(
                            message.messageTimestamp ||
                              Math.floor(Date.now() / 1000),
                          ),
                          type: text ? "text" : "unsupported",
                          text: { body: text || "" },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          });
          await db.query(
            "UPDATE whatsapp_linked_events SET processed_at=now(),error=NULL WHERE id=$1",
            [event.id],
          );
        });
      } catch {
        await pool.query(
          "UPDATE whatsapp_linked_events SET attempts=attempts+1,error='消息暂不能处理：等待号码映射或检查数据库；原始事件已加密保留' WHERE id=$1",
          [event.id],
        );
        await pool.query(
          "UPDATE whatsapp_linked_sessions SET error='有消息待处理，请管理员检查；图片、文件和群聊尚未支持' WHERE user_id=$1",
          [event.user_id],
        );
      }
    }
  }
  async function outbound() {
    const rows = (
      await pool.query(
        "SELECT m.id,a.user_id FROM whatsapp_messages m JOIN whatsapp_accounts a ON a.id=m.account_id WHERE a.provider='linked' AND m.delivery_status='queued' AND m.direction='outbound' ORDER BY m.created_at LIMIT 10",
      )
    ).rows;
    for (const row of rows) {
      const r = running.get(row.user_id);
      if (!r?.open) continue;
      const m = (
        await pool.query(
          "UPDATE whatsapp_messages SET delivery_status='sending',locked_at=now(),attempts=attempts+1 WHERE id=$1 AND delivery_status='queued' RETURNING *",
          [row.id],
        )
      ).rows[0];
      if (!m) continue;
      const allowed = (
        await pool.query(
          "SELECT 1 FROM whatsapp_messages m JOIN whatsapp_conversations v ON v.id=m.conversation_id JOIN customers c ON c.id=v.customer_id JOIN whatsapp_accounts a ON a.id=m.account_id JOIN users u ON u.id=m.requested_by_id JOIN users owner ON owner.id=a.user_id WHERE m.id=$1 AND u.active AND owner.active AND a.connection_status='connected' AND NOT v.conflict AND NOT c.wa_needs_assignment AND c.deleted_at IS NULL AND (u.role='admin' OR (u.role='sales' AND a.user_id=u.id AND c.owner_id=u.id))",
          [m.id],
        )
      ).rowCount;
      if (!allowed || m.message_type !== "text") {
        await pool.query(
          "UPDATE whatsapp_messages SET delivery_status='failed',error_message='权限或连接状态已改变，扫码模式仅支持文字' WHERE id=$1",
          [m.id],
        );
        continue;
      }
      // Persist the message ID before network I/O; never retry uncertain sends automatically.
      const id = randomUUID().replaceAll("-", "").toUpperCase();
      await pool.query(
        "UPDATE whatsapp_messages SET whatsapp_message_id=$2 WHERE id=$1",
        [m.id, "linked:" + row.user_id + ":" + id],
      );
      try {
        await r.socket.sendMessage(
          m.wa_id + "@s.whatsapp.net",
          { text: m.text_content },
          { messageId: id },
        );
        await pool.query(
          "UPDATE whatsapp_messages SET delivery_status=CASE WHEN delivery_status IN ('delivered','read') THEN delivery_status ELSE 'sent' END,sent_at=now(),locked_at=NULL WHERE id=$1",
          [m.id],
        );
        await pool.query(
          "UPDATE whatsapp_conversations SET last_outbound_at=now() WHERE id=$1",
          [m.conversation_id],
        );
      } catch {
        await pool.query(
          "UPDATE whatsapp_messages SET delivery_status=CASE WHEN delivery_status IN ('delivered','read') THEN delivery_status ELSE 'unknown' END,error_message='发送结果未确认，请核对手机后处理；不会自动重复发送',locked_at=NULL WHERE id=$1",
          [m.id],
        );
      }
    }
  }
  return {
    async tick() {
      if (busy || stopped || !hasKey(config)) return;
      busy = true;
      try {
        if (!leader) {
          const candidate = await pool.connect();
          const locked = (
            await candidate.query(
              "SELECT pg_try_advisory_lock(825130) AS locked",
            )
          ).rows[0].locked;
          if (!locked) {
            candidate.release();
            return;
          }
          leader = candidate;
          candidate.on("error", () => {
            leader = null;
            stopped = true;
            endAll();
          });
        }
        await leader.query("SELECT 1");
        const sessions = (
          await pool.query(
            "SELECT s.*,u.active FROM whatsapp_linked_sessions s JOIN users u ON u.id=s.user_id",
          )
        ).rows;
        for (const s of sessions) {
          const r = running.get(s.user_id);
          if (r && (!s.desired || !s.active || r.generation !== s.generation)) {
            running.delete(s.user_id);
            await r.work;
            if (s.status === "logging_out")
              await r.socket.logout().catch(() => {});
            r.socket.end(undefined);
          }
          if (s.status === "logging_out") {
            await pool.query(
              "DELETE FROM whatsapp_linked_auth WHERE user_id=$1",
              [s.user_id],
            );
            await pool.query(
              "UPDATE whatsapp_linked_sessions SET status='disconnected',qr_encrypted=NULL,qr_expires_at=NULL WHERE user_id=$1",
              [s.user_id],
            );
            await pool.query(
              "UPDATE whatsapp_accounts SET connection_status='disconnected' WHERE id=$1",
              [s.account_id],
            );
          }
          if (!s.active) {
            await pool.query(
              "UPDATE whatsapp_linked_sessions SET desired=false,status='disconnected',qr_encrypted=NULL,error='员工账号已停用，连接已停止' WHERE user_id=$1",
              [s.user_id],
            );
            await pool.query(
              "UPDATE whatsapp_accounts SET connection_status='disconnected' WHERE id=$1",
              [s.account_id],
            );
          }
          if (
            s.desired &&
            s.active &&
            !running.has(s.user_id) &&
            (retry.get(s.user_id)?.at || 0) <= Date.now()
          )
            await start(s.user_id, s.generation);
        }
        await pool.query(
          "UPDATE whatsapp_linked_sessions SET heartbeat_at=now()",
        );
        await inbound();
        await outbound();
      } catch {
        endAll();
        if (leader) {
          leader.release(true);
          leader = null;
        }
        throw new Error("Linked worker failed safely");
      } finally {
        busy = false;
      }
    },
    async stop() {
      stopped = true;
      const pending = [...running.values()].map((r) => r.work);
      endAll();
      await Promise.allSettled(pending);
      if (leader) {
        await leader.query("SELECT pg_advisory_unlock(825130)").catch(() => {});
        leader.release();
        leader = null;
      }
    },
  };
}
