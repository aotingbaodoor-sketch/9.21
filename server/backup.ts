import type pg from "pg";
import { transaction } from "./db.ts";
import { hashToken } from "./domain.ts";
// 会话和限流缓存不恢复；恢复后所有用户重新登录。包含密码哈希，备份必须离线加密保存。
const tables = [
  "users",
  "settings",
  "customers",
  "follow_up_records",
  "notifications",
  "notification_reads",
  "audit_logs",
  "import_batches",
  "imported_rows",
  "idempotency_keys",
  "whatsapp_settings",
  "whatsapp_accounts",
  "whatsapp_linked_sessions",
  "whatsapp_linked_auth",
  "whatsapp_linked_events",
  "whatsapp_identities",
  "whatsapp_conversations",
  "whatsapp_messages",
  "whatsapp_reads",
  "whatsapp_webhook_events",
  "whatsapp_delivery_events",
  "whatsapp_assignments",
  "whatsapp_suggestions",
  "whatsapp_media",
  "whatsapp_alerts",
  "whatsapp_templates",
  "quotation_settings",
  "quotation_products",
  "quotation_projects",
  "quotation_freight",
  "quotation_versions",
  "quotation_files",
  "quotation_reviews",
  "quotation_orders",
  "quotation_documents",
  "quotation_bundles",
  "factories",
  "factory_users",
  "factory_products",
  "factory_product_images",
  "sales_orders",
  "sales_order_items",
  "purchase_orders",
  "purchase_order_items",
  "production_updates",
  "production_issues",
  "quality_inspections",
  "production_media",
  "rework_tasks",
  "shipment_packages",
  "shipment_package_items",
  "shipments",
  "shipment_package_allocations",
] as const;
type Snapshot = {
  format: "autinberg-backup-v1";
  createdAt: string;
  migrations: unknown[];
  tables: Record<string, Record<string, unknown>[]>;
};
export async function backup(pool: pg.Pool) {
  const payload = await transaction(pool, async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const data: Snapshot = {
      format: "autinberg-backup-v1",
      createdAt: new Date().toISOString(),
      migrations: (
        await db.query(
          "SELECT name,checksum FROM schema_migrations ORDER BY name",
        )
      ).rows,
      tables: {},
    };
    for (const name of tables)
      data.tables[name] = (await db.query(`SELECT * FROM ${name}`)).rows;
    return data;
  });
  const serialized = JSON.stringify(payload);
  return {
    sha256: hashToken(serialized),
    payload: JSON.parse(serialized) as Snapshot,
  };
}
export async function restore(
  pool: pg.Pool,
  archive: Awaited<ReturnType<typeof backup>>,
) {
  if (
    archive?.payload?.format !== "autinberg-backup-v1" ||
    archive.sha256 !== hashToken(JSON.stringify(archive.payload))
  )
    throw new Error("备份格式或 SHA256 校验失败");
  return transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(825114)");
    const migrations = (
      await db.query(
        "SELECT name,checksum FROM schema_migrations ORDER BY name",
      )
    ).rows;
    if (
      JSON.stringify(migrations) !== JSON.stringify(archive.payload.migrations)
    )
      throw new Error("迁移版本与备份不一致，请使用对应版本代码恢复");
    for (const name of tables.filter(
      (n) => n !== "settings" && n !== "whatsapp_settings" && n !== "quotation_settings",
    ))
      if ((await db.query(`SELECT 1 FROM ${name} LIMIT 1`)).rowCount)
        throw new Error(
          "恢复目标数据库不是空库，已拒绝覆盖。请新建独立恢复数据库。",
        );
    const counts: Record<string, number> = {};
    for (const name of tables) {
      const columns = new Map<string, string>(
        (
          await db.query(
            "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",
            [name],
          )
        ).rows.map((r) => [r.column_name, r.data_type]),
      );
      const rows = archive.payload.tables[name];
      if (!Array.isArray(rows)) throw new Error(`缺少数据表 ${name}`);
      for (const row of rows) {
        const keys = Object.keys(row);
        if (!keys.length || keys.some((k) => !columns.has(k)))
          throw new Error("备份字段无效");
        const onConflict =
          name === "settings" || name === "whatsapp_settings" || name === "quotation_settings"
            ? ` ON CONFLICT(id) DO UPDATE SET ${keys
                .filter((k) => k !== "id")
                .map((k) => `"${k}"=EXCLUDED."${k}"`)
                .join(",")}`
            : "";
        await db.query(
          `INSERT INTO ${name}(${keys.map((k) => `"${k}"`).join(",")}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")})${onConflict}`,
          keys.map((k) =>
            columns.get(k) === "jsonb" || columns.get(k) === "json"
              ? JSON.stringify(row[k])
              : row[k],
          ),
        );
      }
      counts[name] = rows.length;
    }
    return counts;
  });
}
