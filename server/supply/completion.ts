import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { Db } from '../db.ts';
import type { User } from '../../shared/contracts.ts';
import { HttpError, businessDay } from '../domain.ts';
import * as repo from '../repository.ts';
import { registerDocumentInTransaction } from '../document-registry.ts';
import { workOrder, validProjectFile, event } from './chain.ts';
import { financialActor, settlement } from './settlement.ts';

type Mutate = (req:Request,res:Response,run:(db:pg.PoolClient)=>Promise<unknown>)=>Promise<void>;
const uid=z.uuid(), text=z.string().trim().min(2).max(2000);
const day=z.iso.date();
async function actualDay(db:Db,value:string,earliest?:string){
 if(value>businessDay((await repo.settings(db)).timezone)||(earliest&&value<earliest)) throw new HttpError(422,'实际日期不能在未来或早于签收/到港日期');
}
async function openCases(db:Db,id:string){return (await db.query(`SELECT a.id FROM crm_after_sales_cases a LEFT JOIN crm_after_sales_resolutions r ON r.case_id=a.id WHERE a.work_order_id=$1 AND r.case_id IS NULL`,[id])).rows;}
async function requireStage(w:any,stage:string){if(w.current_stage!==stage)throw new HttpError(409,`当前为${w.current_stage}，须先完成${stage}，不能跳级`);}
async function createCase(db:pg.PoolClient,actor:User,w:any,i:{category:string;description:string;fileId:string;responsibleParty:string},key:string){
 const id=randomUUID();
 const doc=await registerDocumentInTransaction(db,{classCode:'AS',customerIds:[w.customer_id],date:businessDay((await repo.settings(db)).timezone),businessKind:'after_sales',businessId:id,requestKey:key,actorId:actor.id},async(tx,d)=>{
  await tx.query('INSERT INTO crm_after_sales_cases(id,document_id,work_order_id,category,description,file_id,responsible_party,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,d.id,w.id,i.category,i.description,i.fileId,i.responsibleParty,actor.id]);
 });
 await repo.audit(db,actor,'登记关联工单的售后事项',id,{workOrderId:w.id,docNo:doc.doc_no});
 return {id,docNo:doc.doc_no};
}
export async function completionView(db:Db,actor:User,w:any){
 const [delivery,acceptance,cases,warranty,visits,conf,closed,policy,pendingIssues,approvers]=await Promise.all([
  db.query('SELECT * FROM crm_delivery_acceptance WHERE work_order_id=$1',[w.id]),
  db.query('SELECT * FROM crm_acceptance_records WHERE work_order_id=$1 ORDER BY created_at',[w.id]),
  db.query(`SELECT a.*,d.doc_no,r.action,r.followup,r.confirmed_at FROM crm_after_sales_cases a JOIN crm_document_registry d ON d.id=a.document_id LEFT JOIN crm_after_sales_resolutions r ON r.case_id=a.id WHERE a.work_order_id=$1 ORDER BY a.created_at`,[w.id]),
  db.query('SELECT * FROM crm_warranty_anchors WHERE work_order_id=$1',[w.id]),
  db.query('SELECT * FROM crm_delivery_visits WHERE work_order_id=$1 ORDER BY visited_on DESC',[w.id]),
  db.query(`SELECT c.*,NOT EXISTS(SELECT 1 FROM crm_after_sales_cases a LEFT JOIN crm_after_sales_resolutions r ON r.case_id=a.id WHERE a.work_order_id=c.work_order_id AND (a.created_at>c.confirmed_at OR r.confirmed_at>c.confirmed_at)) AS current_case_scope FROM crm_order_close_confirmations c WHERE work_order_id=$1 ORDER BY confirmed_at DESC`,[w.id]),
  db.query('SELECT * FROM crm_work_order_close WHERE work_order_id=$1',[w.id]),
  db.query('SELECT tax_rebate_enabled FROM crm_fulfillment_policy WHERE id=1'),
  db.query(`SELECT ((SELECT count(*) FROM production_issues i JOIN purchase_orders p ON p.id=i.purchase_order_id WHERE p.work_order_id=$1 AND i.status IN ('open','mitigating'))+(SELECT count(*) FROM rework_tasks r JOIN purchase_orders p ON p.id=r.purchase_order_id WHERE p.work_order_id=$1 AND r.status<>'closed'))::int n`,[w.id]),
  db.query('SELECT finance_user_id,cs_user_id,scm_user_id FROM crm_fulfillment_approvers WHERE id=1'),
 ]);
 const blockers:{reason:string;href:string}[]=[], href=`/supply/chain/${w.id}`, s=await settlement(db,w.id);
 const block=(reason:string,hash='completion')=>blockers.push({reason,href:href+'#'+hash});
 if(!delivery.rows[0])block('缺客户实际签收日期及已核对的POD','logistics');
 if(!s.settled)block('尾款未全额到账','settlement');
 if(!warranty.rows[0])block('验收及质保起算尚未完成');
 const unresolved=cases.rows.filter(c=>!c.confirmed_at);
 if(unresolved.length)block(`有${unresolved.length}项未结售后/投诉`,'aftersales');
 if(pendingIssues.rows[0].n)block(`有${pendingIssues.rows[0].n}项生产异常未结`,'purchases');
 // A CS sign-off cannot cover complaints submitted after it was signed.
 for(const [kind,name] of [['finance','财务尾款核验'],['cs','客户关系组无未结投诉确认'],['scm','供应链负责人签字']] as const){
  const c=conf.rows.find(c=>c.kind===kind);
  if(!c||c.confirmed_by!==approvers.rows[0]?.[kind+'_user_id']||(kind==='cs'&&!c.current_case_scope))block(`缺有效${name}`,'close-confirmations');
 }
 const rights=approvers.rows[0];
 return {delivery:delivery.rows[0]??null,acceptance:acceptance.rows,cases:cases.rows,
  warranty:warranty.rows[0]?{from:warranty.rows[0].warranty_from,...(actor.role==='admin'?{supplierSnapshot:warranty.rows[0].supplier_snapshot}:{})}:null,
  visits:visits.rows,confirmations:conf.rows,closed:closed.rows[0]??null,taxEnabled:policy.rows[0]?.tax_rebate_enabled===true,blockers,
  canConfirm:Object.fromEntries(['finance','cs','scm'].map(k=>[k,actor.role==='admin'&&rights?.[k+'_user_id']===actor.id])),
  missingDuties:['finance','cs','scm'].filter(k=>!rights?.[k+'_user_id'])};
}
export function registerCompletion(app:Express,pool:pg.Pool,mutate:Mutate){
 const base='/api/supply/chain/:id';
 app.get(base+'/completion',async(req,res)=>{const w=await workOrder(pool,req.actor,uid.parse(req.params.id));res.json(await completionView(pool,req.actor,w));});
 app.post(base+'/delivery',async(req,res)=>mutate(req,res,async db=>{
  const w=await workOrder(db,req.actor,uid.parse(req.params.id),true);
  const i=z.object({podDocumentId:uid,deliveredOn:day,signedBy:text,packageCondition:z.enum(['intact','damaged']),damageFileId:uid.nullable().default(null),arrivalOn:day,containerNo:text}).strict().parse(req.body);
  await requireStage(w,'balance_settled');await actualDay(db,i.arrivalOn);await actualDay(db,i.deliveredOn,i.arrivalOn);
  const pod=(await db.query("SELECT * FROM crm_logistics_documents WHERE id=$1 AND work_order_id=$2 AND doc_type='pod' AND check_result='matched'",[i.podDocumentId,w.id])).rows[0];
  if(!pod)throw new HttpError(409,'G-16：请先在物流回传台账上传并核对本工单POD');
  const bl=(await db.query("SELECT external_no FROM crm_logistics_documents WHERE work_order_id=$1 AND doc_type='bl_copy' AND check_result='matched' AND external_no<>'' ORDER BY created_at DESC LIMIT 1",[w.id])).rows[0];
  if(!bl)throw new HttpError(409,'缺已核对的提单副本及提单号');
  if(i.packageCondition==='damaged'&&!i.damageFileId)throw new HttpError(422,'包装破损必须上传照片/书面凭证并登记售后');
  if(i.damageFileId)await validProjectFile(db,i.damageFileId,w.project_id);
  await db.query(`INSERT INTO crm_delivery_acceptance(work_order_id,pod_document_id,delivered_on,signed_by,package_condition,damage_file_id,arrival_on,container_no,bl_no,objection_deadline,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$3::date+7,$10)`,[w.id,pod.id,i.deliveredOn,i.signedBy,i.packageCondition,i.damageFileId,i.arrivalOn,i.containerNo,bl.external_no,req.actor.id]);
  if(i.packageCondition==='damaged')await createCase(db,req.actor,w,{category:'运输破损',description:'签收时发现外包装破损，待核对责任和处理',fileId:i.damageFileId!,responsibleParty:'待核实'},uid.parse(req.get('idempotency-key')));
  await event(db,w,req.actor,'delivered',{podDocumentId:pod.id,deliveredOn:i.deliveredOn});return {id:w.id};
 }));
 app.post(base+'/acceptance',async(req,res)=>mutate(req,res,async db=>{
  const w=await workOrder(db,req.actor,uid.parse(req.params.id),true);await requireStage(w,'delivered');
  const i=z.object({result:z.enum(['accepted','objection']),occurredOn:day,note:text,fileId:uid}).strict().parse(req.body);
  const d=(await db.query('SELECT delivered_on FROM crm_delivery_acceptance WHERE work_order_id=$1',[w.id])).rows[0];
  await actualDay(db,i.occurredOn,d.delivered_on);await validProjectFile(db,i.fileId,w.project_id);
  if(i.result==='accepted'&&(await openCases(db,w.id)).length)throw new HttpError(409,'存在未结售后/异议，请在下方售后入口处理后再确认合格');
  const id=randomUUID();await db.query('INSERT INTO crm_acceptance_records(id,work_order_id,result,occurred_on,note,file_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,w.id,i.result,i.occurredOn,i.note,i.fileId,req.actor.id]);
  if(i.result==='objection')await createCase(db,req.actor,w,{category:'验收异议',description:i.note,fileId:i.fileId,responsibleParty:'待核实'},uid.parse(req.get('idempotency-key')));
  else await event(db,w,req.actor,'accepted',{acceptanceId:id});
  await repo.audit(db,req.actor,'保存客户验收结论',w.id,{id,result:i.result});return {id};
 }));
 app.post(base+'/warranty',async(req,res)=>mutate(req,res,async db=>{
  const w=await workOrder(db,req.actor,uid.parse(req.params.id),true);await requireStage(w,'accepted');
  z.object({confirmDeliveryAnchor:z.literal(true)}).strict().parse(req.body);
  const d=(await db.query('SELECT delivered_on FROM crm_delivery_acceptance WHERE work_order_id=$1',[w.id])).rows[0];
  const source=(await db.query(`SELECT m.id,m.purchase_order_id,m.technical_snapshot->'supplierWarranty' terms FROM crm_manufacturing_orders m WHERE m.work_order_id=$1`,[w.id])).rows;
  if(!source.length||source.some(s=>!Array.isArray(s.terms)||!s.terms.length))throw new HttpError(409,'MO缺少供应商保质期快照，不能猜测期限');
  const snapshot=[];
  for(const m of source)for(const t of m.terms){
   if(!Number.isInteger(t.months||t.days)||(t.months||t.days)<=0)throw new HttpError(409,'MO保质期单位或期限无效，须核实');
   const until=(await db.query("SELECT ($1::date+make_interval(months=>$2,days=>$3))::date::text until",[d.delivered_on,t.months||0,t.days||0])).rows[0].until;
   snapshot.push({manufacturingId:m.id,purchaseOrderId:m.purchase_order_id,...t,from:d.delivered_on,until});
  }
  await db.query('INSERT INTO crm_warranty_anchors(work_order_id,warranty_from,supplier_snapshot,confirmed_by) VALUES($1,$2,$3,$4)',[w.id,d.delivered_on,JSON.stringify(snapshot),req.actor.id]);
  await event(db,w,req.actor,'warranty_started',{from:d.delivered_on,scope:'supplier_internal_only'});return {from:d.delivered_on};
 }));
 app.post(base+'/after-sales',async(req,res)=>mutate(req,res,async db=>{
  const w=await workOrder(db,req.actor,uid.parse(req.params.id),true);
  const i=z.object({category:text,description:text,fileId:uid,responsibleParty:text}).strict().parse(req.body);await validProjectFile(db,i.fileId,w.project_id);
  return createCase(db,req.actor,w,i,uid.parse(req.get('idempotency-key')));
 }));
 app.post(base+'/after-sales/:caseId/resolve',async(req,res)=>mutate(req,res,async db=>{
  const w=await workOrder(db,req.actor,uid.parse(req.params.id),true);
  const i=z.object({action:text,followup:text,fileId:uid}).strict().parse(req.body);await validProjectFile(db,i.fileId,w.project_id);
  const caseId=uid.parse(req.params.caseId);
  if(!(await db.query('SELECT 1 FROM crm_after_sales_cases WHERE id=$1 AND work_order_id=$2',[caseId,w.id])).rowCount)throw new HttpError(404,'售后事项不存在或未授权');
  if((await db.query('SELECT 1 FROM crm_after_sales_resolutions WHERE case_id=$1',[caseId])).rowCount)throw new HttpError(409,'已保存的处理依据不可覆盖');
  await db.query('INSERT INTO crm_after_sales_resolutions(case_id,action,followup,file_id,confirmed_by) VALUES($1,$2,$3,$4,$5)',[caseId,i.action,i.followup,i.fileId,req.actor.id]);
  await repo.audit(db,req.actor,'核实售后处理及客户回访',caseId,{workOrderId:w.id,fileId:i.fileId});return {id:caseId};
 }));
 app.post(base+'/visit',async(req,res)=>mutate(req,res,async db=>{
  const w=await workOrder(db,req.actor,uid.parse(req.params.id),true);
  const d=(await db.query('SELECT delivered_on FROM crm_delivery_acceptance WHERE work_order_id=$1',[w.id])).rows[0];if(!d)throw new HttpError(409,'签收后才能登记回访');
  const i=z.object({visitedOn:day,installationSupport:z.enum(['remote','onsite','not_needed']),result:text,fileId:uid}).strict().parse(req.body);
  await actualDay(db,i.visitedOn,d.delivered_on);await validProjectFile(db,i.fileId,w.project_id);
  const id=randomUUID();await db.query('INSERT INTO crm_delivery_visits(id,work_order_id,visited_on,installation_support,result,file_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,w.id,i.visitedOn,i.installationSupport,i.result,i.fileId,req.actor.id]);
  await repo.audit(db,req.actor,'保存安装指导与回访',w.id,{visitId:id});return {id};
 }));
 app.post(base+'/close-confirmation',async(req,res)=>mutate(req,res,async db=>{
  const w=await workOrder(db,req.actor,uid.parse(req.params.id),true);await requireStage(w,'warranty_started');
  const i=z.object({kind:z.enum(['finance','cs','scm']),fileId:uid,note:text}).strict().parse(req.body);
  await financialActor(db,req.actor,i.kind);await validProjectFile(db,i.fileId,w.project_id);
  if(i.kind==='finance'&&!(await settlement(db,w.id)).settled)throw new HttpError(409,'未结清不能确认');
  if(i.kind==='cs'&&(await openCases(db,w.id)).length)throw new HttpError(409,'存在未结投诉/售后，不能确认');
  const id=randomUUID();await db.query('INSERT INTO crm_order_close_confirmations(id,work_order_id,kind,file_id,note,confirmed_by) VALUES($1,$2,$3,$4,$5,$6)',[id,w.id,i.kind,i.fileId,i.note,req.actor.id]);
  await repo.audit(db,req.actor,'工单关闭职责签认',w.id,{kind:i.kind,confirmationId:id});return {id};
 }));
 app.post(base+'/close',async(req,res)=>mutate(req,res,async db=>{
  const w=await workOrder(db,req.actor,uid.parse(req.params.id),true);await requireStage(w,'warranty_started');await financialActor(db,req.actor,'scm');
  const i=z.object({taxDocsFileId:uid.nullable().default(null)}).strict().parse(req.body);
  const v=await completionView(db,req.actor,w);if(v.blockers.length)throw new HttpError(409,v.blockers.map(b=>b.reason).join('；'));
  if(v.taxEnabled&&!i.taxDocsFileId)throw new HttpError(409,'退税已启用，缺移交财务的单证凭证');
  if(v.taxEnabled)await validProjectFile(db,i.taxDocsFileId!,w.project_id);
  const snapshot={delivered:v.delivery.delivered_on,pod:v.delivery.pod_document_id,settlement:{...(await settlement(db,w.id)),receipts:undefined},noOpenCases:true,confirmations:v.confirmations,taxEnabled:v.taxEnabled};
  await db.query('INSERT INTO crm_work_order_close(work_order_id,conditions_snapshot,tax_docs_file_id,tax_na_reason,closed_by) VALUES($1,$2,$3,$4,$5)',[w.id,JSON.stringify(snapshot),v.taxEnabled?i.taxDocsFileId:null,v.taxEnabled?null:'配置未启用出口退税，条件④不适用',req.actor.id]);
  await event(db,w,req.actor,'closed',{conditions:'four_verified',taxApplicable:v.taxEnabled});return {id:w.id};
 }));
}
