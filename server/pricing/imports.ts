import ExcelJS from 'exceljs';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Db} from '../db.ts';
import {HttpError} from '../domain.ts';
import {productSchema,freightSchema} from '../../shared/quoting.ts';
export const productHeaders=['产品型号','中文名称','英文名称','类别','系列','计价方式','销售指导价CNY','工厂底价CNY','最低销售价CNY','型材','五金','玻璃','颜色','包装说明','最小宽mm','最大宽mm','最小高mm','最大高mm'];
export const freightHeaders=['报价编号','名称','目的国家','城市','起运港','目的港','运输方式','柜型','币种','费用类型','计价单位','金额','最低收费','包含项目','不包含项目','时效','最小体积','最大体积','最小重量','最大重量','体积重系数'];
export type ImportRow=Record<string,string|number|null>;
export async function readImport(bytes:Buffer,name:string):Promise<ImportRow[]> {
 if(bytes.length>2*1024*1024)throw new HttpError(400,'文件不能超过2MB');
 const workbook=new ExcelJS.Workbook();
 if(/\.csv$/i.test(name))await workbook.csv.read(Readable.from([bytes.toString('utf8').replace(/^\uFEFF/,'')]),{parserOptions:{maxRows:502}});
 else if(/\.xlsx$/i.test(name)) {
  if(bytes.length<46||bytes.readUInt32LE(0)!==0x04034b50)throw new HttpError(400,'Excel文件格式无效');
  let unpacked=0,entries=0;
  for(let i=0;i<=bytes.length-46;i++)if(bytes.readUInt32LE(i)===0x02014b50){const size=bytes.readUInt32LE(i+24);unpacked+=size;entries++;if(size===0xffffffff||unpacked>20e6||entries>100||(bytes.readUInt16LE(i+8)&1))throw new HttpError(400,'Excel解压尺寸过大或已加密');i+=45+bytes.readUInt16LE(i+28)+bytes.readUInt16LE(i+30)+bytes.readUInt16LE(i+32);}
  if(!entries)throw new HttpError(400,'Excel目录无效');await workbook.xlsx.load(bytes as never);
 }
 else throw new HttpError(400,'只接受UTF-8 CSV或.xlsx，旧版.xls请另存为.xlsx');
 if(workbook.worksheets.length!==1)throw new HttpError(400,'请将本次需导入的价目表另存为只有一个工作表的文件，避免漏掉其他工作表');
 const sheet=workbook.worksheets[0];if(!sheet||sheet.rowCount>501||sheet.columnCount>50)throw new HttpError(400,'表格为空或超过500行/50列');
 const headers:string[]=[];sheet.getRow(1).eachCell((cell,n)=>{headers[n]=cell.text.trim();});
 if(new Set(headers.filter(Boolean)).size!==headers.filter(Boolean).length)throw new HttpError(400,'表头不能重复');
 const rows:ImportRow[]=[];
 sheet.eachRow((row,n)=>{if(n===1)return;const item:ImportRow=Object.fromEntries(headers.filter(Boolean).map(h=>[h,null]));row.eachCell((cell,c)=>{
  if(!headers[c])return;
  if(cell.type===ExcelJS.ValueType.Formula||cell.type===ExcelJS.ValueType.Hyperlink||cell.type===ExcelJS.ValueType.Error)throw new HttpError(400,`第${n}行含公式、链接或错误；请粘贴为原始数值再导入`);
  item[headers[c]]=typeof cell.value==='number'?cell.value:cell.text.trim()||null;
 });if(Object.values(item).some(v=>v!==null&&v!==''))rows.push(item);});
 if(!rows.length)throw new HttpError(400,'没有价格记录');return rows;
}
const str=(r:ImportRow,k:string)=>String(r[k]??'').trim();
function num(r:ImportRow,k:string) {const v=r[k];if(v===null||v===undefined||v==='')return null;const n=Number(v);if(!Number.isFinite(n)||n<0||n>1e9)throw new HttpError(400,`${k}不是有效的非负数`);return n;}
export async function approveImport(db:Db,importId:string,userId:string,note:string) {
 const record=(await db.query('SELECT *,source_date::text,valid_from::text,valid_until::text FROM pricing_imports WHERE id=$1 FOR UPDATE',[importId])).rows[0];
 if(!record||record.status!=='pending')throw new HttpError(409,'导入不存在或已处理');
 if(record.valid_until<new Date(Date.now()+8*3600000).toISOString().slice(0,10))throw new HttpError(422,'报价已经过期，请取得新报价，不得自动延期');
 const now=new Date().toISOString(),provenance={provider:record.provider,sourceDate:record.source_date,validFrom:record.valid_from,importedAt:new Date(record.created_at).toISOString(),importId,method:'manual_import',approvedAt:now,note};
 const rows=record.rows as ImportRow[],ids:string[]=[];
 if(record.kind==='product') {
  const seen=new Set<string>();
  for(const row of rows) {
   const sku=str(row,'产品型号');if(!sku||seen.has(sku))throw new HttpError(422,'产品型号为空或在文件中重复');seen.add(sku);
   const prior=(await db.query('SELECT * FROM quotation_products WHERE sku=$1 FOR UPDATE',[sku])).rows[0];
   const sale=num(row,'销售指导价CNY');if(sale===null)throw new HttpError(422,`${sku}缺少核准销售价；供应商底价不能自动充当销售价`);
   const data=productSchema.parse({...prior?.data,sku,nameZh:str(row,'中文名称')||prior?.data.nameZh,nameEn:str(row,'英文名称')||prior?.data.nameEn,category:str(row,'类别')||prior?.data.category,series:str(row,'系列')||prior?.data.series,pricing:str(row,'计价方式')||prior?.data.pricing,
    prices:{...prior?.data.prices,guide:sale,...(num(row,'工厂底价CNY')!==null?{factory:num(row,'工厂底价CNY')}:{}) ,...(num(row,'最低销售价CNY')!==null?{minimum:num(row,'最低销售价CNY')}:{})},
    standardSpecs:{...prior?.data.standardSpecs,...Object.fromEntries([['型材','profile'],['五金','hardwareModel'],['玻璃','glass'],['颜色','color']].filter(([cn])=>str(row,cn)).map(([cn,en])=>[en,str(row,cn)]))},
    packing:{...prior?.data.packing,...(str(row,'包装说明')?{type:str(row,'包装说明')}:{})},
    ...Object.fromEntries([['最小宽mm','minWidthMm'],['最大宽mm','maxWidthMm'],['最小高mm','minHeightMm'],['最大高mm','maxHeightMm']].filter(([cn])=>num(row,cn)!==null).map(([cn,en])=>[en,num(row,cn)])),priceValidUntil:record.valid_until,provenance});
   const id=prior?.id||randomUUID();
   if(prior)await db.query('UPDATE quotation_products SET data=$1,version=version+1,updated_at=now() WHERE id=$2',[JSON.stringify(data),id]);
   else await db.query('INSERT INTO quotation_products(id,sku,data) VALUES($1,$2,$3)',[id,sku,JSON.stringify(data)]);ids.push(id);
  }
 } else {
  const groups=new Map<string,ImportRow[]>();for(const row of rows){const key=str(row,'报价编号');if(!key)throw new HttpError(422,'缺少货代报价编号');groups.set(key,[...(groups.get(key)||[]),row]);}
  for(const [code,items] of groups) {
   const row=items[0];for(const other of items)for(const k of freightHeaders.filter(k=>!['费用类型','计价单位','金额','最低收费'].includes(k)))if(str(row,k)!==str(other,k))throw new HttpError(422,`${code}各费用行的航线或条件不一致`);
   const fees=items.map(r=>{const rate=num(r,'金额'),minimum=num(r,'最低收费');if(rate===null||minimum===null)throw new HttpError(422,`${code}费用未知；金额与最低收费须明确填写，确认无最低收费才能填0`);return{kind:str(r,'费用类型'),basis:str(r,'计价单位'),rate,minimum};});
   if(new Set(fees.map(f=>`${f.kind}:${f.basis}`)).size!==fees.length)throw new HttpError(422,`${code}重复费用类别/计费单位，请先合并核对`);
   const data=freightSchema.parse({name:str(row,'名称')||code,country:str(row,'目的国家'),city:str(row,'城市'),originPort:str(row,'起运港'),destinationPort:str(row,'目的港'),mode:str(row,'运输方式'),container:str(row,'柜型'),currency:str(row,'币种'),forwarder:record.provider,source:'forwarder',validFrom:record.valid_from,validUntil:record.valid_until,inclusions:str(row,'包含项目'),exclusions:str(row,'不包含项目'),transitDays:str(row,'时效'),volumetricKgPerCbm:num(row,'体积重系数')??0,fees,confirmed:[...new Set(fees.map(f=>f.kind))],limits:{minCbm:num(row,'最小体积'),maxCbm:num(row,'最大体积'),minKg:num(row,'最小重量'),maxKg:num(row,'最大重量')},provenance});
   if(!data.inclusions||!data.exclusions)throw new HttpError(422,'需明确包含与不包含项目；没有请明确写“无”');
   if((data.limits?.maxCbm!=null&&data.limits?.minCbm!=null&&data.limits.minCbm>data.limits.maxCbm)||(data.limits?.maxKg!=null&&data.limits?.minKg!=null&&data.limits.minKg>data.limits.maxKg))throw new HttpError(422,'货物适用条件上下限颠倒');
   const id=randomUUID();await db.query('INSERT INTO quotation_freight(id,data) VALUES($1,$2)',[id,JSON.stringify(data)]);ids.push(id);
  }
 }
 await db.query("UPDATE pricing_imports SET status='approved',reviewed_at=now(),reviewed_by=$2,review_note=$3 WHERE id=$1",[importId,userId,z.string().min(5).max(1000).parse(note)]);
 return {ids};
}
