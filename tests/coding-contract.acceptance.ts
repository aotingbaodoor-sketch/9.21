import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as codes from '../server/coding-contract.ts';

type Step = {id?: string; op: string; args: unknown[]; kwargs?: Record<string,unknown>; expect?: unknown; steps?: Step[]};
const file = process.argv[2];
if (!file) throw new Error('Provide the unchanged delivery-package test JSON path');
const vectors = JSON.parse(readFileSync(file,'utf8')) as Record<string,Step[]>;
function execute(step: Step) {
  const [a,b,c] = step.args;
  switch(step.op) {
    case 'make_partner_code': return codes.makePartnerCode(a,b);
    case 'make_customer_code': return codes.makeCustomerCode(a,b,c);
    case 'make_document_code': return codes.makeDocumentCode(a,step.kwargs ?? {},codes.CONTRACT_CLASSES);
    case 'make_entity_code': return codes.makeEntityCode(a,b);
    case 'is_customer_code': return codes.isCustomerCode(a);
    case 'is_document_code': return codes.isDocumentCode(a,codes.CONTRACT_CLASSES);
    case 'is_entity_code': return codes.isEntityCode(a);
    default: throw new Error(`Unsupported original operation: ${step.op}`);
  }
}
let passed = 0, failed = 0;
for (const group of ['valid','invalid','checks','sequences']) {
  for (const entry of vectors[group]) {
    try {
      if (group === 'invalid') assert.throws(() => execute(entry),codes.CodingError);
      else for (const step of entry.steps ?? [entry]) assert.deepEqual(execute(step),step.expect);
      passed++;
    } catch(error) { failed++; console.error(`${group}/${entry.id}: ${(error as Error).message}`); }
  }
}
console.log(JSON.stringify({implementation:'server/coding-contract.ts',passed,failed,total:passed+failed}));
if (passed+failed !== 155 || failed) process.exitCode = 1;
