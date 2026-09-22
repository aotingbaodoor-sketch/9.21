import { z } from "zod";
export const productionStages = [
  "order_confirmed",
  "drawing_confirmed",
  "materials",
  "cutting",
  "machining",
  "surface_treatment",
  "assembly",
  "glass",
  "hardware",
  "testing",
  "quality",
  "packing",
  "ready_to_ship",
  "shipped",
] as const;
export const stageNames: Record<string, string> = {
  order_confirmed: "订单确认",
  drawing_confirmed: "图纸确认",
  materials: "材料到厂",
  cutting: "开料",
  machining: "机加工",
  surface_treatment: "表面处理",
  assembly: "组装",
  glass: "玻璃生产",
  hardware: "五金安装",
  testing: "调试",
  quality: "质检",
  packing: "包装",
  ready_to_ship: "等待出货",
  shipped: "已出货",
};
export const supplyLabels: Record<string, string> = {
  draft: "待确认",
  sent: "已发单",
  accepted: "工厂已接单",
  in_production: "生产中",
  quality_hold: "质检待处理",
  ready: "待发货",
  shipped: "全部已发货",
  cancelled: "已取消",
  pending: "待审核",
  approved: "已审核",
  rejected: "已退回",
  open: "待处理",
  submitted: "待复核",
  closed: "已完成",
  passed: "质检通过",
  failed: "质检不通过",
  conditional: "有条件通过",
  dispatched: "运输中",
  received: "已签收",
};
const note = z.string().trim().max(3000);
export const reviewSchema = z.object({
  version: z.number().int().positive(),
  status: z.enum(["approved", "rejected"]),
  note: note.min(2),
});
export const packageSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    lengthMm: z.number().positive().max(100000),
    widthMm: z.number().positive().max(100000),
    heightMm: z.number().positive().max(100000),
    netKg: z.number().min(0).max(1e6),
    grossKg: z.number().positive().max(1e6),
    note: note.default(""),
    items: z
      .array(
        z.object({
          itemId: z.uuid(),
          quantity: z.number().int().positive().max(1000000),
        }),
      )
      .min(1)
      .max(500),
  })
  .refine((x) => x.grossKg >= x.netKg, "毛重不能低于净重")
  .refine(
    (x) => new Set(x.items.map((i) => i.itemId)).size === x.items.length,
    "包装明细不能重复",
  );
export const shipmentSchema = z
  .object({
    packageIds: z.array(z.uuid()).min(1).max(500),
    carrier: z.string().trim().min(1).max(160),
    trackingNumber: z.string().trim().max(160).default(""),
    note: note.default(""),
  })
  .refine(
    (x) => new Set(x.packageIds).size === x.packageIds.length,
    "包装不能重复",
  );
