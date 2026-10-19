import ExcelJS from 'exceljs';
import type {QuoteRow} from '../quoting/types.ts';
import {escapeXml as e} from '../../shared/drawing.ts';
import {HttpError} from '../domain.ts';
import {renderHtmlPdf} from '../supply/manufacturing-export.ts';
export function logisticsPublic(q:QuoteRow){
 const c=q.snapshot,s=c.private.logistics;
 if(!s)throw new HttpError(409,'历史报价没有物流快照，不能补造');
 const needs=['CIF','DAP','DDP'].includes(q.input.incoterm),decl=s.declaration;
 if(needs&&(!decl||['zh','en','ru','ar'].some(l=>!decl[l as 'zh'])))throw new HttpError(422,'物流报价缺少已审核中英俄阿四语声明，请在系统设置→单据语言登记，再新建报价版本冻结');
 if(needs&&(q.input.freightMarkupPct!==0||s.riskCny>0))throw new HttpError(422,'物流金额仍含运费加价或内部DDP利润缓冲，不能声明代垫不赚差价；请先核定服务销售额与实际代垫费用的独立拆分');
 return {number:q.doc_no??'未签发草稿',version:q.number,term:q.input.incoterm,scope:s.scope,currency:q.input.currency,freight:c.freightTotal,reserve:c.reserve?.amount??0,deadline:c.reserve?.refundDeadline??'',declaration:needs?decl:undefined};
}
export function logisticsCustomerHtml(q:QuoteRow){const v=logisticsPublic(q);return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:14mm}body{font:12px/1.5 Arial,'Noto Sans CJK SC',sans-serif;color:#24343b}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px}.statement{break-inside:avoid}p{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>AUTINBERG 物流报价</h1><p>${e(v.number)} · V${v.version} · ${v.term}</p><p>${e(v.scope)}</p><table><tr><th>币种</th><th>物流费（估算）</th><th>独立风险预收款</th></tr><tr><td>${v.currency}</td><td>${v.freight??'待核实'}</td><td>${v.reserve}</td></tr></table>${v.reserve?`<p>预收、据实结算、未发生全额退还；退还时限：${e(v.deadline)}</p>`:''}${v.declaration?`<section class="statement"><h2>物流费用声明</h2>${(['zh','en','ru','ar'] as const).map(l=>`<p lang="${l}" dir="${l==='ar'?'rtl':'ltr'}"><b>${l}</b> ${e(v.declaration![l])}</p>`).join('')}</section>`:''}<p>本件以中文本为准，译本仅供参考</p></body></html>`;}
export async function logisticsCustomerFile(q:QuoteRow,format:'pdf'|'xlsx',translated:{lang:string;body:string}[]){
 if(format==='pdf')return renderHtmlPdf(logisticsCustomerHtml(q).replace('</body>',translated.map(t=>`<section style="break-before:page;white-space:pre-wrap" dir="${t.lang==='ar'?'rtl':'ltr'}"><h2>${e(t.lang)} 人工审核译本</h2>${e(t.body)}<p>本件以中文本为准，译本仅供参考</p></section>`).join('')+'</body>'));
 const v=logisticsPublic(q),wb=new ExcelJS.Workbook(),s=wb.addWorksheet('物流报价');
 s.addRows([['AUTINBERG 物流报价'],['单号',v.number],['版本',v.version],['术语',v.term],['范围',v.scope],['币种',v.currency],['物流费（估算）',v.freight],['风险预收款',v.reserve],['退还时限',v.deadline],...(v.declaration?(['zh','en','ru','ar'] as const).map(l=>[l,v.declaration![l]]):[]),['本件以中文本为准，译本仅供参考']]);
 s.columns=[{width:25},{width:95}];s.eachRow(r=>{r.alignment={wrapText:true,vertical:'middle'};r.height=r.number>=10&&r.number<=13?82:30;});
 s.pageSetup={paperSize:9,orientation:'portrait',fitToPage:true,fitToWidth:1,fitToHeight:1,printArea:`A1:B${s.rowCount}`};
 for(const t of translated){const tab=wb.addWorksheet(t.lang);tab.getCell('A1').value=t.body;tab.getCell('A2').value='本件以中文本为准，译本仅供参考';tab.getColumn(1).width=110;tab.getCell('A1').alignment={wrapText:true};}
 return Buffer.from(await wb.xlsx.writeBuffer());
}
