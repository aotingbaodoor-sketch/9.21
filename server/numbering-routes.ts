import type { Express, Request, Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { requireAdmin, HttpError } from "./domain.ts";
import * as repo from "./repository.ts";
type Mutate = (
  req: Request,
  res: Response,
  run: (db: pg.PoolClient) => Promise<unknown>,
) => Promise<void>;
export function registerNumbering(app: Express, pool: pg.Pool, mutate: Mutate) {
  app.get("/api/settings/document-classes", async (req, res) => {
    requireAdmin(req.actor);
    res.json(
      (
        await pool.query(
          "SELECT * FROM crm_document_class ORDER BY family,code",
        )
      ).rows,
    );
  });
  app.put("/api/settings/document-classes/:code", async (req, res) =>
    mutate(req, res, async (db) => {
      requireAdmin(req.actor);
      const code = z
        .string()
        .regex(/^[A-Z]{2}$/)
        .parse(req.params.code);
      const input = z.object({ enabled: z.boolean() }).strict().parse(req.body);
      const before = (
        await db.query(
          "SELECT * FROM crm_document_class WHERE code=$1 FOR UPDATE",
          [code],
        )
      ).rows[0];
      if (!before) throw new HttpError(404, "类码不存在");
      await db.query("UPDATE crm_document_class SET enabled=$2 WHERE code=$1", [
        code,
        input.enabled,
      ]);
      await repo.audit(db, req.actor, "设置单据类码启用状态", code, {
        before: before.enabled,
        after: input.enabled,
      });
      return { code, enabled: input.enabled };
    }),
  );
  app.get("/api/master-data/numbering", async (req, res) => {
    requireAdmin(req.actor);
    const [sequences, documents, customers, partners] = await Promise.all([
      pool.query(
        "SELECT scope_key,last_value FROM crm_document_sequence ORDER BY scope_key",
      ),
      pool.query(
        "SELECT id,doc_no,class_code,family,customer_id,doc_date,sequence_value,business_kind,created_at FROM crm_document_registry ORDER BY created_at DESC LIMIT 1000",
      ),
      pool.query(
        "SELECT c.id,c.company,c.crm_customer_code,l.partner_id AS first_dev_partner_id,l.contact_date AS first_development_date FROM customers c JOIN crm_customer_code_ledger l ON l.customer_id=c.id WHERE c.crm_customer_code IS NOT NULL ORDER BY c.crm_customer_code",
      ),
      pool.query(
        "SELECT id,partner_code,name FROM crm_partners ORDER BY partner_code",
      ),
    ]);
    res.json({
      sequences: sequences.rows,
      documents: documents.rows,
      customers: customers.rows,
      partners: partners.rows,
      limit: 1000,
    });
  });
  app.get("/api/customers/:id/document-chain", async (req, res) => {
    const customer = await repo.customer(
      pool,
      req.actor,
      z.uuid().parse(req.params.id),
    );
    const rows = (
      await pool.query(
        `SELECT DISTINCT d.id,d.doc_no,d.class_code,d.family,d.doc_date,d.business_kind,d.business_id,d.created_at,
    CASE WHEN d.class_code='WO' THEN w.id ELSE pw.id END AS work_order_id
    FROM crm_document_registry d JOIN crm_document_customer_link l ON l.document_id=d.id
    LEFT JOIN crm_work_orders w ON w.document_id=d.id
    LEFT JOIN purchase_orders p ON d.business_kind='purchase_order' AND p.id=d.business_id
    LEFT JOIN crm_manufacturing_orders m ON m.document_id=d.id
    LEFT JOIN crm_work_orders pw ON pw.id=COALESCE(p.work_order_id,m.work_order_id)
    WHERE l.customer_id=$1 ORDER BY d.created_at`,
        [customer.id],
      )
    ).rows;
    const logistics = (
      await pool.query(
        `SELECT l.id,l.doc_type,l.external_no,l.check_result,l.received_on,l.work_order_id,d.doc_no wo_no
   FROM crm_logistics_documents l JOIN crm_work_orders w ON w.id=l.work_order_id JOIN crm_document_registry d ON d.id=w.document_id
   WHERE l.customer_id=$1 ORDER BY l.created_at`,
        [customer.id],
      )
    ).rows;
    res.json({ customerId: customer.id, documents: rows, logistics });
  });
}
