import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {User} from '../../shared/contracts.ts';
import {HttpError,requireAdmin} from '../domain.ts';
import {registerDocumentInTransaction} from '../document-registry.ts';
import {orderEvidenceSchema,recordOrderEvidence,syncOrderMilestones} from '../supply/order-workflow.ts';
import type {QuoteRow} from './types.ts';

export async function receiveQuoteDeposit(db:pg.PoolClient, actor:User, input:{orderId:string;customerId:string;date:string;requestKey:string;raw:unknown}) {
 requireAdmin(actor);
 const receipt=orderEvidenceSchema.parse(input.raw);
 if(receipt.kind!=='deposit') throw new HttpError(400,'必须登记定金到账');
 if(Date.parse(receipt.receivedAt)>Date.now()) throw new HttpError(422,'到账时间不能在未来');
 const prior=(await db.query('SELECT d.id,r.doc_no FROM quotation_deposits d JOIN crm_document_registry r ON r.id=d.document_id WHERE quotation_order_id=$1',[input.orderId])).rows[0];
 if(prior) throw new HttpError(409,'该确认记录已登记定金，请查看原收款单，不能重复登记');
 const customer=(await db.query('SELECT biz_status FROM customers WHERE id=$1 FOR UPDATE',[input.customerId])).rows[0];
 if(!customer || !['已报价','已收定金','已量尺','生产中'].includes(customer.biz_status)) throw new HttpError(409,'客户业务状态不允许登记此定金');
 const receiptId=randomUUID();
 const doc=await registerDocumentInTransaction(db,{classCode:'AR',customerIds:[input.customerId],date:input.date,businessKind:'quotation_deposit',businessId:input.orderId,requestKey:input.requestKey,actorId:actor.id},async(tx,document)=>{
  await tx.query('INSERT INTO quotation_deposits(id,quotation_order_id,document_id,data,created_by) VALUES($1,$2,$3,$4,$5)',[receiptId,input.orderId,document.id,JSON.stringify(receipt),actor.id]);
  if(customer.biz_status==='已报价') {
   await tx.query("UPDATE customers SET biz_status='已收定金',updated_at=now(),version=version+1 WHERE id=$1",[input.customerId]);
   await tx.query("INSERT INTO crm_customer_status_events(id,customer_id,from_status,to_status,trigger_document_id,actor_id) VALUES($1,$2,'已报价','已收定金',$3,$4)",[randomUUID(),input.customerId,document.id,actor.id]);
  }
  await tx.query('INSERT INTO audit_logs(id,user_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)',[randomUUID(),actor.id,'登记报价定金到账',input.customerId,JSON.stringify({before:customer.biz_status,after:customer.biz_status==='已报价'?'已收定金':customer.biz_status,trigger_doc_no:document.doc_no,quotationOrderId:input.orderId})]);
 });
 return {id:receiptId,docNo:doc.doc_no};
}
export async function openPaidSalesOrder(db:pg.PoolClient, actor:User, input:{orderId:string;customerId:string;date:string;requestKey:string;quote:QuoteRow}) {
 requireAdmin(actor);
 const existing=(await db.query('SELECT id,order_number FROM sales_orders WHERE quotation_order_id=$1',[input.orderId])).rows[0];
 if(existing) return existing;
 const deposit=(await db.query('SELECT * FROM quotation_deposits WHERE quotation_order_id=$1',[input.orderId])).rows[0];
 if(!deposit) throw new HttpError(409,'未登记定金到账，禁止开立SO；客户确认不等于付款');
 const c=(await db.query('SELECT biz_status FROM customers WHERE id=$1 FOR UPDATE',[input.customerId])).rows[0];
 if(!c || !['已收定金','已量尺','生产中'].includes(c.biz_status)) throw new HttpError(409,'当前客户状态不允许开立SO');
 const soId=randomUUID();
 const doc=await registerDocumentInTransaction(db,{classCode:'SO',customerIds:[input.customerId],date:input.date,businessKind:'sales_order',businessId:input.orderId,requestKey:input.requestKey,actorId:actor.id},async(tx,document)=>{
  await tx.query('INSERT INTO sales_orders(id,quotation_order_id,order_number,registered_document_id,created_by) VALUES($1,$2,$3,$4,$5)',[soId,input.orderId,document.doc_no,document.id,actor.id]);
  for(const line of input.quote.input.lines) await tx.query('INSERT INTO sales_order_items(id,sales_order_id,line_key,configuration_snapshot,quantity) VALUES($1,$2,$3,$4,$5)',[randomUUID(),soId,line.key,JSON.stringify(line),line.quantity]);
  await syncOrderMilestones(tx,soId,actor);
  await recordOrderEvidence(tx,actor,soId,deposit.data);
  await tx.query("INSERT INTO quotation_reviews(id,quote_id,discipline) VALUES($1,$2,'production') ON CONFLICT(quote_id,discipline) DO NOTHING",[randomUUID(),input.quote.id]);
 });
 return {id:soId,order_number:doc.doc_no};
}
