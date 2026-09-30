import {createHash,randomUUID} from 'node:crypto';
import {Decimal} from 'decimal.js';
import type pg from 'pg';
import type {Db} from '../db.ts';
import {transaction} from '../db.ts';
import {pricingConfigSchema,type PricingConfig} from '../../shared/pricing.ts';
import type {QuotationSettings} from '../../shared/quoting.ts';
export const ECB_URL='https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export const day=(d=new Date())=>new Date(d.getTime()+8*3600000).toISOString().slice(0,10);
export const addDays=(s:string,n:number)=>new Date(Date.parse(s+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function nextRun(times:string[],now=new Date()) {
 const today=day(now);const candidates=[0,1].flatMap(n=>times.map(t=>new Date(`${addDays(today,n)}T${t}:00+08:00`))).filter(d=>d>now);
 return new Date(Math.min(...candidates.map(d=>d.getTime())));
}
// ECB quotes currency units per 1 EUR, never per 100 foreign units.
export function parseEcb(xml:string,now=new Date()) {
 if(xml.length>200000||/<!DOCTYPE|<!ENTITY/i.test(xml)||!xml.includes('www.ecb.int/vocabulary/2002-08-01/eurofxref'))throw new Error('来源格式不符');
 const dates=[...xml.matchAll(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/g)];
 if(dates.length!==1)throw new Error('来源日期缺失或不唯一');
 const date=dates[0][1];if(!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>day(now))throw new Error('来源日期无效');
 const rates:Record<string,string>={EUR:'1'};
 for(const m of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g)) {
  if(rates[m[1]]||!new Decimal(m[2]).isPositive()||!new Decimal(m[2]).isFinite())throw new Error('来源汇率无效或重复');rates[m[1]]=m[2];
 }
 if(!rates.CNY||!rates.USD||Object.keys(rates).length<20)throw new Error('来源币种不完整');
 const cnyRates=Object.fromEntries(Object.entries(rates).map(([currency,rate])=>[currency,new Decimal(rates.CNY).div(rate).toDecimalPlaces(10).toNumber()]));
 if(Object.values(cnyRates).some(rate=>!Number.isFinite(rate)||rate<=0||rate>1e6))throw new Error('来源换算结果超出合理数值范围');
 return {date,rates,cnyRates,sha:createHash('sha256').update(JSON.stringify({date,rates})).digest('hex')};
}
export async function pricingState(db:Db) {
 const row=(await db.query('SELECT * FROM pricing_sync_config WHERE id=1')).rows[0];
  return {...row,data:pricingConfigSchema.parse(row.data)} as {version:number;data:PricingConfig;next_run:Date;last_checked:Date|null;last_success:Date|null;last_error:string|null;lease_token:string|null;lease_until:Date|null;requested_by:string|null;last_heartbeat:Date|null};
}
export async function effectiveSettings(db:Db,settings:QuotationSettings) {
 const state=await pricingState(db),batch=(await db.query('SELECT id,source_date::text,cny_rates,first_synced_at FROM pricing_fx_batches ORDER BY source_date DESC,first_synced_at DESC LIMIT 1')).rows[0];
 const result=structuredClone(settings);
 if(state.data.mode==='ecb_reference') for(const currency of state.data.currencies) {
  // Explicit adoption replaces ONLY selected currencies. Missing source must not fall back silently.
  delete result.fx[currency];
  if(batch?.cny_rates[currency]&&currency!=='CNY')result.fx[currency]={cnyPerUnit:batch.cny_rates[currency],date:batch.source_date,validUntil:addDays(batch.source_date,state.data.referenceDays),source:`ECB参考汇率（非银行买卖价） ${ECB_URL} #${batch.id}`,bufferPct:state.data.bufferPct};
 }
 return {settings:result,state,batch};
}
export function createPricingWorker(pool:pg.Pool,fetcher:typeof fetch=fetch) {
 let busy=false;
 async function tick(now=new Date()) {
  if(busy)return;busy=true;
  let token:string|undefined,runId:string|undefined;
  try {
   // Short durable lease; fetch is outside the transaction. Multiple replicas are safe.
   const claim=await transaction(pool,async db=>{
    await db.query('UPDATE pricing_sync_config SET last_heartbeat=$1 WHERE id=1',[now]);
    const s=await pricingState(db);
    if(!s.data.enabled&&!s.requested_by)return null;
    const t=randomUUID();
    const r=await db.query("UPDATE pricing_sync_config SET lease_token=$1,lease_until=$2,last_checked=$3 WHERE id=1 AND next_run<=$3 AND (lease_until IS NULL OR lease_until<$3) RETURNING requested_by",[t,new Date(now.getTime()+180000),now]);
    if(!r.rowCount)return null;
    await db.query("UPDATE pricing_sync_runs SET status='interrupted',finished_at=$1,error='进程中断，已自动恢复任务' WHERE status='running'",[now]);
    const id=randomUUID();await db.query("INSERT INTO pricing_sync_runs(id,trigger,requested_by,status,started_at) VALUES($1,$2,$3,'running',$4)",[id,r.rows[0].requested_by?'manual':'scheduled',r.rows[0].requested_by,now]);
    return {token:t,id};
   });
   if(!claim)return;token=claim.token;runId=claim.id;
   let parsed:ReturnType<typeof parseEcb>|undefined,xml='',error='来源暂不可用',attempts=0;
   for(let i=0;i<3;i++) {
    attempts=i+1;
    try {
     const response=await fetcher(ECB_URL,{signal:AbortSignal.timeout(15000),redirect:'error',headers:{Accept:'application/xml'}});
     if(!response.ok)throw new Error(`来源HTTP ${response.status}`);
     // Bound the response stream before parsing to avoid unbounded memory use.
     const reader=response.body?.getReader();if(!reader)throw new Error('来源内容为空');let bytes=0;const chunks:Uint8Array[]=[];
     try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>200000)throw new Error('来源内容超出限制');chunks.push(r.value);}}finally{await reader.cancel();}
     xml=Buffer.concat(chunks).toString('utf8');parsed=parseEcb(xml,now);break;
    } catch(e) {error=e instanceof Error&&/^(来源|进程)/.test(e.message)?e.message:'来源网络超时或连接失败';if(i<2)await new Promise(r=>setTimeout(r,1000*(i+1)));}
   }
   await transaction(pool,async db=>{
    const lock=await db.query('SELECT * FROM pricing_sync_config WHERE id=1 FOR UPDATE');
    if(lock.rows[0].lease_token!==token)return;
    const config=pricingConfigSchema.parse(lock.rows[0].data);let batchId:string|null=null,status='failed';
    if(parsed) {
     const latest=(await db.query('SELECT source_date::text FROM pricing_fx_batches ORDER BY source_date DESC LIMIT 1')).rows[0];
     if(latest&&parsed.date<latest.source_date){parsed=undefined;error='来源日期倒退，保留最近成功数据';}
    }
    if(parsed) {
     const id=randomUUID(),r=await db.query('INSERT INTO pricing_fx_batches(id,source,source_url,source_date,sha256,raw_xml,rates,cny_rates,first_synced_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(sha256) DO NOTHING RETURNING id',[id,'ECB',ECB_URL,parsed.date,parsed.sha,xml,JSON.stringify(parsed.rates),JSON.stringify(parsed.cnyRates),now]);
     status=r.rowCount?'updated':'unchanged';batchId=r.rowCount?id:(await db.query('SELECT id FROM pricing_fx_batches WHERE sha256=$1',[parsed.sha])).rows[0].id;
     await db.query('UPDATE pricing_alerts SET resolved_at=$1 WHERE resolved_at IS NULL',[now]);
    }
    await db.query('UPDATE pricing_sync_runs SET status=$2,finished_at=$3,attempts=$4,batch_id=$5,error=$6 WHERE id=$1',[runId,status,now,attempts,batchId,parsed?null:error]);
    if(!parsed)await db.query('INSERT INTO pricing_alerts(id,message,run_id) VALUES($1,$2,$3)',[randomUUID(),`汇率同步失败：${error}。已保留最近成功数据，请检查有效期。`,runId]);
    // A successful no-change CHECK does not pretend a new batch was published/synced.
    await db.query('UPDATE pricing_sync_config SET next_run=$1,last_error=$2,last_success=CASE WHEN $3 THEN $4 ELSE last_success END,lease_token=NULL,lease_until=NULL,requested_by=NULL WHERE id=1',[parsed?nextRun(config.times,now):new Date(now.getTime()+15*60000),parsed?null:error,status==='updated',now]);
   });
  } finally {busy=false;}
 }
 return {tick};
}
