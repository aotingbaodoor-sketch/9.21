import type {Express,Request,Response} from 'express';
import type pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {dateSchema} from '../../shared/contracts.ts';
import {pricingConfigSchema} from '../../shared/pricing.ts';
import {quotationSettingsSchema,type Freight,type Product} from '../../shared/quoting.ts';
import {requireAdmin,HttpError} from '../domain.ts';
import {audit} from '../repository.ts';
import {ECB_URL,addDays,day,effectiveSettings,nextRun,pricingState} from './sync.ts';
import {approveImport,freightHeaders,productHeaders,readImport} from './imports.ts';
import {policy} from '../quoting/engine.ts';
type Mutate=(req:Request,res:Response,run:(db:pg.PoolClient)=>Promise<unknown>)=>Promise<void>;
export function priceStatus(validFrom:string|null,validUntil:string|null,ready:boolean,today=day()) {
 return validUntil&&validUntil<today?'已过期':!ready||!validFrom||validFrom>today||!validUntil?'待确认':'有效';
}
export function registerPricing(app:Express,pool:pg.Pool,mutate:Mutate) {
 app.use('/api/pricing', (req,_res,next)=>{if(!['admin','sales','logistics'].includes(req.actor.role))throw new HttpError(403,'无每日价格权限');next();});
 app.get('/api/pricing/alerts/count',async(req,res)=>{requireAdmin(req.actor);res.json((await pool.query('SELECT count(*)::int AS count FROM pricing_alerts WHERE resolved_at IS NULL')).rows[0]);});
 app.get('/api/pricing/overview',async(req,res)=>{
  const stored=(await pool.query('SELECT data,version FROM quotation_settings WHERE id=1')).rows[0];
  const {settings,state,batch}=await effectiveSettings(pool,quotationSettingsSchema.parse(stored.data));
  const reference=batch?Object.entries(batch.cny_rates as Record<string,number>).filter(([currency])=>currency!=='CNY').map(([currency,cnyPerUnit])=>({currency,cnyPerUnit,date:batch.source_date,validUntil:addDays(batch.source_date,state.data.referenceDays),source:'欧洲央行 ECB',sourceUrl:ECB_URL,type:'参考中间汇率（非现汇买入/卖出价）',batchId:batch.id,firstSyncedAt:batch.first_synced_at,status:priceStatus(batch.source_date,addDays(batch.source_date,state.data.referenceDays),true),syncFailed:!!state.last_error})):[];
  const company=Object.entries(settings.fx).map(([currency,r])=>({currency,...r,status:priceStatus(r.date,r.validUntil,true)}));
  const runs=(await pool.query('SELECT id,trigger,started_at,finished_at,status,attempts,batch_id,error FROM pricing_sync_runs ORDER BY started_at DESC LIMIT 12')).rows;
  const alerts=req.actor.role==='admin'?(await pool.query('SELECT id,message,created_at FROM pricing_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 10')).rows:[];
  res.json({reference,company,missingCurrencies:state.data.currencies.filter(c=>c!=='CNY'&&!reference.some(r=>r.currency===c)),config:state.data,configVersion:state.version,lastChecked:state.last_checked,lastSuccess:state.last_success,lastError:state.last_error,lastHeartbeat:state.last_heartbeat,nextRun:state.next_run,running:!!state.lease_token,runs,alerts});
 });
 app.put('/api/pricing/config',async(req,res)=>mutate(req,res,async db=>{
  requireAdmin(req.actor);const input=pricingConfigSchema.parse(req.body.data);
  if(input.mode==='ecb_reference'&&!req.body.acknowledgeReference)throw new HttpError(422,'需确认：ECB是参考汇率，不是银行可成交买卖价；公司自行设定报价缓冲');
  const r=await db.query('UPDATE pricing_sync_config SET data=$1,version=version+1,next_run=$2 WHERE id=1 AND version=$3 RETURNING version',[JSON.stringify(input),nextRun(input.times),z.number().int().parse(req.body.version)]);
  if(!r.rowCount)throw new HttpError(409,'配置已改变，请刷新');await audit(db,req.actor,'修改每日价格同步及报价汇率策略','pricing_sync_config',{mode:input.mode,times:input.times});return r.rows[0];
 }));
 app.post('/api/pricing/sync',async(req,res)=>mutate(req,res,async db=>{
  requireAdmin(req.actor);const state=await pricingState(db);
  if(state.lease_until&&new Date(state.lease_until)>new Date())return{queued:false,message:'同步正在执行'};
  await db.query('UPDATE pricing_sync_config SET next_run=now(),requested_by=$1 WHERE id=1',[req.actor.id]);await audit(db,req.actor,'请求立即同步汇率','pricing_sync_config');return{queued:true,message:'服务器已排队，将在一分钟内检查'};
 }));
 app.get('/api/pricing/catalog',async(req,res)=>{
  const stored=(await pool.query('SELECT data FROM quotation_settings WHERE id=1')).rows[0],rules=quotationSettingsSchema.parse(stored.data),permission=policy(rules,req.actor);
  const products=(await pool.query("SELECT id,version,data FROM quotation_products WHERE (data->>'active')::boolean ORDER BY sku LIMIT 2000")).rows;
  // Whitelist only sale fields; supplier cost, margin, internal and minimum prices never leave this endpoint.
  const productRows=products.map(r=>{const p=r.data as Product;return{id:r.id,version:r.version,sku:p.sku,name:p.nameZh,category:p.category,series:p.series,specs:p.standardSpecs,width:[p.minWidthMm,p.maxWidthMm],height:[p.minHeightMm,p.maxHeightMm],packing:p.packing.type,pricing:p.pricing,sale:p.prices.guide,options:p.options.map(o=>({name:o.nameZh,sale:o.sale,basis:o.basis})),bands:p.bands.map(b=>({maxArea:b.maxArea,sale:b.sale})),formula:p.formula.map(f=>({name:f.name,basis:f.basis,coefficient:f.coefficient,sale:f.sale})),currency:'CNY',source:p.provenance?.provider||'现有公司配置（来源待补）',method:p.provenance?'人工导入':'公司维护',sourceDate:p.provenance?.sourceDate||null,lastSuccess:p.provenance?.importedAt||null,validFrom:p.provenance?.validFrom||null,validUntil:p.priceValidUntil,status:priceStatus(p.provenance?.validFrom||null,p.priceValidUntil,p.prices.guide!==null&&!!p.provenance)};});
  const freight=(await pool.query("SELECT id,version,data FROM quotation_freight WHERE (data->>'active')::boolean AND ((data->>'projectId') IS NULL OR $1='admin' OR EXISTS(SELECT 1 FROM quotation_projects p JOIN customers c ON c.id=p.customer_id WHERE p.id::text=quotation_freight.data->>'projectId' AND c.owner_id=$2 AND NOT c.wa_needs_assignment AND c.deleted_at IS NULL)) ORDER BY updated_at DESC LIMIT 2000",[req.actor.role,req.actor.id])).rows;
  const freightRows=freight.map(r=>{const f=r.data as Freight,canSee=req.actor.role==='admin'||req.actor.role==='logistics'||permission.viewFreightCost;return{id:r.id,version:r.version,name:f.name,country:f.country,city:f.city,originPort:f.originPort,destinationPort:f.destinationPort,mode:f.mode,container:f.container,currency:f.currency,inclusions:f.inclusions,exclusions:f.exclusions,limits:f.limits||null,transitDays:f.transitDays,source:f.forwarder||'提供方待补',method:f.provenance?'人工导入':'现有公司维护',sourceDate:f.provenance?.sourceDate||null,lastSuccess:f.provenance?.importedAt||null,validFrom:f.validFrom,validUntil:f.validUntil,status:priceStatus(f.validFrom,f.validUntil,!!f.provenance&&!!f.fees.length),fees:canSee?f.fees:f.fees.map(f=>({kind:f.kind,basis:f.basis,rate:null,minimum:null})),costRestricted:!canSee,confirmed:f.confirmed};});
  res.json({products:productRows,freight:freightRows});
 });
 app.get('/api/pricing/import-template/:kind',(req,res)=>{
  requireAdmin(req.actor);const kind=z.enum(['product','freight']).parse(req.params.kind);
  res.type('text/csv; charset=utf-8').attachment(`${kind}-prices.csv`).send('\uFEFF'+(kind==='product'?productHeaders:freightHeaders).join(',')+'\r\n');
 });
 app.get('/api/pricing/imports',async(req,res)=>{requireAdmin(req.actor);res.json((await pool.query('SELECT id,kind,name,provider,source_date::text,valid_from::text,valid_until::text,status,created_at,rows,review_note FROM pricing_imports ORDER BY created_at DESC LIMIT 30')).rows);});
 app.post('/api/pricing/imports',async(req,res)=>{
  requireAdmin(req.actor);
  const input=z.object({kind:z.enum(['product','freight']),name:z.string().min(1).max(200),provider:z.string().trim().min(1).max(200),sourceDate:dateSchema,validFrom:dateSchema,validUntil:dateSchema,data:z.string().max(2800000)}).parse(req.body);
  if(input.sourceDate>day()||input.validFrom>input.validUntil)throw new HttpError(422,'来源日期或有效期不正确');
  const bytes=Buffer.from(input.data,'base64'),rows=await readImport(bytes,input.name);
  await mutate(req,res,async db=>{requireAdmin(req.actor);const id=randomUUID(),sha=createHash('sha256').update(bytes).digest('hex');
   const r=await db.query('INSERT INTO pricing_imports(id,kind,name,provider,source_date,valid_from,valid_until,file_sha256,file_bytes,rows,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(kind,file_sha256,provider,source_date,valid_from,valid_until) DO UPDATE SET file_sha256=excluded.file_sha256 RETURNING id,status',[id,input.kind,input.name,input.provider,input.sourceDate,input.validFrom,input.validUntil,sha,bytes,JSON.stringify(rows),req.actor.id]);
   await audit(db,req.actor,'导入价格文件待人工核对',r.rows[0].id,{sha256:sha,rows:rows.length});return r.rows[0];
  });
 });
 app.get('/api/pricing/imports/:id/file',async(req,res)=>{requireAdmin(req.actor);const r=(await pool.query('SELECT name,file_bytes FROM pricing_imports WHERE id=$1',[z.uuid().parse(req.params.id)])).rows[0];if(!r)throw new HttpError(404,'文件不存在');res.type('application/octet-stream').attachment(r.name).send(r.file_bytes);});
 app.post('/api/pricing/imports/:id/review',async(req,res)=>mutate(req,res,async db=>{
  requireAdmin(req.actor);const id=z.uuid().parse(req.params.id),input=z.object({approve:z.boolean(),note:z.string().trim().min(5).max(1000)}).parse(req.body);
  const result=input.approve?await approveImport(db,id,req.actor.id,input.note):{rejected:(await db.query("UPDATE pricing_imports SET status='rejected',reviewed_at=now(),reviewed_by=$2,review_note=$3 WHERE id=$1 AND status='pending'",[id,req.actor.id,input.note])).rowCount};
  await audit(db,req.actor,input.approve?'核准真实价格导入':'驳回价格导入',id,{note:input.note});return result;
 }));
}
