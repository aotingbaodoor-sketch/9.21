import { z } from "zod";

export const grades = ["A", "B", "C", "D"] as const;
export const stages = [
  "新询盘",
  "已联系",
  "已回复",
  "有效客户",
  "已报价",
  "样品",
  "谈判中",
  "已发PI",
  "已成交",
  "已流失",
] as const;
export const sources = [
  "阿里巴巴",
  "独立站",
  "Facebook广告",
  "Google广告",
  "LinkedIn",
  "TikTok",
  "展会",
  "WhatsApp",
  "WhatsApp自动录入",
  "Email主动开发",
  "老客户介绍",
  "线下客户",
  "其他",
] as const;
export const methods = [
  "WhatsApp",
  "电话",
  "Email",
  "微信",
  "LinkedIn",
  "阿里巴巴",
  "Facebook",
  "视频会议",
  "面谈",
  "其他",
] as const;
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "日期无效",
  );
export const passwordSchema = z.string().min(12, "密码至少12位").max(128);
const text = z.string().trim().max(500).default("");
export const customerSchema = z
  .object({
    company: z.string().trim().max(200),
    contact: text,
    country: text,
    city: text,
    phone: text,
    whatsapp: text,
    email: z.union([z.email(), z.literal("")]).default(""),
    website: z
      .string()
      .trim()
      .max(500)
      .refine(
        (v) => !v || (/^https?:\/\//i.test(v) && URL.canParse(v)),
        "网址须以 https:// 或 http:// 开头",
      )
      .default(""),
    grade: z.enum(grades).default("C"),
    stage: z.enum(stages).default("新询盘"),
    product: text,
    inquiry: z.string().max(10000).default(""),
    quantity: text,
    estimatedValue: z.number().min(0).max(1e12).default(0),
    currency: z.enum(["USD", "EUR", "GBP", "CNY", "AUD"]).default("USD"),
    source: text,
    notes: z.string().max(10000).default(""),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    ownerId: z.uuid().optional(),
    next: dateSchema.optional(),
    version: z.number().int().positive().optional(),
    allowDuplicate: z.boolean().optional(),
  })
  .strict();
export const followSchema = z
  .object({
    method: z.enum(methods),
    content: z.string().trim().min(1, "本次跟进内容必填").max(10000),
    response: z.string().max(10000).default(""),
    plan: z.string().max(10000).default(""),
    next: dateSchema.optional(),
    version: z.number().int().positive(),
  })
  .strict();
export const userSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z
      .email()
      .max(200)
      .transform((v) => v.toLowerCase()),
    role: z.enum(["admin", "sales", "logistics", "technical", "factory"]),
    active: z.boolean().default(true),
    password: passwordSchema.optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();
export const settingsSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    company: z.string().trim().min(1).max(120),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "时区无效"),
    cycles: z.object({
      A: z.number().int().min(1).max(365),
      B: z.number().int().min(1).max(365),
      C: z.number().int().min(1).max(365),
      D: z.number().int().min(1).max(365),
    }),
    version: z.number().int().positive(),
  })
  .strict();
export type Grade = (typeof grades)[number];
export type User = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "sales" | "logistics" | "technical" | "factory";
  active: boolean;
  version: number;
  avatar: string;
};
export type CustomerInput = z.infer<typeof customerSchema>;
export type Customer = CustomerInput & {
  id: string;
  ownerId: string;
  owner: string;
  next: string;
  last: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
  status: string;
  overdueDays: number;
  completedToday: boolean;
  whatsappWaId?: string | null;
  firstContactAt?: string | null;
  lastContactAt?: string | null;
  whatsappUnread?: number;
  whatsappLastMessage?: string | null;
  whatsappNeedsAssignment?: boolean;
};
export type FollowRecord = {
  id: string;
  customerId: string;
  company: string;
  user: string;
  userId: string;
  method: string;
  content: string;
  response: string;
  plan: string;
  date: string;
  next: string;
};
export type Settings = z.infer<typeof settingsSchema>;
export type CustomerPage = {
  items: Customer[];
  total: number;
  page: number;
  pages: number;
};
export type Summary = {
  today: string;
  metrics: {
    today: number;
    overdue: number;
    a: number;
    total: number;
    month: number;
    won: number;
  };
  priority: Customer[];
  grades: { label: string; count: number }[];
  countries: { label: string; count: number }[];
  sources: { label: string; count: number }[];
  stages: { label: string; count: number }[];
  owners: { label: string; count: number }[];
};
