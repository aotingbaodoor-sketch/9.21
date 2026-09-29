/** Pure formatting only. Allocation must occur in a database transaction, never from a list index. */
import { BATCHES, makePartnerCode, makeEntityCode, makeCustomerCode } from './coding-contract.ts';
export const PARTNER_BATCHES = BATCHES;

function serial(value: number, maximum: number, label: string) {
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error(`${label}超出范围（1至${maximum}），不能改变编号格式或回收旧号`);
  return value;
}

export function partnerCode(joinYear: number, assignedSequence: number) {
  const offset = joinYear - 2026;
  if (!Number.isInteger(offset) || offset < 0 || offset >= PARTNER_BATCHES.length)
    throw new Error('入职年份不在当前批次编码范围内，请核对；不会自动循环使用批次');
  return makePartnerCode(PARTNER_BATCHES[offset], serial(assignedSequence, 999, '合伙人序号'));
}

export function employeeCode(assignedSequence: number) {
  return makeEntityCode('EMP', serial(assignedSequence, 9999, '员工序号'));
}

export function customerCode(partner: string, firstContactDate: string, assignedSequence: number) {
  if (!/^[A-HJ-NP-Z][0-9]{3}$/.test(partner) || partner.slice(1) === '000')
    throw new Error('合伙人编码无效，必须使用已分配的有效编码');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstContactDate))
    throw new Error('首次接触日期缺失或无效，请列入待核对清单，不得用今天代替');
  const [year, month, day] = firstContactDate.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > days[month - 1])
    throw new Error('首次接触日期不是有效日历日期，请核对原记录');
  return makeCustomerCode(partner, firstContactDate, serial(assignedSequence, 999, '当日新客户序号'));
}
