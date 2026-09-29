import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { HttpError } from '../domain.ts';
import { registerDocumentInTransaction } from '../document-registry.ts';

// User confirmed G-01 correction: complete 资料 may create/issue QT, then advance to 已报价.
export async function requireQuoteCustomer(db: pg.PoolClient, customerId: string) {
  const c=(await db.query(`SELECT c.id,c.company,c.biz_status,c.crm_customer_code,l.customer_id AS verified_identity
    FROM customers c LEFT JOIN crm_customer_code_ledger l ON l.customer_id=c.id AND l.code=c.crm_customer_code
    WHERE c.id=$1 AND c.deleted_at IS NULL FOR UPDATE OF c`,[customerId])).rows[0];
  if (!c) throw new HttpError(404,'客户不存在');
  if (!c.biz_status) throw new HttpError(409,'历史客户业务状态尚未核对，不会自动假定为资料阶段');
  if (['已发货','已安装'].includes(c.biz_status)) throw new HttpError(409,'客户已发货或已安装，不允许新建或签发QT');
  if (!c.company?.trim() || !c.verified_identity) throw new HttpError(422,'客户资料未齐全：请核实客户名称、首次开发人、首次开发日并完成客户编号登记');
  return c as {id:string; biz_status:string; crm_customer_code:string};
}
export async function issueCustomerQuote(db:pg.PoolClient,input:{customerId:string;quoteId:string;actorId:string;date:string;requestKey:string}) {
  const c=await requireQuoteCustomer(db,input.customerId);
  return registerDocumentInTransaction(db,{classCode:'QT',customerIds:[c.id],date:input.date,businessKind:'quotation_version',businessId:input.quoteId,requestKey:input.requestKey,actorId:input.actorId},async (tx,doc)=>{
    await tx.query("UPDATE quotation_versions SET status='issued',issued_at=now(),registered_document_id=$2,version=version+1 WHERE id=$1",[input.quoteId,doc.id]);
    if (c.biz_status==='资料') {
      await tx.query("UPDATE customers SET biz_status='已报价',version=version+1,updated_at=now() WHERE id=$1",[c.id]);
      await tx.query("INSERT INTO crm_customer_status_events(id,customer_id,from_status,to_status,trigger_document_id,actor_id) VALUES($1,$2,'资料','已报价',$3,$4)",[randomUUID(),c.id,doc.id,input.actorId]);
      await tx.query('INSERT INTO audit_logs(id,user_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)',[randomUUID(),input.actorId,'客户业务状态推进',c.id,JSON.stringify({before:'资料',after:'已报价',trigger_doc_no:doc.doc_no,quoteId:input.quoteId})]);
    }
  });
}
