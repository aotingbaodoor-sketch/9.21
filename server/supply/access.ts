import type pg from "pg";
import type { User } from "../../shared/contracts.ts";
import { HttpError } from "../domain.ts";
export type SupplyDb = pg.Pool | pg.PoolClient;
// Keep the same predicate on list, detail and every state-changing operation.
export const purchaseAccess = `($2='admin' OR ($2='sales' AND c.owner_id=$3)
  OR ($2 IN ('coordinator','technical','logistics') AND (po.coordinator_id=$3 OR EXISTS(
    SELECT 1 FROM quotation_reviews r WHERE r.quote_id=qo.quote_id AND r.assigned_to=$3
      AND r.discipline IN ('technical','logistics','production'))))
  OR ($2='factory' AND f.active AND f.deleted_at IS NULL AND EXISTS(
    SELECT 1 FROM factory_users fu WHERE fu.factory_id=po.factory_id AND fu.user_id=$3 AND fu.status='approved')))`;
export const purchaseJoins = `FROM purchase_orders po JOIN sales_orders so ON so.id=po.sales_order_id
  JOIN quotation_orders qo ON qo.id=so.quotation_order_id JOIN quotation_projects qp ON qp.id=qo.project_id
  JOIN customers c ON c.id=qp.customer_id JOIN factories f ON f.id=po.factory_id`;
export async function purchaseOrder(
  db: SupplyDb,
  actor: User,
  id: string,
  lock = false,
) {
  const row = (
    await db.query(
      `SELECT po.*,so.order_number AS sales_order_number,f.name AS factory_name,
    qo.quote_id,qp.customer_id,c.company,c.owner_id ${purchaseJoins}
    WHERE po.id=$1 AND c.deleted_at IS NULL AND ${purchaseAccess} ${lock ? "FOR UPDATE OF po" : ""}`,
      [id, actor.role, actor.id],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "工厂订单不存在或无权访问");
  return row;
}
export function reviewer(actor: User) {
  if (!["admin", "coordinator", "technical", "logistics"].includes(actor.role))
    throw new HttpError(403, "仅已分配的公司跟单、技术或物流人员可审核");
}
export function operator(actor: User) {
  if (
    !["admin", "factory", "coordinator", "technical", "logistics"].includes(
      actor.role,
    )
  )
    throw new HttpError(403, "无供应链操作权限");
}
export function publicPurchase(row: Record<string, unknown>, actor: User) {
  const {
    factory_confirmed_price,
    factory_confirmation_note,
    company,
    customer_id,
    owner_id,
    ...rest
  } = row;
  return {
    ...rest,
    ...(["admin", "factory"].includes(actor.role)
      ? { factory_confirmed_price, factory_confirmation_note }
      : {}),
    ...(actor.role !== "factory" ? { company, customer_id, owner_id } : {}),
  };
}
export function productionConfiguration(value: Record<string, unknown>) {
  const keys = [
    "key",
    "productId",
    "sku",
    "nameZh",
    "nameEn",
    "width",
    "height",
    "unit",
    "quantity",
    "columns",
    "rows",
    "panels",
    "swing",
    "specs",
    "options",
    "special",
    "notes",
    "floor",
    "room",
    "openingNumber",
    "location",
    "nonstandard",
  ];
  return Object.fromEntries(
    keys.filter((k) => k in value).map((k) => [k, value[k]]),
  );
}
