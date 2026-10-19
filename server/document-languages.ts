import type {Express,Request,Response} from 'express';
import type pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Db} from './db.ts';
import {HttpError,requireAdmin} from './domain.ts';
import {audit} from './repository.ts';
import {quoteHtml} from './quoting/pdf.ts';
import type {QuoteRow} from './quoting/types.ts';
import {logisticsCustomerHtml} from './logistics/customer-export.ts';
import {escapeXml as e} from '../shared/drawing.ts';
export const PRIMARY_CLAUSE='本件以中文本为准，译本仅供参考';
type Mutate=(req:Request,res:Response,run:(db:pg.PoolClient)=>Promise<unknown>)=>Promise<void>;
export type DocClass='QT'|'PI'|'SC'|'LOGISTICS';
const kind=(c:DocClass)=>c==='QT'?'quotation':c==='SC'?'contract':'pi';
export function chineseSource(q:QuoteRow,c:DocClass){const source={...q,doc_no:'[正式编号签发时登记]',registered_document_id:null};return c==='LOGISTICS'?logisticsCustomerHtml(source):quoteHtml(source,kind(c),'zh');}
export const sourceHash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function translationMarkup(rows:{lang:string;body:string}[]){return rows.map(t=>`<section style="break-before:page" lang="${e(t.lang)}" dir="${t.lang==='ar'?'rtl':'ltr'}"><h2>${e(t.lang)} · 人工审核译本</h2><div style="white-space:pre-wrap">${e(t.body)}</div><p>${PRIMARY_CLAUSE}</p></section>`).join('');}
export async function languageState(db:Db,q:QuoteRow,c:DocClass){
 const source=chineseSource(q,c),hash=sourceHash(source),country=String(q.customer_snapshot.country??'').trim().toUpperCase();
 const policy=(await db.query("SELECT * FROM doc_lang_policy WHERE audience='C' AND country_code=$1 AND doc_class=$2 AND effective_from<=CURRENT_DATE ORDER BY effective_from DESC LIMIT 1",[country,c])).rows[0];
 const rows=(await db.query('SELECT id,lang,body,evidence,source_hash,status,translated_by,reviewed_by,issued_on FROM translation_registry WHERE quote_id=$1 AND doc_class=$2 ORDER BY created_at DESC',[q.id,c])).rows;
 const errors:string[]=[];
 if(!policy)errors.push(`G-39：客户国别 ${country||'未填写'} 的${c}语种政策未配置，请管理员维护单据语言`);
 const langs:string[]=policy?.lang_set??[],selected:any[]=[];
 for(const lang of langs.filter(l=>l!=='zh')){
  const row=rows.find(r=>r.lang===lang&&r.source_hash===hash&&r.status==='issued');
  if(!row)errors.push(`G-39：${c}缺少对应中文版本的已审核${lang}人工译本`);else selected.push(row);
 }
 const glossary=(await db.query("SELECT * FROM term_glossary WHERE locked AND scope IN ('all',$1)",[c])).rows;
 for(const t of glossary)if(source.includes(e(t.term_zh)))for(const lang of langs.filter(l=>l!=='zh')){
  const target=t['term_'+lang],translation=selected.find(r=>r.lang===lang);
  if(!target)errors.push(`G-41：锁定术语「${t.term_zh}」缺少${lang}译文`);
  else if(translation&&!translation.body.includes(target))errors.push(`G-41：${lang}人工译本未包含已锁定术语「${target}」，请核对后重新登记`);
 }
 return {hash,country,policy,langs,rows:rows.map(r=>({...r,status:r.status==='issued'&&r.source_hash!==hash?'expired':r.status})),selected,errors,source};
}
export async function assertLanguages(db:Db,q:QuoteRow,c:DocClass){
 const state=await languageState(db,q,c);
 if(state.errors.length)throw new HttpError(422,state.errors.join('；'));
 if(!state.source.includes(PRIMARY_CLAUSE))throw new HttpError(422,'G-40：中文为准条款缺失');
 return {sourceHash:state.hash,policyId:state.policy.id,langSet:state.langs,translations:state.selected.map(r=>({id:r.id,lang:r.lang,body:r.body,reviewedBy:r.reviewed_by})),primaryClause:PRIMARY_CLAUSE};
}
export function registerDocumentLanguages(app:Express,pool:pg.Pool,mutate:Mutate){
 app.get('/api/document-languages/config',async(req,res)=>{requireAdmin(req.actor);res.json({policies:(await pool.query('SELECT * FROM doc_lang_policy ORDER BY created_at DESC')).rows,terms:(await pool.query('SELECT * FROM term_glossary ORDER BY term_zh')).rows,declarations:(await pool.query('SELECT * FROM logistics_declarations ORDER BY approved_on DESC LIMIT 1')).rows});});
 app.post('/api/document-languages/policies',async(req,res)=>mutate(req,res,async db=>{requireAdmin(req.actor);const v=z.object({country_code:z.string().trim().min(1).max(100),doc_class:z.enum(['QT','PI','SC','TC','CI','PL','RECEIPT','LOGISTICS']),lang_set:z.array(z.enum(['zh','en','ru','ar'])).min(2).max(4),effective_from:z.iso.date()}).parse(req.body);if(!v.lang_set.includes('zh')||new Set(v.lang_set).size!==v.lang_set.length)throw new HttpError(422,'须包含中文及客户语言且不重复');const id=randomUUID();await db.query("INSERT INTO doc_lang_policy(id,audience,country_code,doc_class,lang_set,effective_from,created_by) VALUES($1,'C',$2,$3,$4,$5,$6)",[id,v.country_code.toUpperCase(),v.doc_class,JSON.stringify(v.lang_set),v.effective_from,req.actor.id]);await audit(db,req.actor,'登记单据语种政策',id,v);return{id};}));
 app.post('/api/document-languages/terms',async(req,res)=>mutate(req,res,async db=>{requireAdmin(req.actor);const v=z.object({term_zh:z.string().trim().min(1).max(200),term_en:z.string().max(500),term_ru:z.string().max(500),term_ar:z.string().max(500),scope:z.enum(['all','QT','PI','SC','TC','CI','PL','RECEIPT','LOGISTICS'])}).parse(req.body);const id=randomUUID();await db.query('INSERT INTO term_glossary(id,term_zh,term_en,term_ru,term_ar,scope,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,v.term_zh,v.term_en,v.term_ru,v.term_ar,v.scope,req.actor.id]);await audit(db,req.actor,'核准并锁定术语',id);return{id};}));
 app.post('/api/document-languages/declarations',async(req,res)=>mutate(req,res,async db=>{requireAdmin(req.actor);const v=z.object({zh:z.string().min(20).max(1000),en:z.string().min(20).max(2000),ru:z.string().min(20).max(2000),ar:z.string().min(20).max(2000),evidence:z.string().trim().min(10).max(1000)}).parse(req.body);for(const word of ['估算值','代垫','不赚','据实结算','多退少补'])if(!v.zh.includes(word))throw new HttpError(422,'物流声明缺少必要内容：'+word);if(/绝对最低|保证不涨价|包干不补/.test(v.zh))throw new HttpError(422,'不得作绝对化费用承诺');const id=randomUUID();await db.query('INSERT INTO logistics_declarations(id,zh,en,ru,ar,evidence,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,v.zh,v.en,v.ru,v.ar,v.evidence,req.actor.id]);await audit(db,req.actor,'核准四语物流费用声明',id,{evidence:v.evidence});return{id};}));
}
