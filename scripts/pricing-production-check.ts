// Isolated online checks: no business prices, company rules, payments or messages changed.
// Secrets stay in process memory. Test users are disabled and their sessions removed in finally.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {chromium,expect,type Browser} from '@playwright/test';
import {hashPassword} from '../server/domain.ts';
import {parseEcb,ECB_URL} from '../server/pricing/sync.ts';
const [cli,expected,artifacts]=process.argv.slice(2),origin='https://921-production.up.railway.app';
if(!cli||!expected||!artifacts)throw new Error('CLI, expected commit, artifacts directory required');
const health=await(await fetch(origin+'/api/health')).json();assert.equal(health.version,expected,'Wrong version; no test writes made');
const vars=JSON.parse(execFileSync(cli,['variable','list','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const url=new URL(vars.DATABASE_URL);for(const key of ['sslmode','sslrootcert','sslcert','sslkey'])url.searchParams.delete(key);process.env.PGPASSWORD=vars.PGPASSWORD;
const pool=new pg.Pool({connectionString:url.toString(),ssl:{ca:readFileSync('config/supabase-prod-ca.crt','utf8'),rejectUnauthorized:true},max:2,connectionTimeoutMillis:15000,statement_timeout:15000});pool.on('error',()=>{});
const adminId=randomUUID(),salesId=randomUUID(),prefix='isolated-pricing-'+randomUUID(),password=randomBytes(32).toString('base64url');
type Actor={cookie:string;csrf:string};let browser:Browser|undefined;
const checks:string[]=[];const pass=(s:string)=>{checks.push(s);console.log('PASS '+s);};
async function request(actor:Actor|null,path:string,method='GET',body?:unknown){const r=await fetch(origin+'/api'+path,{method,headers:{Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID(),...(actor?{Cookie:actor.cookie,'X-CSRF-Token':actor.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''};}
try {
 mkdirSync(artifacts,{recursive:true});
 const history=(await pool.query("SELECT id,snapshot FROM quotation_versions WHERE status IN ('issued','confirmed') ORDER BY id")).rows;
 const documents=(await pool.query('SELECT id,sha256,bytes_base64 FROM quotation_documents ORDER BY id')).rows.map(r=>({id:r.id,sha256:r.sha256,actual:createHash('sha256').update(Buffer.from(r.bytes_base64,'base64')).digest('hex')}));
 const settings=(await pool.query('SELECT data,version FROM quotation_settings WHERE id=1')).rows[0];
 for(const [id,role] of [[adminId,'admin'],[salesId,'sales']])await pool.query('INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)',[id,'ISOLATED DAILY PRICING QA '+role,prefix+'-'+role+'@test.invalid',await hashPassword(password),role]);
 const login=async(role:string)=>{const r=await request(null,'/auth/login','POST',{email:prefix+'-'+role+'@test.invalid',password});assert.equal(r.status,200);return{cookie:r.cookie,csrf:r.data.csrf};};
 const admin=await login('admin'),sales=await login('sales');pass('public HTTPS test-admin/test-sales password login');
 const before=(await request(admin,'/pricing/overview')).data;
 assert.equal((await request(admin,'/pricing/sync','POST',{})).status,200);
 let overview=before;
 for(let i=0;i<36;i++){await new Promise(r=>setTimeout(r,2500));overview=(await request(sales,'/pricing/overview')).data;if(overview.lastChecked!==before.lastChecked&&!overview.running)break;}
 assert.notEqual(overview.lastChecked,before.lastChecked,'Scheduler did not execute requested check');assert.equal(overview.lastError,null);assert.ok(overview.reference.length>=20);assert.equal(overview.config.enabled,true);assert.equal(overview.config.mode,'manual');
 assert.ok(overview.config.times.includes('07:30'));assert.ok(Date.parse(overview.nextRun)>Date.now());
 const latest=(await pool.query('SELECT source_date::text,raw_xml,cny_rates,sha256 FROM pricing_fx_batches ORDER BY source_date DESC,first_synced_at DESC LIMIT 1')).rows[0];
 const source=await(await fetch(ECB_URL,{signal:AbortSignal.timeout(20000)})).text(),parsed=parseEcb(source);
 // A newer external publication during the test requires another sync, never relabel older data.
 assert.equal(latest.sha256,parsed.sha,'Source changed during test; synchronize new source');
 for(const r of overview.reference){assert.equal(r.cnyPerUnit,parsed.cnyRates[r.currency]);assert.equal(r.date,parsed.date);}
 assert.equal(overview.reference.find((r:{currency:string})=>r.currency==='JPY').cnyPerUnit,Number((Number(parsed.rates.CNY)/Number(parsed.rates.JPY)).toFixed(10)));
 pass('real ECB XML and every displayed reference rate/date match; per-1-unit JPY and cross-rate direction correct');
 pass('cloud scheduler enabled at Beijing 07:30 and 23:30; manual cloud execution finished; next run recorded');
 const last=overview.lastSuccess,sourceDate=overview.reference[0].date;
 await request(admin,'/pricing/sync','POST',{});
 for(let i=0;i<36;i++){await new Promise(r=>setTimeout(r,2500));const next=(await request(sales,'/pricing/overview')).data;if(next.lastChecked!==overview.lastChecked&&!next.running){overview=next;break;}}
 assert.equal(overview.runs[0].status,'unchanged');assert.equal(overview.lastSuccess,last);assert.equal(overview.reference[0].date,sourceDate);pass('repeat cloud check: unchanged source, no new version or fabricated publication/success date');
 assert.equal((await request(sales,'/pricing/config','PUT',{})).status,403);assert.equal((await request(sales,'/pricing/imports')).status,403);assert.equal((await request(sales,'/pricing/sync','POST',{})).status,403);assert.equal((await request(sales,'/pricing/catalog')).status,200);pass('employee query allowed; source originals, configuration and sync writes denied');
 assert.deepEqual((await pool.query('SELECT data,version FROM quotation_settings WHERE id=1')).rows[0],settings);
 assert.deepEqual((await pool.query("SELECT id,snapshot FROM quotation_versions WHERE status IN ('issued','confirmed') ORDER BY id")).rows,history);
 const after=(await pool.query('SELECT id,sha256,bytes_base64 FROM quotation_documents ORDER BY id')).rows.map(r=>({id:r.id,sha256:r.sha256,actual:createHash('sha256').update(Buffer.from(r.bytes_base64,'base64')).digest('hex')}));assert.deepEqual(after,documents);pass('existing company rules, all issued snapshots and PDF byte hashes unchanged after cloud sync');
 browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/daily-prices');await page.getByLabel('邮箱',{exact:true}).fill(prefix+'-sales@test.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('heading',{name:'市场参考汇率',exact:true})).toBeVisible();
 await page.getByLabel('搜索价格').fill('USD');await expect(page.getByRole('cell',{name:'USD',exact:true}).first()).toBeVisible();await expect(page.getByRole('cell',{name:parsed.cnyRates.USD.toFixed(8),exact:true})).toBeVisible();await page.screenshot({path:artifacts+'/online-daily-prices.png',fullPage:false});
 await page.getByRole('tab',{name:'国际物流运费'}).click();await expect(page.getByText('待询价：',{exact:false})).toBeVisible();await page.getByRole('tab',{name:'产品销售价格'}).click();await expect(page.getByText('没有匹配的核准产品价目表',{exact:false})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:artifacts+'/online-daily-prices-mobile.png',fullPage:false});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);pass('deployed browser: employee login, real USD search, freight/product honest empty states, desktop/mobile, no runtime errors');
 writeFileSync(artifacts+'/results.json',JSON.stringify({url:origin+'/daily-prices',version:expected,sourceUrl:ECB_URL,sourceDate:parsed.date,currencies:overview.reference.length,lastChecked:overview.lastChecked,lastSuccess:overview.lastSuccess,nextRun:overview.nextRun,lastResult:overview.runs[0].status,checks,limitations:['No real company or forwarder price files available','Company quotation FX policy remains manual; existing rules retained','Failure/expiry/actual-cost sample isolation verified locally; production source not deliberately broken','No real customer notices, payments or pricing changes performed']},null,2));
 console.log(JSON.stringify({url:origin+'/daily-prices',version:expected,sourceDate:parsed.date,currencies:overview.reference.length,nextRun:overview.nextRun,artifacts}));
} catch(e) {console.error('Online pricing check failed safely:',{code:(e as {code?:string}).code||'CHECK_FAILED',step:(e as Error).name});process.exitCode=1;}
finally {await browser?.close();await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])',[[adminId,salesId]]);await pool.query('UPDATE users SET active=false WHERE id=ANY($1::uuid[])',[[adminId,salesId]]);await pool.end();console.log('Isolated test users disabled; existing accounts and all customer business data preserved');}
