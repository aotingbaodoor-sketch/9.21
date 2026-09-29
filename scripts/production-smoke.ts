// Explicit isolated production acceptance. Never changes real account passwords,
// global pricing, real customer payments or WhatsApp message queues.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from '../server/domain.ts';
import {fixtures,today} from '../tests/quoting.fixtures.ts';
import {calculate,policy} from '../server/quoting/engine.ts';
const [cli,expected,python,artifactDir]=process.argv.slice(2),origin='https://921-production.up.railway.app';
if(!cli||!expected||!python||!artifactDir)throw new Error('CLI, expected commit, Python and artifact directory required');
const health=await (await fetch(origin+'/api/health')).json();assert.equal(health.version,expected,'Wrong deployed version; no test writes made');
const vars=JSON.parse(execFileSync(cli,['variable','list','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const url=new URL(vars.DATABASE_URL);for(const k of ['sslmode','sslrootcert','sslcert','sslkey'])url.searchParams.delete(k);process.env.PGPASSWORD=vars.PGPASSWORD;
const pool=new pg.Pool({connectionString:url.toString(),ssl:{ca:readFileSync('config/supabase-prod-ca.crt','utf8'),rejectUnauthorized:true},max:2,connectionTimeoutMillis:15000,statement_timeout:15000});pool.on('error',()=>{});
const adminId=randomUUID(),salesId=randomUUID(),password=randomBytes(32).toString('base64url'),prefix='isolated-'+randomUUID();
type Actor={cookie:string;csrf:string};let customerId:string|undefined,legacySo:string|undefined;
const checks:string[]=[];const pass=(s:string)=>{checks.push(s);console.log('PASS '+s);};
async function request(a:Actor|null,path:string,body?:unknown,key:string=randomUUID()){
 const r=await fetch(origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','Idempotency-Key':key,...(a?{Cookie:a.cookie,'X-CSRF-Token':a.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
 const data=r.headers.get('content-type')?.includes('application/json')?await r.json():Buffer.from(await r.arrayBuffer());return {status:r.status,data,cookie:r.headers.get('set-cookie')?.split(';')[0]||''};
}
async function ok(a:Actor|null,p:string,b?:unknown,k?:string){const r=await request(a,p,b,k);assert.equal(r.status,200,`${p}: status ${r.status}`);return r.data;}
try{
 for(const [id,role] of [[adminId,'admin'],[salesId,'sales']])await pool.query('INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)',[id,'ISOLATED DEPLOY QA '+role,prefix+'-'+role+'@test.invalid',await hashPassword(password),role]);
 const login=async(role:string):Promise<Actor>=>{const r=await request(null,'/auth/login',{email:prefix+'-'+role+'@test.invalid',password});assert.equal(r.status,200);return {cookie:r.cookie,csrf:r.data.csrf};};
 const admin=await login('admin'),sales=await login('sales');pass('public HTTPS admin and sales password login (temporary test accounts; existing account unchanged)');
 await ok(admin,'/customer-identities/sources/initialize',{});
 const sources=await ok(admin,'/customer-identities/sources');
 const customer=await ok(admin,'/customers',{company:'ISOLATED DEPLOY QA — NOT A REAL CUSTOMER',contact:'TEST ONLY',ownerId:adminId});customerId=customer.id;
 const identity=await ok(admin,`/customers/${customerId}/identity`,{partnerId:sources[0].id,firstContactDate:today,confirmHistoricalInfoOnly:false});
 assert.equal((await request(sales,`/customers/${customerId}/identity`)).status,404);pass('customer creation, verified first developer, permanent number and cross-sales isolation');
 const projectId=(await ok(admin,'/quoting/projects',{customerId,name:'ISOLATED DEPLOY QA — NOT COMMERCIAL'})).id;
 // Do not overwrite company pricing with artificial values. This prepared
 // approved fixture exercises live issue/PDF endpoints, not live pricing setup.
 const f=fixtures(),quoteId=randomUUID(),snapshot=calculate(f.input,[f.product],f.freight,f.settings,policy(f.settings,{id:adminId,role:'admin'}),today,projectId);
 assert.equal(snapshot.issues.filter(i=>i.hard).length,0);
 await pool.query("INSERT INTO quotation_versions(id,project_id,number,input,snapshot,customer_snapshot,reason,created_by,status) VALUES($1,$2,1,$3,$4,$5,'ISOLATED DEPLOY QA prepared approved fixture - not commercial',$6,'approved')",[quoteId,projectId,JSON.stringify(f.input),JSON.stringify(snapshot),JSON.stringify({company:customer.company,contact:'TEST ONLY',email:'',country:''}),adminId]);
 const key=randomUUID(),body={version:1},issued=await ok(admin,`/quoting/versions/${quoteId}/issue`,body,key);
 assert.deepEqual(await ok(admin,`/quoting/versions/${quoteId}/issue`,body,key),issued);assert.equal(issued.docNo,identity.code+'-QT001');pass('live QT issuance, persisted number and idempotent replay using isolated approved fixture');
 const docBody={kind:'quotation',language:'both'},doc=await ok(admin,`/quoting/versions/${quoteId}/documents`,docBody),pdf=await ok(admin,`/quoting/documents/${doc.id}`);
 assert.ok(Buffer.isBuffer(pdf));const same=await ok(admin,`/quoting/versions/${quoteId}/documents`,docBody);assert.equal(same.id,doc.id);
 execFileSync(python,['-c','import sys,io; from pypdf import PdfReader; text="\\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(sys.stdin.buffer.read())).pages); assert sys.argv[1] in text; print("PDF stored number verified")',issued.docNo],{input:pdf,stdio:['pipe','pipe','pipe']});
 mkdirSync(artifactDir,{recursive:true});writeFileSync(artifactDir+'/isolated-quotation.pdf',pdf);pass('live PDF text includes exact persisted QT number; repeated generation returns same stored document');
 const q=await ok(admin,`/quoting/versions/${quoteId}`),order=await ok(admin,`/quoting/versions/${quoteId}/confirm`,{version:q.version,contact:'TEST ONLY',evidence:'ISOLATED DEPLOY QA no payment or customer notification'});
 assert.equal((await pool.query('SELECT id FROM sales_orders WHERE quotation_order_id=$1',[order.id])).rowCount,0);
 assert.equal((await request(admin,`/quoting/versions/${quoteId}/sales-order`,{})).status,409);pass('customer confirmation creates no SO; unpaid SO request blocked by production API');
 // Temporary legacy unpaid order fixture for the actual PO API; remove it in finally.
 legacySo=randomUUID();await pool.query('INSERT INTO sales_orders(id,quotation_order_id,order_number,created_by,deposit_gate_required) VALUES($1,$2,$3,$4,false)',[legacySo,order.id,'ISOLATED-LEGACY-'+legacySo,adminId]);
 const blocked=await request(admin,`/supply/orders/${legacySo}/purchase-orders`,{});assert.equal(blocked.status,409);assert.match(String(blocked.data.message||blocked.data.error),/定金/);pass('unpaid legacy order PO request blocked by production API');
 const realAdmin=(await pool.query('SELECT active,role FROM users WHERE email=$1',['aotingbaodoor@gmail.com'])).rows[0];assert.equal(realAdmin.active,true);assert.equal(realAdmin.role,'admin');
 writeFileSync(artifactDir+'/results.json',JSON.stringify({version:expected,checks,limitations:['Prepared approved quote fixture: production global pricing was not replaced','Existing owner password login not tested; temporary admin password login tested','No real deposit, WhatsApp notification or paid production action']},null,2));
}catch(e){console.error('Acceptance failed safely:',(e as {code?:string}).code||'CHECK_FAILED');process.exitCode=1;}
finally{
 if(legacySo)await pool.query('DELETE FROM sales_orders WHERE id=$1 AND created_by=$2 AND order_number=$3',[legacySo,adminId,'ISOLATED-LEGACY-'+legacySo]);
 if(customerId)await pool.query('UPDATE customers SET deleted_at=now() WHERE id=$1 AND owner_id=$2',[customerId,adminId]);
 await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])',[[adminId,salesId]]);
 await pool.query('UPDATE users SET active=false WHERE id=ANY($1::uuid[])',[[adminId,salesId]]);
 await pool.end();console.log('Isolated test accounts disabled; test customer archived; issued number/audit retained; no real customer payments or outbound messages performed');
}
