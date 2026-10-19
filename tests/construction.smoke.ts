// Isolated fixture data only. No customer notification or production instruction is sent.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {cp} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import type {Server} from 'node:http';
import {localPostgres} from '../scripts/postgres-runtime.ts';
import {database,migrate} from '../server/db.ts';
import {hashPassword} from '../server/domain.ts';
import {createApp} from '../server/app.ts';
import {fixtures,today,future} from './quoting.fixtures.ts';
import {calculate,policy} from '../server/quoting/engine.ts';
import {applyLogistics} from '../server/logistics/engine.ts';
import {logisticsPolicySchema,rateSchema,type CostRate} from '../shared/logistics.ts';
import {uiSession} from './technical-ui.ts';import {expect} from '@playwright/test';
import {PDFDocument} from 'pdf-lib';import ExcelJS from 'exceljs';
const out=process.env.ARTIFACT_DIR!;assert.ok(out);mkdirSync(out,{recursive:true});
const root=mkdtempSync(path.join(os.tmpdir(),'autinberg-construction-')),password=randomBytes(32).toString('base64url'),origin='http://127.0.0.1:4638';
const local=await localPostgres({databaseDir:path.join(root,'pg'),port:55639,user:'postgres',password,persistent:true,fastIsolatedInit:true,onLog:()=>{},onError:()=>{}});
const pool=database(`postgresql://postgres:${password}@127.0.0.1:55639/construction_test`);let started=false,server:Server|undefined,ui:Awaited<ReturnType<typeof uiSession>>|undefined;
const results:string[]=[];const pass=(s:string)=>{results.push(s);console.log('PASS',s);};
type Actor={cookie:string;csrf:string};
async function req(a:Actor|null,url:string,body?:unknown){const r=await fetch(origin+'/api'+url,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID(),...(a?{Cookie:a.cookie,'X-CSRF-Token':a.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:r.headers.get('content-type')?.includes('application/json')?await r.json():Buffer.from(await r.arrayBuffer()),cookie:r.headers.get('set-cookie')?.split(';')[0]??''};}
async function ok(a:Actor,url:string,body?:unknown){const r=await req(a,url,body);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
try{
 await local.initialise();await local.start();started=true;await local.createDatabase('construction_test');await migrate(pool);
 const adminId=randomUUID(),salesId=randomUUID(),hash=await hashPassword(password);
 for(const [id,role,name]of[[adminId,'admin','admin'],[salesId,'sales','sales']])await pool.query('INSERT INTO users(id,name,email,password_hash,role)VALUES($1,$2,$3,$4,$5)',[id,name,name+'@chain.invalid',hash,role]);
 const web=path.join(root,'web');mkdirSync(web);await cp(path.resolve('dist'),path.join(web,'dist'),{recursive:true});process.chdir(web);
 server=createApp(pool,{origin,serveStatic:true}).listen(4638,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));
 const login=async(email:string)=>{const r=await req(null,'/auth/login',{email:email+'@chain.invalid',password});assert.equal(r.status,200);return{cookie:r.cookie,csrf:r.data.csrf};};const admin=await login('admin'),sales=await login('sales');
 ui=await uiSession(origin,password);await ui.page.goto(origin+'/settings/document-languages');await expect(ui.page.getByText('T46 客户语种政策（新增生效版本）')).toBeVisible();
 await ui.page.locator('input[name="country"]').fill('US');await ui.page.locator('select[name="class"]').selectOption('QT');await ui.page.locator('input[name="lang"][value="en"]').check();await ui.page.locator('input[name="date"]').fill(today);
 const saved=ui.page.waitForResponse(r=>r.url().endsWith('/document-languages/policies')&&r.request().method()==='POST');await ui.page.getByRole('button',{name:'保存语种政策'}).click();assert.equal((await saved).status(),200);await expect(ui.page.getByText(/US · QT · zh \/ en/)).toBeVisible();await ui.page.screenshot({path:path.join(out,'language-settings-desktop.png'),fullPage:true});
 await ui.page.setViewportSize({width:390,height:844});await ui.page.reload();await expect(ui.page.getByText('T46 客户语种政策（新增生效版本）')).toBeVisible();await ui.page.screenshot({path:path.join(out,'language-settings-mobile.png'),fullPage:true});pass('Desktop/mobile admin form saved a real isolated T46 policy; refresh and zero page errors');
 assert.equal((await req(sales,'/document-languages/config')).status,403);assert.equal((await req(sales,'/document-languages/policies',{})).status,403);pass('Sales cannot read or write administrator language configuration');
 const customer=await ok(admin,'/customers',{company:'ISOLATED TEST ONLY customer'}),projectId=randomUUID(),quoteId=randomUUID();await pool.query("INSERT INTO quotation_projects(id,customer_id,name,created_by)VALUES($1,$2,'ISOLATED TEST ONLY',$3)",[projectId,customer.id,adminId]);
 const f=fixtures();f.product.category='平开窗';f.product.door_type=null;f.product.moq_area=null;f.input.lines[0].width=1000;f.input.lines[0].height=900;f.input.lines[0].quantity=2;f.input.country='US';f.input.incoterm='DAP';f.input.currency='CNY';f.input.freightMarkupPct=0;f.input.freightId=null;
 f.settings.logisticsPolicy=logisticsPolicySchema.parse({reservePrepaid:true,reserveActualSettlement:true,reserveUnusedRefund:true,reserveRefundDeadline:'ISOLATED TEST ONLY: 10 days after reconciliation (not company policy)'});
 const rates=['domestic','export','international','insurance','destination','delivery'].map(kind=>({...rateSchema.parse({kind,name:'ISOLATED '+kind,country:'US',currency:'CNY',unit:kind==='insurance'?'percent':'fixed',rate:kind==='insurance'?.3:100,sourceKind:'manual',sourceDate:today,sourceUrl:'https://example.invalid/test',provider:'ISOLATED',evidence:'ISOLATED TEST ONLY source evidence',scope:'ISOLATED contractual boundary',validFrom:today,validUntil:future}),id:randomUUID(),series_id:randomUUID(),version:1,is_current:true} as CostRate));
 f.input.logistics={rateIds:rates.map(r=>r.id),transport:'sea',containers:1,storageDays:0,includedServices:['insurance'],scope:'ISOLATED TEST ONLY'};
 const calc=applyLogistics(calculate(f.input,[f.product],null,f.settings,policy(f.settings,{id:adminId,role:'admin'}),today,projectId,true),f.input,rates,f.settings,today);
 calc.private.logistics!.declaration={id:randomUUID(),zh:'仅作排版测试：估算值，代垫不赚差价，据实结算，多退少补。非公司核准译本。',en:'TEST ONLY - not an approved translation. Estimated advances, no spread, settled against actual expenses; refund excess or collect shortfall.',ru:'ТЕСТ — не утвержденный перевод. Ориентировочная сумма, расчёт по фактическим расходам.',ar:'اختبار فقط — ليست ترجمة معتمدة. تقدير وتسوية حسب التكلفة الفعلية.',approved_by:adminId,approved_on:today};
 await pool.query("INSERT INTO quotation_versions(id,project_id,number,input,snapshot,customer_snapshot,reason,status,created_by)VALUES($1,$2,1,$3,$4,$5,'ISOLATED TEST ONLY','issued',$6)",[quoteId,projectId,JSON.stringify(f.input),JSON.stringify(calc),JSON.stringify({company:'ISOLATED TEST ONLY',contact:'TEST',email:'test@example.invalid',country:'US'}),adminId]);
 const base=`/quoting/versions/${quoteId}`;
 assert.equal((await req(admin,base+'/documents',{kind:'quotation',language:'zh'})).status,422);
 for(const cls of['QT','LOGISTICS']){
  if(cls==='LOGISTICS')await ok(admin,'/document-languages/policies',{country_code:'US',doc_class:cls,lang_set:['zh','en'],effective_from:today});
  const s=await ok(admin,base+'/languages/'+cls);const t=await ok(admin,base+'/languages/'+cls,{lang:'en',sourceHash:s.hash,body:'ISOLATED TEST ONLY, not a business translation. Chinese source prevails. No commercial or production use.',translatedBy:'ISOLATED TEST',evidence:'ISOLATED TEST ONLY no genuine approval'});
  assert.equal((await req(sales,base+'/languages/'+cls+'/'+t.id+'/review',{approve:true,reason:'ISOLATED TEST ONLY approval'})).status,403);
  await ok(admin,base+'/languages/'+cls+'/'+t.id+'/review',{approve:true,reason:'ISOLATED TEST ONLY verification'});
 }
 const doc=await ok(admin,base+'/documents',{kind:'quotation',language:'zh'});const pdf=await ok(admin,'/quoting/documents/'+doc.id);writeFileSync(path.join(out,'quotation-sample.pdf'),pdf);
 assert.equal((await ok(admin,base+'/documents',{kind:'quotation',language:'zh'})).id,doc.id);pass('Actual QT endpoint blocks missing translation; reviewed translation produces immutable PDF; repeat export returns same document');
 const logPdf=await ok(admin,base+'/logistics-document?format=pdf'),logXlsx=await ok(admin,base+'/logistics-document?format=xlsx');writeFileSync(path.join(out,'logistics-sample.pdf'),logPdf);writeFileSync(path.join(out,'logistics-sample.xlsx'),logXlsx);
 assert.equal((await PDFDocument.load(logPdf)).getPageCount(),2);const wb=new ExcelJS.Workbook();await wb.xlsx.load(logXlsx);assert.equal(wb.worksheets[0].getCell('A13').value,'ar');assert.equal(wb.worksheets[0].pageSetup.fitToHeight,1);pass('Actual customer PDF and XLSX export four-language main sheet, separate human translation page; no production data used');
 const qtState=await ok(admin,base+'/languages/QT');await ok(admin,base+'/languages/QT/'+qtState.rows[0].id+'/review',{approve:false,reason:'ISOLATED TEST ONLY revocation'});assert.equal((await req(admin,'/quoting/documents/'+doc.id)).status,409);pass('Revoked human translation blocks old formal PDF download without deleting historical bytes');
 assert.deepEqual(ui.errors,[]);writeFileSync(path.join(out,'construction-smoke.json'),JSON.stringify({at:new Date().toISOString(),environment:'isolated PostgreSQL + actual Express + rendered browser',passed:results,productionMutated:false,samples:'TEST ONLY, not company price/translation/approval'},null,2));
 console.log(JSON.stringify({passed:results.length,failed:0}));
}finally{if(ui)await ui.browser.close();if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}await pool.end();if(started)await local.stop();}
