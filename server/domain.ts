import {
  createHash,
  randomBytes,
  scrypt as rawScrypt,
  timingSafeEqual,
} from "node:crypto";
import type { Customer, Settings, User } from "../shared/contracts.ts";
const scrypt = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    rawScrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
export const hashToken = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [, salt, hash] = encoded.split("$");
  if (!salt || !hash) return false;
  const result = await scrypt(password, salt);
  const expected = Buffer.from(hash, "hex");
  return result.length === expected.length && timingSafeEqual(result, expected);
}
export function businessDay(timezone: string, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dueStatus(next: string, today: string) {
  return next < today ? "已逾期" : next === today ? "今日跟进" : "即将跟进";
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const requireAdmin = (user: User) => {
  if (user.role !== "admin") throw new HttpError(403, "仅管理员可操作");
};
export function toUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    role: row.role as User["role"],
    active: row.active as boolean,
    version: row.version as number,
    avatar: row.avatar as string,
  };
}
export function toCustomer(
  row: Record<string, unknown>,
  settings: Settings,
  now = new Date(),
): Customer {
  const today = businessDay(settings.timezone, now),
    next = row.next_follow_up as string;
  return {
    ...(row.data as Customer),
    id: row.id as string,
    company: row.company as string,
    grade: row.grade as Customer["grade"],
    stage: row.stage as Customer["stage"],
    ownerId: row.owner_id as string,
    owner: row.owner as string,
    next,
    last: row.last_follow_up
      ? new Date(row.last_follow_up as string).toISOString()
      : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    deletedAt: row.deleted_at
      ? new Date(row.deleted_at as string).toISOString()
      : null,
    version: row.version as number,
    status: dueStatus(next, today),
    overdueDays: Math.max(
      0,
      Math.round((Date.parse(today) - Date.parse(next)) / 86400000),
    ),
    completedToday: row.completed_today === true,
    whatsappWaId: row.wa_id as string | null,
    firstContactAt: row.first_contact_at
      ? new Date(row.first_contact_at as string).toISOString()
      : null,
    lastContactAt: row.last_contact_at
      ? new Date(row.last_contact_at as string).toISOString()
      : null,
    whatsappUnread: Number(row.whatsapp_unread || 0),
    whatsappLastMessage: row.whatsapp_last_message as string | null,
    whatsappNeedsAssignment: row.wa_needs_assignment === true,
  };
}
