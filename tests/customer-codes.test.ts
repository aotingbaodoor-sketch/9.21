import assert from 'node:assert/strict';
import test from 'node:test';
import { customerCode, employeeCode, partnerCode } from '../server/customer-codes.ts';

test('specified 13-character customer code, independent from ordering or owner', () => {
  assert.equal(customerCode('A001', '2026-09-22', 1), 'A001260922001');
  assert.match(customerCode('B999', '2027-12-31', 999), /^[A-Z0-9]{13}$/);
});
test('partner batches skip I and O and never cycle', () => {
  assert.equal(partnerCode(2026,1), 'A001');
  assert.equal(partnerCode(2027,1), 'B001');
  assert.equal(partnerCode(2034,1), 'J001');
  assert.equal(partnerCode(2039,1), 'P001');
  assert.throws(() => partnerCode(2025,1));
  assert.throws(() => partnerCode(2050,1));
  assert.throws(() => partnerCode(2026,1000));
});
test('employee codes and exhausted sequences fail explicitly', () => {
  assert.equal(employeeCode(1), 'EMP0001');
  assert.equal(employeeCode(9999), 'EMP9999');
  for(const value of [0,-1,1.5,10000,NaN]) assert.throws(()=>employeeCode(value));
  for(const value of [0,-1,1.5,1000,NaN]) assert.throws(()=>customerCode('A001','2026-09-22',value));
});
test('missing and impossible historical dates are not invented', () => {
  for(const date of ['', '2026-02-29', '2026-04-31', '2026-00-01', '2026-13-01','2026-09-00','2026-9-22'])
    assert.throws(()=>customerCode('A001',date,1));
  assert.equal(customerCode('A001','2024-02-29',1),'A001240229001');
  assert.throws(()=>customerCode('I001','2026-09-22',1));
  assert.throws(()=>customerCode('A000','2026-09-22',1));
});
