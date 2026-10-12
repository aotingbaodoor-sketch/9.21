import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import {transaction} from '../db.ts';
import {day,addDays,nextRun} from '../pricing/sync.ts';
export const expiryConfig=z.object({time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),timezone:z.literal('Asia/Shanghai'),warningDays:z.number().int().min(0).max(90)});
export function createLogisticsExpiryWorker(pool:pg.Pool){
 let busy=false;
 return {async tick(now=new Date()){
  if(busy)return;busy=true;
  try{await transaction(pool,async db=>{
   if(!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('logistics-expiry')) locked")).rows[0].locked)return;
   const r=(await db.query("SELECT * FROM automation_rule WHERE code='logistics_expiry' FOR UPDATE")).rows[0];
   if(!r)return;
   await db.query("UPDATE automation_rule SET last_heartbeat=$1 WHERE code='logistics_expiry'",[now]);
   if((!r.enabled&&!r.requested_by)||new Date(r.next_run)>now)return;
   const config=expiryConfig.parse(r.config),today=day(now),cutoff=addDays(today,config.warningDays);
   const data=(await db.query(`SELECT 'rate' entity,id,version,data->>'name' name,data->>'validUntil' valid_until FROM logistics_cost_rates WHERE is_current
    UNION ALL SELECT 'product',id,version,sku,data->>'priceValidUntil' FROM quotation_products WHERE (data->>'active')::boolean
    UNION ALL SELECT 'freight',id,version,data->>'name',data->>'validUntil' FROM quotation_freight WHERE (data->>'active')::boolean
    UNION ALL SELECT 'material',id,version,data->>'name',data->>'validUntil' FROM logistics_materials WHERE is_current`)).rows;
   await db.query('UPDATE logistics_expiry_alerts SET resolved_at=$1 WHERE resolved_at IS NULL',[now]);
   let count=0;
   for(const row of data){
    if(row.valid_until&&row.valid_until>cutoff)continue;
    const state=!row.valid_until?'missing':row.valid_until<today?'expired':'due';
    await db.query(`INSERT INTO logistics_expiry_alerts(id,entity,entity_id,version,state,name,valid_until,checked_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(entity,entity_id,version,state) DO UPDATE SET checked_at=excluded.checked_at,resolved_at=NULL`,
     [randomUUID(),row.entity,row.id,row.version,state,row.name,row.valid_until||null,now]);count++;
   }
   await db.query("INSERT INTO logistics_expiry_runs(id,started_at,finished_at,status,alert_count) VALUES($1,$2,$3,'success',$4)",[randomUUID(),now,new Date(),count]);
   await db.query("UPDATE automation_rule SET next_run=$1,last_success=$2,last_error=NULL,requested_by=NULL WHERE code='logistics_expiry'",[nextRun([config.time],now),now]);
  });}catch(error){
   // Keep previous alerts and source prices on failure; retry on the server in 15 minutes.
   const code=(error as {code?:string}).code;
   const failure=error instanceof z.ZodError?'到期任务配置格式无效':code&&/^[A-Z0-9_]{2,30}$/.test(code)?`到期任务数据库错误（${code}）`:'到期任务运行失败，需管理员检查服务器状态';
   await transaction(pool,async db=>{
    await db.query("INSERT INTO logistics_expiry_runs(id,started_at,finished_at,status,error) VALUES($1,$2,$3,'failed',$4)",[randomUUID(),now,new Date(),failure+'；旧提醒及原价格保留，15分钟后重试']);
    await db.query("UPDATE automation_rule SET next_run=$1,last_error=$2 WHERE code='logistics_expiry'",[new Date(now.getTime()+900000),failure+'；已保留原数据，等待重试']);
   });
  }finally{busy=false;}
 }};
}
