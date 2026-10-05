/** Formatting/validation only. Never infer ownership from a code or allocate by parsing existing codes. */
export class CodingError extends Error {}
export const BATCHES = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export type DocumentClass = { code: string; family: 'A' | 'B'; enabled: boolean };
export const CONTRACT_CLASSES: readonly DocumentClass[] = [
  ...'TC QT PI SC SO CI PL RC BP'.split(' ').map(code => ({ code, family: 'A' as const, enabled: true })),
  ...'LD WO AS QC SM CK PO SA GR AR AP EX FA DA MO'.split(' ').map(code => ({ code, family: 'B' as const, enabled: true })),
];
const entities: Record<string, { width: number; active: boolean }> = Object.fromEntries([
  ['EMP',4,true],['SUP',4,true],['AST',4,true],['LSP',3,false],['SVC',3,false],
  ['SKU',5,false],['MAT',4,false],['SMP',4,false],['BNK',2,false],['POS',3,false],
].map(([code,width,active]) => [code,{width: Number(width),active: Boolean(active)}]));
function fail(message: string): never { throw new CodingError(message); }
function normalized(value: unknown) { return typeof value === 'string' ? value.trim().toUpperCase() : fail('编码必须为文本'); }
function sequence(value: unknown, width: number) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()))) fail('流水必须为整数');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n >= 10 ** width) fail('流水超出固定编号容量，禁止复用或自动扩位');
  return String(n).padStart(width, '0');
}
export function contractDate(value: unknown): string {
  if (typeof value !== 'string') return fail('缺少业务日期');
  const input = value.trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input);
  const compact = /^\d{6}$/.test(input);
  if (!m && !compact) return fail('业务日期格式无效');
  const year = m ? Number(m[1]) : 2000 + Number(input.slice(0,2));
  const month = m ? Number(m[2]) : Number(input.slice(2,4));
  const day = m ? Number(m[3]) : Number(input.slice(4,6));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > days[month-1]) return fail('业务日期不存在');
  return String(year % 100).padStart(2,'0') + String(month).padStart(2,'0') + String(day).padStart(2,'0');
}
export function makePartnerCode(batch: unknown, seq: unknown) {
  const code = normalized(batch);
  if (code.length !== 1 || !BATCHES.includes(code)) fail('批次无效');
  return code + sequence(seq,3);
}
export function makeCustomerCode(partner: unknown, date: unknown, seq: unknown) {
  const code = normalized(partner);
  if (!/^[A-HJ-NP-Z]\d{3}$/.test(code)) fail('首次开发人编码无效');
  return code + contractDate(date) + sequence(seq,3);
}
export function isCustomerCode(value: unknown) {
  return typeof value === 'string' && /^[A-HJ-NP-Z]\d{12}$/.test(value.trim());
}
function validCustomer(value: string) {
  if (!isCustomerCode(value)) fail('客户编码无效');
  contractDate(value.slice(4,10));
  return value;
}
export function makeDocumentCode(type: unknown, input: {customer_code?: unknown; issue_date?: unknown; seq?: unknown}, classes: readonly DocumentClass[]) {
  const code = normalized(type);
  const config = classes.find(item => item.code === code && item.enabled);
  if (!config) return fail('未启用的单据类码');
  if (config.family === 'A') return validCustomer(normalized(input.customer_code)) + '-' + code + sequence(input.seq,3);
  if (input.customer_code) fail('B类编号不拼接客户编号；请在独立关联字段保存客户');
  return code + contractDate(input.issue_date) + sequence(input.seq,4);
}
export function isDocumentCode(value: unknown, classes: readonly DocumentClass[]) {
  if (typeof value !== 'string') return false;
  const code = value.trim();
  const a = /^([A-HJ-NP-Z]\d{12})-([A-Z]{2})\d{3}$/.exec(code);
  const b = /^([A-Z]{2})(\d{6})\d{4}$/.exec(code);
  try {
    if (a) { validCustomer(a[1]); return classes.some(c => c.code === a[2] && c.family === 'A'); }
    if (b) { contractDate(b[2]); return classes.some(c => c.code === b[1] && c.family === 'B'); }
    return false;
  } catch (error) { if (error instanceof CodingError) return false; throw error; }
}
export function makeEntityCode(prefix: unknown, seq: unknown) {
  const code = normalized(prefix), config = entities[code];
  if (!config?.active) return fail('实体类型不存在或仍为预留类型');
  return code + sequence(seq,config.width);
}
export function isEntityCode(value: unknown) {
  if (typeof value !== 'string') return false;
  const match = /^([A-Z]{3})(\d+)$/.exec(value);
  if (!match) return false;
  const config = entities[match[1]];
  return Boolean(config && match[2].length === config.width && Number(match[2]) > 0);
}
