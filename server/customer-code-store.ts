import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { customerCode, partnerCode } from './customer-codes.ts';
import { HttpError } from './domain.ts';

// Called only by trusted server workflows after permission and source-data checks.
// Outer business transaction owns commit/rollback; no HTTP or external work here.
export async function allocatePartner(db: Db, input: { userId: string; joinYear: number; name: string; market: string }) {
  partnerCode(input.joinYear,1);
  return (await db.query('SELECT * FROM crm_allocate_partner($1,$2,$3,$4,$5)',
    [randomUUID(),input.userId,input.joinYear,input.name,input.market])).rows[0] as {
      id: string; user_id: string; partner_code: string; join_year: number;
    };
}
export async function allocateCustomerCode(db: Db, input: {
  customerId: string; partnerId: string; firstContactDate: string;
  source: 'new' | 'legacy_verified' | 'whatsapp_verified';
}) {
  // Validate calendar date without silently replacing missing legacy dates.
  customerCode('A001',input.firstContactDate,1);
  try {
    return (await db.query('SELECT crm_allocate_customer_code($1,$2,$3::date,$4) AS code',
      [input.customerId,input.partnerId,input.firstContactDate,input.source])).rows[0].code as string;
  } catch (error) {
    if ((error as { code?: string }).code === 'P0001') throw new HttpError(409,(error as Error).message);
    throw error;
  }
}
