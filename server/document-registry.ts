import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction, type Db } from './db.ts';
import { makeDocumentCode, type DocumentClass } from './coding-contract.ts';
import { HttpError } from './domain.ts';

type Input = { classCode: string; customerIds: string[]; date: string; businessKind: string; businessId: string; requestKey: string; actorId: string };
/** Internal service only. Caller must authorize the business action before allocation.
 * The callback inserts the real business document in the SAME transaction; retries never invoke it twice.
 */
export async function registerDocument(pool: pg.Pool, input: Input, persist: (db: pg.PoolClient, document: {id:string; doc_no:string})=>Promise<void>) {
  const customers = [...new Set(input.customerIds)].sort();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new HttpError(400,'单据业务日必须为 YYYY-MM-DD');
  const fingerprint = createHash('sha256').update(JSON.stringify([input.classCode,customers,input.date,input.businessKind,input.businessId,input.actorId])).digest('hex');
  return transaction(pool,async db => {
    // Fixed lock order serializes both request replay and duplicate business identity.
    const locks = [`doc-request:${input.requestKey}`,`doc-business:${input.classCode}:${input.businessKind}:${input.businessId}`].sort();
    for (const lock of locks) await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
    const previous = await db.query('SELECT * FROM crm_document_registry WHERE request_key=$1 OR (class_code=$2 AND business_kind=$3 AND business_id=$4)',[input.requestKey,input.classCode,input.businessKind,input.businessId]);
    if (previous.rowCount) {
      if (previous.rows.length !== 1 || previous.rows[0].request_hash !== fingerprint) throw new HttpError(409,'重复请求内容不一致，未创建新单据');
      return previous.rows[0] as {id:string; doc_no:string};
    }
    const classes = (await db.query('SELECT code,family,enabled FROM crm_document_class FOR SHARE')).rows as DocumentClass[];
    const config = classes.find(c=>c.code===input.classCode && c.enabled);
    if (!config) throw new HttpError(409,'单据类型未启用');
    if ((config.family==='A' || input.classCode==='AR') && customers.length!==1) throw new HttpError(400,'该类单据必须关联一个客户');
    const rows = (await db.query('SELECT id,crm_customer_code FROM customers WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id FOR SHARE',[customers])).rows;
    if (rows.length!==customers.length) throw new HttpError(400,'关联客户不存在或已停用');
    const scope = config.family==='A' ? `customer:${customers[0]}:${config.code}` : `company:${input.date}:${config.code}`;
    const maximum = config.family==='A' ? 999 : 9999;
    const counter = await db.query(`INSERT INTO crm_document_sequence(scope_key,last_value) VALUES($1,1)
      ON CONFLICT(scope_key) DO UPDATE SET last_value=crm_document_sequence.last_value+1
      WHERE crm_document_sequence.last_value<$2 RETURNING last_value`,[scope,maximum]);
    if (!counter.rowCount) throw new HttpError(409,'该编号范围已满，禁止复用或扩位');
    const n = counter.rows[0].last_value;
    const docNo = makeDocumentCode(config.code,{seq:n,issue_date:input.date,...(config.family==='A'?{customer_code:rows[0].crm_customer_code}:{})},classes);
    const id = randomUUID();
    await db.query(`INSERT INTO crm_document_registry(id,doc_no,class_code,family,customer_id,doc_date,sequence_value,scope_key,business_kind,business_id,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,docNo,config.code,config.family,customers.length===1?customers[0]:null,input.date,n,scope,input.businessKind,input.businessId,input.requestKey,fingerprint,input.actorId]);
    for(const customer of customers) await db.query('INSERT INTO crm_document_customer_link(document_id,customer_id) VALUES($1,$2)',[id,customer]);
    await persist(db,{id,doc_no:docNo});
    await db.query('INSERT INTO audit_logs(id,user_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)',[randomUUID(),input.actorId,'document.number.issued',id,JSON.stringify({docNo,classCode:config.code,businessId:input.businessId})]);
    return {id,doc_no:docNo};
  });
}
/** Deliberately no process cache: updates apply on the next business request. */
export async function runtimeConfig(db: Db) {
  return Object.fromEntries((await db.query('SELECT key,value FROM crm_runtime_config')).rows.map(r=>[r.key,r.value])) as Record<string,number|string>;
}
