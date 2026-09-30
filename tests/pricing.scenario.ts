import assert from 'node:assert/strict';
import type pg from 'pg';
import type {Browser} from '@playwright/test';
import {expect} from '@playwright/test';
import {createPricingWorker,day,addDays} from '../server/pricing/sync.ts';
import {productHeaders,freightHeaders} from '../server/pricing/imports.ts';
import type {User} from '../shared/contracts.ts';
type Agent={cookie:string;csrf:string;user:User};
type Requester=(a:Agent|null,url:string,method?:string,body?:unknown,key?:string)=>Promise<{status:number;data:any}>;
export async function pricingScenario(pool:pg.Pool,request:Requester,admin:Agent,sales:Agent) {
 const today=day(),old=addDays(today,-1),xml=`<Envelope xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube time='${old}'>${Object.entries({USD:'1.1355',JPY:'178.41',CNY:'7.6117',GBP:'.85718',AUD:'1.6211',CAD:'1.6101',SGD:'1.5',HKD:'8.9091',CZK:'24.411',DKK:'7.4754',HUF:'366.38',PLN:'4.3653',RON:'5.2786',SEK:'11.321',CHF:'.9461',ISK:'136.80',NOK:'10.8735',TRY:'55.6398',BRL:'5.9177',INR:'108.9910'}).map(([c,r])=>`<Cube currency='${c}' rate='${r}'/>`).join('')}</Cube></Envelope>`;
 const fake=async()=>new Response(xml,{status:200});
 const now=new Date();await pool.query('UPDATE pricing_sync_config SET next_run=$1',[new Date(now.getTime()-1000)]);
 await Promise.all(Array.from({length:20},()=>createPricingWorker(pool,fake).tick(now)));
 assert.equal((await pool.query('SELECT count(*)::int n FROM pricing_sync_runs')).rows[0].n,1);
 const before=(await pool.query('SELECT last_success FROM pricing_sync_config')).rows[0].last_success;
 const snapshot=(await pool.query("SELECT id,snapshot FROM quotation_versions WHERE status IN ('issued','confirmed') ORDER BY created_at LIMIT 1")).rows[0];
 const pdf=(await pool.query('SELECT id,bytes_base64 FROM quotation_documents ORDER BY created_at LIMIT 1')).rows[0];
 await pool.query('UPDATE pricing_sync_config SET next_run=$1',[now]);await createPricingWorker(pool,fake).tick(new Date(now.getTime()+1000));
 assert.equal((await pool.query('SELECT count(*)::int n FROM pricing_fx_batches')).rows[0].n,1);assert.equal((await pool.query('SELECT last_success FROM pricing_sync_config')).rows[0].last_success.toISOString(),before.toISOString());
 await pool.query('UPDATE pricing_sync_config SET next_run=$1',[now]);await createPricingWorker(pool,async()=>new Response('',{status:503})).tick(new Date(now.getTime()+2000));
 const failed=(await request(sales,'/pricing/overview')).data;assert.ok(failed.lastError);assert.equal(failed.reference.find((r:any)=>r.currency==='USD').date,old);assert.equal((await pool.query('SELECT count(*)::int n FROM pricing_fx_batches')).rows[0].n,1);
 assert.ok((await request(admin,'/pricing/overview')).data.alerts.length);assert.equal((await request(sales,'/pricing/config','PUT',{})).status,403);
 const adminView=(await request(admin,'/pricing/overview')).data;assert.equal(adminView.config.mode,'manual');
 const adoption={version:adminView.configVersion,data:{...adminView.config,mode:'ecb_reference',bufferPct:2}};
 assert.equal((await request(admin,'/pricing/config','PUT',adoption)).status,422);
 assert.equal((await request(admin,'/pricing/config','PUT',{...adoption,acknowledgeReference:true})).status,200);
 assert.equal((await request(sales,'/pricing/overview')).data.company.find((r:any)=>r.currency==='USD').cnyPerUnit,Number((7.6117/1.1355).toFixed(10)));
 const product={kind:'product',name:'isolated-prices.csv',provider:'ISOLATED TEST COMPANY',sourceDate:old,validFrom:old,validUntil:addDays(today,20),data:Buffer.from(productHeaders.join(',')+'\n'+['ISOLATED-DAILY','隔离测试产品','Isolated product','推拉门','test','unit','12122','9911.3','11000','profile','hardware','glass','white','test pack','1','2000','1','3000'].join(',')).toString('base64')};
 const imported=await request(admin,'/pricing/imports','POST',product);assert.equal(imported.status,200);
 assert.equal((await request(admin,'/pricing/imports','POST',product)).data.id,imported.data.id);
 assert.ok(!(await request(sales,'/pricing/catalog')).data.products.some((p:any)=>p.sku==='ISOLATED-DAILY'));
 assert.equal((await request(sales,`/pricing/imports/${imported.data.id}/file`)).status,403);
 const approved=await request(admin,`/pricing/imports/${imported.data.id}/review`,'POST',{approve:true,note:'ISOLATED TEST explicit review of source and pricing'});assert.equal(approved.status,200,JSON.stringify(approved.data));
 const catalog=(await request(sales,'/pricing/catalog')).data,found=catalog.products.find((p:any)=>p.sku==='ISOLATED-DAILY');assert.equal(found.sale,12122);assert.equal(found.status,'有效');assert.ok(!JSON.stringify(catalog).includes('9911.3'));assert.ok(!JSON.stringify(catalog.products).includes('"factory"'));assert.ok(!JSON.stringify(catalog.products).includes('"minimum"'));assert.ok(catalog.freight.every((f:any)=>f.fees.every((fee:any)=>fee.rate===null&&fee.minimum===null)));
 const freight={...product,kind:'freight',name:'isolated-freight.csv',data:Buffer.from(freightHeaders.join(',')+'\n'+['FT-TEST','ISOLATED FREIGHT','TestCountry','TestCity','TestOrigin','TestPort','LCL','','USD','international','cbm','','0','main freight','tax','20','0','100','0','1000','0'].join(',')).toString('base64')};
 const fi=(await request(admin,'/pricing/imports','POST',freight)).data;
 assert.equal((await request(admin,`/pricing/imports/${fi.id}/review`,'POST',{approve:true,note:'ISOLATED TEST cannot approve unknown freight'})).status,422);
 assert.equal((await pool.query('SELECT status FROM pricing_imports WHERE id=$1',[fi.id])).rows[0].status,'pending');
 assert.deepEqual((await pool.query('SELECT snapshot FROM quotation_versions WHERE id=$1',[snapshot.id])).rows[0].snapshot,snapshot.snapshot);
 assert.deepEqual((await pool.query('SELECT bytes_base64 FROM quotation_documents WHERE id=$1',[pdf.id])).rows[0].bytes_base64,pdf.bytes_base64);
 // Explicitly verify stale drafts through the actual HTTP workflow, without editing them.
 const customer=(await pool.query('SELECT customer_id FROM quotation_projects p JOIN customers c ON c.id=p.customer_id WHERE c.owner_id=$1 LIMIT 1',[sales.user.id])).rows[0].customer_id;
 const project=(await request(sales,'/quoting/projects','POST',{customerId:customer,name:'ISOLATED price-change draft'})).data;
 const originalInput=(await pool.query('SELECT input FROM quotation_versions WHERE id=$1',[snapshot.id])).rows[0].input;
 const saved=(await request(sales,`/quoting/projects/${project.id}/versions`,'POST',{baseVersion:1,input:{...originalInput,currency:'CNY',incoterm:'EXW',freightId:null},reason:'ISOLATED pricing regression'})).data;
 assert.ok(saved.id);const draftBefore=(await request(sales,`/quoting/versions/${saved.id}`)).data;
 await pool.query('UPDATE quotation_products SET version=version+1 WHERE id=$1',[originalInput.lines[0].productId]);
 assert.ok((await request(sales,`/quoting/versions/${saved.id}`)).data.priceChanges.length);
 assert.equal((await request(sales,`/quoting/versions/${saved.id}/submit`,'POST',{version:draftBefore.version})).status,409);
 assert.deepEqual((await request(sales,`/quoting/versions/${saved.id}`)).data.snapshot,draftBefore.snapshot);
 // Expiry is rendered against original date, and never extended by a check.
 await pool.query('UPDATE pricing_sync_config SET next_run=$1',[now]);await createPricingWorker(pool,fake).tick(new Date(now.getTime()+3000));
 assert.equal((await request(sales,'/pricing/overview')).data.lastError,null);
 console.log('PASS daily pricing: 20 concurrent leases, no-change dates, retry/failure retention, alerts, manual policy preservation, explicit adoption, deduplicated imports, unknown-fee gate, cost isolation, stale-draft gate, historical quotation/PDF bytes');
}
export async function pricingUi(browser:Browser,origin:string,password:string,artifacts:string) {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/login');await page.getByLabel('邮箱',{exact:true}).fill('a@test.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('link',{name:'每日价格与运费',exact:true}).click();await expect(page.getByRole('heading',{name:'市场参考汇率',exact:true})).toBeVisible();
 await page.getByLabel('搜索价格').fill('USD');await expect(page.getByRole('cell',{name:'USD',exact:true}).first()).toBeVisible();
 await page.screenshot({path:artifacts+'/daily-prices-desktop.png',fullPage:false});
 await page.getByRole('tab',{name:'产品销售价格'}).click();await expect(page.getByRole('cell').filter({hasText:'ISOLATED-DAILY'}).first()).toBeVisible();assert.ok(!(await page.locator('body').innerText()).includes('9911.3'));
 await page.getByRole('tab',{name:'国际物流运费'}).click();await page.getByLabel('目的国家',{exact:true}).fill('NO MATCH');await expect(page.getByText('待询价：',{exact:false})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:artifacts+'/daily-prices-mobile.png',fullPage:false});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await page.close();
 console.log('PASS daily prices UI: employee login, 3 tabs, USD search, product cost hidden, unmatched freight, desktop/mobile, no runtime errors');
}
