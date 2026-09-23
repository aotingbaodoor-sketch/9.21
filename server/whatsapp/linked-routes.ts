import type { Express, Request, Response } from "express";
import type pg from "pg";
import QRCode from "qrcode";
import { z } from "zod";
import { HttpError } from "../domain.ts";
import { decrypt, hasKey, waConfig } from "./security.ts";
type Mutate = (
  req: Request,
  res: Response,
  run: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
export function registerLinkedRoutes(
  app: Express,
  pool: pg.Pool,
  mutate: Mutate,
) {
  app.get("/api/whatsapp/linked", async (req, res) => {
    const config = waConfig();
    const row = (
      await pool.query(
        "SELECT status,phone,error,qr_encrypted,qr_expires_at,heartbeat_at FROM whatsapp_linked_sessions WHERE user_id=$1",
        [req.actor.id],
      )
    ).rows[0];
    const live =
      row?.heartbeat_at &&
      Date.now() - new Date(row.heartbeat_at).getTime() < 20000;
    const qr =
      live &&
      row?.status === "qr" &&
      row.qr_expires_at > Date.now() &&
      row.qr_encrypted &&
      hasKey(config)
        ? await QRCode.toDataURL(decrypt(row.qr_encrypted, config), {
            width: 320,
            margin: 4,
          })
        : null;
    res.json({
      configured: hasKey(config),
      status: row ? (live ? row.status : "worker_offline") : "disconnected",
      phone: row?.phone || null,
      error: row?.error || null,
      qr,
      expiresAt: qr ? row.qr_expires_at : null,
    });
  });
  app.post("/api/whatsapp/linked", async (req, res) =>
    mutate(req, res, async (db) => {
      const input = z
        .object({
          action: z.enum(["connect", "reconnect", "logout"]),
          testAccountConfirmed: z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
      if (!hasKey(waConfig()))
        throw new HttpError(
          503,
          "服务端加密密钥尚未配置，不能安全保存关联设备",
        );
      if (input.action !== "logout" && !input.testAccountConfirmed)
        throw new HttpError(400, "请先确认使用测试账号并了解非官方接入风险");
      await db.query(
        `INSERT INTO whatsapp_linked_sessions(user_id,desired,status) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET desired=EXCLUDED.desired,generation=whatsapp_linked_sessions.generation+1,status=EXCLUDED.status,qr_encrypted=NULL,qr_expires_at=NULL,error=NULL,updated_at=now()`,
        [
          req.actor.id,
          input.action !== "logout",
          input.action === "logout" ? "logging_out" : "connecting",
        ],
      );
      if (input.action === "reconnect")
        await db.query(
          "UPDATE whatsapp_linked_events SET attempts=0,error=NULL WHERE user_id=$1 AND processed_at IS NULL",
          [req.actor.id],
        );
      return { ok: true };
    }),
  );
}
