import type { Express, Request, Response } from "express";
import type pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { User } from "../../shared/contracts.ts";
import { HttpError } from "../domain.ts";
import * as repo from "../repository.ts";

type Db = pg.Pool | pg.PoolClient;
type Mutate = (
  req: Request,
  res: Response,
  run: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;

export async function editableProduct(
  db: Db,
  actor: User,
  id: string,
  version: number,
  statuses = ["draft", "rejected"],
) {
  if (actor.role !== "factory")
    throw new HttpError(403, "只有工厂账号可修改供货产品");
  const row = (
    await db.query(
      `SELECT fp.* FROM factory_products fp JOIN factories f ON f.id=fp.factory_id
    JOIN factory_users fu ON fu.factory_id=f.id WHERE fp.id=$1 AND fu.user_id=$2 AND fu.status='approved'
    AND f.active AND f.deleted_at IS NULL AND fp.deleted_at IS NULL FOR UPDATE OF fp`,
      [id, actor.id],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "产品不存在或无权访问");
  if (row.version !== version || !statuses.includes(row.status))
    throw new HttpError(409, "产品版本或审核状态已变化，请刷新后重试");
  return row;
}

export async function validateImages(db: Db, productId: string, ids: string[]) {
  if (new Set(ids).size !== ids.length)
    throw new HttpError(422, "图片不能重复");
  const found = await db.query(
    "SELECT id FROM factory_product_images WHERE factory_product_id=$1 AND id=ANY($2::uuid[])",
    [productId, ids],
  );
  if (found.rowCount !== ids.length)
    throw new HttpError(
      422,
      "图片必须先上传到当前产品，不能引用其他工厂或产品的图片",
    );
}

export function registerCatalogImages(
  app: Express,
  pool: pg.Pool,
  mutate: Mutate,
) {
  app.post("/api/supply/factory-products/:id/images", async (req, res) =>
    mutate(req, res, async (db) => {
      const id = z.uuid().parse(req.params.id);
      const input = z
        .object({
          version: z.number().int().positive(),
          name: z.string().trim().min(1).max(160),
          mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
          data: z
            .string()
            .max(2800000)
            .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        })
        .parse(req.body);
      const product = await editableProduct(db, req.actor, id, input.version);
      if (product.image_ids.length >= 12)
        throw new HttpError(
          422,
          "每个产品最多展示12张图片，请先编辑移除不需要的图片",
        );
      const bytes = Buffer.from(input.data, "base64");
      if (!bytes.length || bytes.length > 2 * 1024 * 1024)
        throw new HttpError(422, "图片不能超过2MB");
      const valid =
        input.mime === "image/png"
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : input.mime === "image/jpeg"
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP";
      if (!valid) throw new HttpError(422, "图片内容与文件类型不一致");
      const size = (
        await db.query(
          "SELECT coalesce(sum(length(bytes_base64)),0)::bigint AS size FROM factory_product_images WHERE factory_product_id=$1",
          [id],
        )
      ).rows[0].size;
      if (Number(size) + input.data.length > 80 * 1024 * 1024)
        throw new HttpError(
          422,
          "此产品的历史图片已达到存储限额，请联系管理员",
        );
      const imageId = randomUUID(),
        images = [...product.image_ids, imageId];
      await db.query(
        "INSERT INTO factory_product_images(id,factory_product_id,name,mime,bytes_base64,sha256,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          imageId,
          id,
          input.name,
          input.mime,
          bytes.toString("base64"),
          createHash("sha256").update(bytes).digest("hex"),
          req.actor.id,
        ],
      );
      await db.query(
        "UPDATE factory_products SET image_ids=$2,status='draft',version=version+1,updated_at=now() WHERE id=$1",
        [id, JSON.stringify(images)],
      );
      await repo.audit(db, req.actor, "工厂上传产品图片", id, {
        imageId,
        bytes: bytes.length,
      });
      return { id: imageId, version: product.version + 1 };
    }),
  );
  app.get("/api/supply/factory-product-images/:imageId", async (req, res) => {
    const id = z.uuid().parse(req.params.imageId);
    const row = (
      await pool.query(
        `SELECT i.mime,i.bytes_base64 FROM factory_product_images i
      JOIN factory_products fp ON fp.id=i.factory_product_id JOIN factories f ON f.id=fp.factory_id
      WHERE i.id=$1 AND fp.deleted_at IS NULL AND ($2='admin'
        OR ($2='factory' AND f.active AND f.deleted_at IS NULL AND EXISTS(SELECT 1 FROM factory_users fu WHERE fu.factory_id=f.id AND fu.user_id=$3 AND fu.status='approved'))
        OR ($2='sales' AND EXISTS(SELECT 1 FROM quotation_products qp WHERE qp.id=fp.approved_product_id AND qp.data->>'active'='true' AND qp.data->'imageIds' ? $1::text)))`,
        [id, req.actor.role, req.actor.id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "图片不存在或无权访问");
    res
      .set({
        "Content-Type": row.mime,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      })
      .send(Buffer.from(row.bytes_base64, "base64"));
  });
}
