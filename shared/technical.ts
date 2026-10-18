import { z } from "zod";
// AUT TC→MO 20261015 §2: this registry owns both the form and the server whitelist.
export const TC_FIELDS = {
  color: "颜色 / Color",
  glassThickness: "玻璃厚度 / Glass thickness",
  cavity: "中空层 / Cavity",
  hardwareModel: "五金型号 / Hardware model",
  trim: "门套 / Trim",
  wallThickness: "墙厚 / Wall thickness",
  moisture: "防潮 / Moisture",
  termite: "防蚁 / Termite",
  productType: "产品类型 / Product type",
  openingSize: "洞口尺寸 / Opening size",
  leafCount: "扇数 / Leaves",
  openingDirection: "开启方向 / Opening direction",
  threshold: "门槛 / Threshold",
  leafWeight: "扇重 / Leaf weight",
  profile: "型材系列 / Profile",
  thickness: "壁厚 / Thickness",
  material: "材质 / Material",
  finish: "表面处理 / Finish",
  glass: "玻璃配置 / Glass",
  glassType: "玻璃种类 / Glass type",
  tempered: "钢化 / Tempered",
  laminated: "夹胶 / Laminated",
  gas: "充气 / Gas",
  warmEdge: "暖边条 / Warm edge",
  seals: "密封胶条 / Seals",
  thermalBreak: "隔热条 / Thermal break",
  locks: "锁具 / Locks",
  hinges: "合页 / Hinges",
  closers: "闭门器 / Closers",
  stoppers: "门吸 / Stoppers",
  handles: "拉手与执手 / Handles",
  drainage: "排水 / Drainage",
  security: "防盗等级 / Security",
  transmission: "传动器 / Transmission",
  lockingPoints: "锁点 / Locking points",
  screens: "纱网 / Screens",
  hardwareBrand: "五金品牌 / Hardware brand",
  finalHardware: "升级后的最终五金配置 / Final hardware",
  acoustic: "隔音 / Acoustic",
  thermal: "保温 / Thermal",
  fire: "防火 / Fire",
  ballistic: "防弹 / Ballistic",
  mosquito: "防蚊 / Mosquito",
  accessibility: "无障碍 / Accessibility",
  packing: "包装方式 / Packing",
  protection: "内部防护 / Protection",
  vi: "脱敏VI物料 / Redacted VI",
  marks: "脱敏唛头 / Redacted marks",
  certifications: "认证要求 / Certifications",
  thirdPartyTests: "第三方检测项目 / Third-party tests",
  buildingType: "建筑类型 / Building type",
  installation: "安装位置（不含地址）/ Installation",
  wall: "墙体结构 / Wall",
  embeds: "预埋件 / Embeds",
  installationGuide: "安装指导 / Installation guide",
  spares: "售后配件 / Spares",
  floorHeight: "楼层高度 / Floor height",
  climate: "气候条件 / Climate",
  special: "特殊技术要求 / Special requirements",
  sample: "技术封样依据 / Sample reference",
} as const;
const short = z.string().trim().max(2000);
const fieldShape = Object.fromEntries(
  Object.keys(TC_FIELDS).map((k) => [k, short.default("")]),
) as Record<keyof typeof TC_FIELDS, z.ZodDefault<z.ZodString>>;
export const tcFieldsSchema = z.object(fieldShape).strict();
export const tcLineSchema = z
  .object({
    lineKey: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z0-9_-]+$/),
    kind: z.enum(["door", "window", "wall_panel"]),
    quantity: z.number().positive().max(100000),
    widthMm: z.number().positive().max(100000),
    heightMm: z.number().positive().max(100000),
    fields: tcFieldsSchema,
  })
  .strict();
export const tcTechnicalSchema = z
  .object({ items: z.array(tcLineSchema).min(1).max(100) })
  .strict()
  .refine(
    (v) => new Set(v.items.map((i) => i.lineKey)).size === v.items.length,
    "产品行标识不能重复",
  );
export const tcBusinessSchema = z
  .object({
    originalRequirements:z.record(z.string().max(60),tcFieldsSchema).default({}),
    projectName: short.default(""),
    country: short.default(""),
    port: short.default(""),
    source: short.default(""),
    tradeTerm: short.default(""),
    transport: short.default(""),
    conflicts: short.default(""),
    upgradeFees: short.default(""),
    certificationPayer: short.default(""),
    certificationPeriod: short.default(""),
  })
  .strict();
export const productionSchema = z
  .object({
    requiredDate: z.iso.date(),
    batch: z.string().trim().min(1).max(100),
    process: z.string().trim().min(1).max(2000),
    packingMarks: z.string().trim().min(1).max(2000),
    qualityPoints: z.string().trim().min(1).max(2000),
  })
  .strict();
export const PRODUCTION_FIELDS = {
  requiredDate: "交期 / Required date",
  batch: "批次 / Batch",
  process: "工序工艺 / Process",
  packingMarks: "包装标识 / Packing marks",
  qualityPoints: "质检要点 / QC points",
};
export const TC_GROUPS: {title:string;keys:(keyof typeof TC_FIELDS)[]}[] = [
  {title:'一、产品基础信息 / Basic information',keys:['productType','openingSize','leafCount','openingDirection','threshold','leafWeight','profile','thickness','material','finish','color','trim','wallThickness']},
  {title:'二、玻璃及辅材 / Glass and accessories',keys:['glass','glassThickness','cavity','glassType','tempered','laminated','gas','warmEdge','seals','thermalBreak']},
  {title:'三、五金及升级后最终配置 / Final hardware',keys:['locks','hinges','closers','stoppers','handles','drainage','security','transmission','lockingPoints','screens','hardwareBrand','hardwareModel','finalHardware']},
  {title:'四、性能与特殊要求 / Performance',keys:['acoustic','thermal','fire','ballistic','mosquito','accessibility','moisture','termite']},
  {title:'五、包装及认证检测 / Packing and certification',keys:['packing','protection','vi','marks','certifications','thirdPartyTests']},
  {title:'六、使用场景与安装环境 / Installation',keys:['buildingType','installation','wall','embeds','installationGuide','spares','floorHeight','climate']},
  {title:'七、特殊要求与封样 / Special requirements',keys:['special','sample']},
];
export type TcTechnical = z.infer<typeof tcTechnicalSchema>;
export function technicalDifferences(source: TcTechnical, actual: TcTechnical) {
  const differences: string[] = [];
  for (const line of actual.items) {
    const original = source.items.find((i) => i.lineKey === line.lineKey);
    if (!original) {
      differences.push(`${line.lineKey}: 不属于源TC`);
      continue;
    }
    for (const key of ["kind", "widthMm", "heightMm"] as const)
      if (original[key] !== line[key])
        differences.push(
          `${line.lineKey}.${key}: ${original[key]} → ${line[key]}`,
        );
    for (const key of Object.keys(TC_FIELDS) as (keyof typeof TC_FIELDS)[])
      if (original.fields[key] !== line.fields[key])
        differences.push(
          `${line.lineKey}.${TC_FIELDS[key]}: ${original.fields[key]} → ${line.fields[key]}`,
        );
    if (line.quantity > original.quantity)
      differences.push(`${line.lineKey}: 数量超过TC`);
  }
  return differences;
}
export function selectBatch(
  source: TcTechnical,
  lines: { lineKey: string; quantity: number }[],
): TcTechnical {
  return tcTechnicalSchema.parse({
    items: lines.map((line) => {
      const s = source.items.find((i) => i.lineKey === line.lineKey);
      if (!s) throw new Error("分批明细不存在于源TC");
      return { ...s, quantity: line.quantity };
    }),
  });
}
