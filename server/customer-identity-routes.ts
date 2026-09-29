import type {Express,Request,Response} from 'express';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {dateSchema} from '../shared/contracts.ts';
import {requireAdmin,HttpError,businessDay} from './domain.ts';
import {allocateCustomerCode} from './customer-code-store.ts';
import * as repo from './repository.ts';
type Mutate=(req:Request,res:Response,run:(db:pg.PoolClient)=>Promise<unknown>)=>Promise<void>;
export function registerCustomerIdentity(app:Express,pool:pg.Pool,mutate:Mutate){
 app.get('/api/customer-identities/sources',async(req,res)=>{
  if(!['admin','sales'].includes(req.actor.role))throw new HttpError(403,'无客户建档权限');
  res.json((await pool.query('SELECT id,partner_code,name FROM crm_partners WHERE active ORDER BY partner_code')).rows);
 });
 app.post('/api/customer-identities/sources/initialize',async(req,res)=>mutate(req,res,async db=>{
  requireAdmin(req.actor);await db.query('SELECT pg_advisory_xact_lock(825116)');
  const names=['潘总','小咪','李总','郝小妹','君君','小蔡'];
  for(const [index,name] of names.entries()){
   const code='A'+String(index+1).padStart(3,'0');
   const prior=(await db.query('SELECT name FROM crm_partners WHERE partner_code=$1',[code])).rows[0];
   if(prior&&prior.name!==name)throw new HttpError(409,`${code}已有不同身份，需人工核实，未覆盖`);
   if(!prior)await db.query('INSERT INTO crm_partners(id,user_id,partner_code,join_year,assigned_sequence,name) VALUES($1,NULL,$2,2026,$3,$4)',[randomUUID(),code,index+1,name]);
  }
  await db.query('INSERT INTO crm_partner_counters(join_year,last_value) VALUES(2026,6) ON CONFLICT(join_year) DO UPDATE SET last_value=greatest(crm_partner_counters.last_value,6)');
  await repo.audit(db,req.actor,'按交付包登记来源人','partner-sources',{codes:['A001','A002','A003','A004','A005','A006'],employeeAccountsCreated:0});return {ok:true};
 }));
 app.get('/api/customers/:id/identity',async(req,res)=>{
  const customer=await repo.customer(pool,req.actor,z.uuid().parse(req.params.id));
  const identity=(await pool.query('SELECT l.code,l.partner_id,l.contact_date,p.name,p.partner_code FROM crm_customer_code_ledger l JOIN crm_partners p ON p.id=l.partner_id WHERE customer_id=$1',[customer.id])).rows[0]||null;
  res.json({identity,status:customer.biz_status});
 });
 app.post('/api/customers/:id/identity',async(req,res)=>mutate(req,res,async db=>{
  const input=z.object({partnerId:z.uuid(),firstContactDate:dateSchema,confirmHistoricalInfoOnly:z.boolean().default(false)}).strict().parse(req.body);
  const id=z.uuid().parse(req.params.id);await repo.customer(db,req.actor,id);
  if(!['admin','sales'].includes(req.actor.role))throw new HttpError(403,'无客户建档权限');
  const c=(await db.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const old=(await db.query('SELECT * FROM crm_customer_code_ledger WHERE customer_id=$1',[id])).rows[0];
  if(old){if(old.partner_id!==input.partnerId||old.contact_date!==input.firstContactDate)throw new HttpError(409,'首次开发人与日期已固定，不可修改');return {code:old.code};}
  if(!c.company.trim())throw new HttpError(422,'先填写已核实的客户名称，未知资料不得猜测');
  if(input.firstContactDate>businessDay((await repo.settings(db)).timezone))throw new HttpError(422,'首次开发日不能在未来');
  if(!c.biz_status){
   requireAdmin(req.actor);
   if(!input.confirmHistoricalInfoOnly)throw new HttpError(409,'须管理员核实历史客户仍处于资料阶段；其他阶段暂不自动转换');
   if((await db.query("SELECT 1 FROM quotation_projects p JOIN quotation_versions v ON v.project_id=p.id WHERE p.customer_id=$1 AND v.status IN ('issued','confirmed') LIMIT 1",[id])).rowCount||c.stage!=='新询盘')throw new HttpError(409,'历史客户已有后续业务记录或非新询盘，需专项核对，不允许重置为资料');
   await db.query("UPDATE customers SET biz_status='资料',version=version+1,updated_at=now() WHERE id=$1",[id]);
  }
  const code=await allocateCustomerCode(db,{customerId:id,partnerId:input.partnerId,firstContactDate:input.firstContactDate,source:c.biz_status?'new':'legacy_verified'});
  await repo.audit(db,req.actor,'核实首次开发资料并永久发号',id,{code,partnerId:input.partnerId,firstContactDate:input.firstContactDate,historicalInfoConfirmed:!c.biz_status});return {code};
 }));
}
