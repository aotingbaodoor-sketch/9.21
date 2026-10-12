import type {Express,Request,Response} from 'express';
import type pg from 'pg';
import type {Db} from '../db.ts';
import type {User} from '../../shared/contracts.ts';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Decimal} from 'decimal.js';
import {HttpError,businessDay} from '../domain.ts';
import {audit} from '../repository.ts';
import {materialSchema,costSource,type Material} from '../../shared/materials.ts';
import {optionSchema,productSchema,quotationSettingsSchema,type Product} from '../../shared/quoting.ts';
import {effectiveSettings} from '../pricing/sync.ts';
import {readImport} from '../pricing/imports.ts';
type Mutate=(req:Request,res:Response,run:(db:pg.PoolClient)=>Promise<unknown>)=>Promise<void>;
const allow=(role:string)=>{if(!['admin','coordinator'].includes(role))throw new HttpError(403,'物料及选装成本仅供管理员和跟单员维护');};
const normal=(r:any):Material=>({...r.data,id:r.id,series_id:r.series_id,version:r.version,is_current:r.is_current});
const reason=z.string().trim().min(5).max(1000);
const optionImport=costSource.extend({sku:z.string().min(1),option:optionSchema,reason});
function dates(data:z.infer<typeof costSource>){const today=businessDay('Asia/Shanghai');if(data.sourceDate>today||data.validFrom>today||data.validUntil<today||data.validFrom>data.validUntil)throw new HttpError(422,'来源日期不能在未来，成本必须已生效且尚未过期');}
async function save(db:Db,actor:User,raw:unknown,why:string,prior?:string){
 allow(actor.role);const data=materialSchema.parse(raw);dates(data);
 if(!(await db.query('SELECT 1 FROM factories WHERE id=$1 AND active AND deleted_at IS NULL',[data.factoryId])).rowCount)throw new HttpError(422,'请选择有效的现有供应商/工厂');
 await db.query("SELECT pg_advisory_xact_lock(hashtext('material-cost:'||$1))",[`${data.factoryId}:${data.supplierCode}`]);
 const current=(await db.query('SELECT * FROM logistics_materials WHERE factory_id=$1 AND supplier_code=$2 AND is_current FOR UPDATE',[data.factoryId,data.supplierCode])).rows[0];
 if(current&&JSON.stringify(materialSchema.parse(current.data))===JSON.stringify(data))return {id:current.id,version:current.version,unchanged:true};
 if(prior&&current?.id!==prior)throw new HttpError(409,'物料已升版，请刷新');
 if(current&&!prior)throw new HttpError(409,'供应商物料编码已存在，请选择升版');
 const id=randomUUID(),series=current?.series_id??randomUUID(),version=(current?.version??0)+1;
 if(current)await db.query('UPDATE logistics_materials SET is_current=false WHERE id=$1',[current.id]);
 await db.query('INSERT INTO logistics_materials(id,series_id,factory_id,supplier_code,version,data,created_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,series,data.factoryId,data.supplierCode,version,JSON.stringify(data),actor.id,why]);
 await audit(db,actor,'物料采购价升版',id,{series,previousId:current?.id,version,reason:why});return {id,version};
}
export async function materialChanges(db:Db,products:Product[],until:string,lock=false){
 const parts=products.flatMap(p=>p.options.filter(o=>o.material)),refs=parts.map(o=>o.material!),errors:string[]=[];
 if(!refs.length)return errors;
 const rows=(await db.query(`SELECT id,version,is_current,data FROM logistics_materials WHERE id=ANY($1::uuid[]) ORDER BY id ${lock?'FOR SHARE':''}`,[refs.map(r=>r.id)])).rows;
 const today=businessDay('Asia/Shanghai');
 for(const [index,r] of refs.entries()){
  const row=rows.find(v=>v.id===r.id&&v.version===r.version&&v.is_current);
  if(!row)errors.push('G-36：产品引用物料已升版，请由跟单员重新关联成本');
  else if(['cost','currency','unit','sourceDate','validFrom','validUntil'].some(k=>row.data[k]!==r[k as keyof typeof r])||new Decimal(row.data.cost).mul(r.coefficient).mul(r.cnyPerUnit).toDecimalPlaces(6).toNumber()!==parts[index].cost)errors.push('G-36：物料引用金额或来源与已登记版本不一致，须重新关联');
  if(r.validFrom>today||r.validUntil<until||r.validUntil<today)errors.push('G-32：产品引用物料有效期不足，请由跟单员更新');
 }
 return [...new Set(errors)];
}
export function registerMaterials(app:Express,pool:pg.Pool,mutate:Mutate){
 app.get('/api/logistics/materials',async(req,res)=>{allow(req.actor.role);const suppliers=(await pool.query('SELECT id,name FROM factories WHERE active AND deleted_at IS NULL ORDER BY name')).rows;const rows=(await pool.query('SELECT * FROM logistics_materials WHERE is_current ORDER BY supplier_code LIMIT 2000')).rows;res.json({suppliers,materials:rows.map(normal)});});
 app.get('/api/logistics/materials/:id/history',async(req,res)=>{allow(req.actor.role);res.json((await pool.query('SELECT * FROM logistics_materials WHERE series_id=(SELECT series_id FROM logistics_materials WHERE id=$1) ORDER BY version DESC',[z.uuid().parse(req.params.id)])).rows.map(r=>({...normal(r),reason:r.reason,created_at:r.created_at})));});
 app.post('/api/logistics/materials',async(req,res)=>mutate(req,res,async db=>{allow(req.actor.role);const i=z.object({data:materialSchema,reason,previousId:z.uuid().optional()}).parse(req.body);return save(db,req.actor,i.data,i.reason,i.previousId);}));
 app.post('/api/logistics/material-link',async(req,res)=>mutate(req,res,async db=>{
  allow(req.actor.role);const i=z.object({productId:z.uuid(),version:z.number().int(),optionId:z.string().min(1),materialId:z.uuid(),coefficient:z.number().positive().max(1e6),reason}).parse(req.body);
  const p=(await db.query('SELECT * FROM quotation_products WHERE id=$1 FOR UPDATE',[i.productId])).rows[0];if(!p||p.version!==i.version)throw new HttpError(409,'产品已变更，请刷新');
  const row=(await db.query('SELECT * FROM logistics_materials WHERE id=$1 FOR SHARE',[i.materialId])).rows[0];if(!row?.is_current)throw new HttpError(409,'物料不存在或已升版');const mat=normal(row);dates(mat);
  const opt=p.data.options.find((o:any)=>o.id===i.optionId);if(!opt)throw new HttpError(422,'请选择产品已有选装项，先维护中文/英文配置和销售加价');
  const cfg=quotationSettingsSchema.parse((await db.query('SELECT data FROM quotation_settings WHERE id=1')).rows[0].data),{settings}=await effectiveSettings(db,cfg),fx=mat.currency==='CNY'?null:settings.fx[mat.currency];
  if(mat.currency!=='CNY'&&(!fx||fx.date>businessDay('Asia/Shanghai')||fx.validUntil<mat.validUntil))throw new HttpError(422,'缺少覆盖物料有效期的公司换算汇率；先维护有效汇率或取得人民币报价');
  const cnyPerUnit=fx?.cnyPerUnit??1,cost=new Decimal(mat.cost).mul(i.coefficient).mul(cnyPerUnit).toDecimalPlaces(6).toNumber();
  const data=productSchema.parse({...p.data,options:p.data.options.map((o:any)=>o.id===i.optionId?{...o,cost,commercialReview:true,material:{id:mat.id,version:mat.version,name:mat.name,currency:mat.currency,unit:mat.unit,coefficient:i.coefficient,cost:mat.cost,cnyPerUnit,sourceDate:mat.sourceDate,validFrom:mat.validFrom,validUntil:mat.validUntil,fx:fx??null}}:o)});
  await db.query('UPDATE quotation_products SET data=$2,version=version+1,updated_at=now() WHERE id=$1',[p.id,JSON.stringify(data)]);await audit(db,req.actor,'关联物料成本到产品选装',p.id,{materialId:mat.id,materialVersion:mat.version,optionId:i.optionId,coefficient:i.coefficient,reason:i.reason});return {version:p.version+1};
 }));
 const materialHeaders=['供应商名称','供应商物料码','名称','规格','单位','币种','采购单价','来源日期','生效日期','失效日期','提供方','凭证链接','变更原因'];
 const optionHeaders=['产品型号','选装ID','配置组','中文名称','英文名称','计价基准','成本CNY','销售加价CNY','必选','来源日期','生效日期','失效日期','提供方','凭证链接','变更原因'];
 app.get('/api/logistics/cost-template/:kind',(req,res)=>{allow(req.actor.role);const kind=z.enum(['materials','options']).parse(req.params.kind);res.type('text/csv; charset=utf-8').attachment(`${kind}-cost.csv`).send('\uFEFF'+(kind==='materials'?materialHeaders:optionHeaders).join(',')+'\r\n');});
 app.post('/api/logistics/cost-import-preview',async(req,res)=>mutate(req,res,async db=>{
  allow(req.actor.role);const input=z.object({kind:z.enum(['materials','options']),name:z.string().max(180),data:z.string().max(2800000)}).parse(req.body),bytes=Buffer.from(input.data,'base64'),rows=await readImport(bytes,input.name),out:any[]=[],seen=new Set<string>();
  for(const [index,r] of rows.entries()){
   const text=(k:string)=>String(r[k]??'').trim(),num=(k:string)=>text(k)===''?undefined:Number(r[k]);
   const source={sourceDate:r['来源日期'],validFrom:r['生效日期'],validUntil:r['失效日期'],provider:r['提供方'],evidence:r['凭证链接']};
   let data:any=null,previousId:string|undefined,version:number|undefined,duplicate=false,errors:string[]=[];
   try{
    if(input.kind==='materials'){
     const f=(await db.query('SELECT id FROM factories WHERE name=$1 AND active AND deleted_at IS NULL',[text('供应商名称')])).rows[0];
     data=materialSchema.parse({...source,factoryId:f?.id,supplierCode:r['供应商物料码'],name:r['名称'],specification:r['规格'],unit:r['单位'],currency:r['币种'],cost:num('采购单价')});
     const prior=(await db.query('SELECT * FROM logistics_materials WHERE factory_id=$1 AND supplier_code=$2 AND is_current',[data.factoryId,data.supplierCode])).rows[0];previousId=prior?.id;duplicate=!!prior&&JSON.stringify(materialSchema.parse(prior.data))===JSON.stringify(data);
    }else{
     data=optionImport.parse({...source,sku:r['产品型号'],reason:r['变更原因'],option:{id:r['选装ID'],group:r['配置组'],nameZh:r['中文名称'],nameEn:r['英文名称'],basis:r['计价基准'],cost:num('成本CNY'),sale:num('销售加价CNY'),required:text('必选')==='true'}});
     if(data.option.cost===null||data.option.sale===null||!['true','false'].includes(text('必选')))throw new HttpError(422,'成本、销售加价及必选true/false必须明确填写');
     const p=(await db.query('SELECT id,version,data FROM quotation_products WHERE sku=$1',[data.sku])).rows[0];if(!p)throw new HttpError(422,'产品型号不存在');version=p.version;previousId=p.id;
     const o=p.data.options.find((o:any)=>o.id===data.option.id);if(o?.material)throw new HttpError(422,'该选装已关联物料，请在物料关联入口升版，不能导入覆盖关联');
     duplicate=!!o&&Object.entries(data.option).filter(([k])=>!['commercialReview','source','material'].includes(k)).every(([k,v])=>JSON.stringify(o[k])===JSON.stringify(v))&&JSON.stringify(o.source)===JSON.stringify(costSource.parse(data));
    }
    dates(data);reason.parse(r['变更原因']);const key=input.kind==='materials'?`${data.factoryId}:${data.supplierCode}`:`${data.sku}:${data.option.id}`;if(seen.has(key))throw new HttpError(422,'文件内编码重复');seen.add(key);
   }catch(e){errors=e instanceof z.ZodError?e.issues.map(v=>`${v.path.join('.')}:${v.message}`):[e instanceof HttpError?e.message:'该行无效'];}
   out.push({row:index+2,data,previousId,version,duplicate,reason:text('变更原因'),errors});
  }
  const id=randomUUID();await db.query('INSERT INTO logistics_imports(id,name,bytes,rows,created_by,kind) VALUES($1,$2,$3,$4,$5,$6)',[id,input.name,bytes,JSON.stringify(out),req.actor.id,input.kind]);return {id,rows:out};
 }));
 app.post('/api/logistics/cost-imports/:id/commit',async(req,res)=>mutate(req,res,async db=>{
  allow(req.actor.role);const row=(await db.query("SELECT * FROM logistics_imports WHERE id=$1 AND kind IN ('materials','options') AND (created_by=$2 OR $3='admin') FOR UPDATE",[z.uuid().parse(req.params.id),req.actor.id,req.actor.role])).rows[0];if(!row)throw new HttpError(404,'预览不存在');if(row.committed_at)return {alreadyCommitted:true};
  if(!row.rows.length||row.rows.some((r:any)=>r.errors.length))throw new HttpError(422,'请先修正错误行，不能部分导入');
  const productVersions=new Map<string,number>();
  for(const r of row.rows){if(r.duplicate)continue;if(row.kind==='materials')await save(db,req.actor,r.data,r.reason,r.previousId);else{
   const data=optionImport.parse(r.data);dates(data);const p=(await db.query('SELECT * FROM quotation_products WHERE id=$1 FOR UPDATE',[r.previousId])).rows[0];const expected=productVersions.get(r.previousId)??r.version;if(!p||p.version!==expected)throw new HttpError(409,'产品已变化，请重新预览');
   const updated=productSchema.parse({...p.data,options:[...p.data.options.filter((o:any)=>o.id!==data.option.id),{...data.option,commercialReview:true,source:costSource.parse(data)}]});await db.query('UPDATE quotation_products SET data=$2,version=version+1,updated_at=now() WHERE id=$1',[p.id,JSON.stringify(updated)]);productVersions.set(p.id,p.version+1);
   await audit(db,req.actor,'导入选装加价新版本',p.id,{optionId:data.option.id,version:p.version+1,reason:r.reason,importId:row.id});
  }}await db.query('UPDATE logistics_imports SET committed_at=now() WHERE id=$1',[row.id]);return {count:row.rows.filter((r:any)=>!r.duplicate).length};
 }));
}
