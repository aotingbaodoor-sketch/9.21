import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {Server} from 'node:http';
import {localPostgres} from '../scripts/postgres-runtime.ts';
import {database,migrate} from '../server/db.ts';
import {hashPassword} from '../server/domain.ts';
import {createApp} from '../server/app.ts';
const root=mkdtempSync(path.join(os.tmpdir(),'autinberg-identity-')),password=randomBytes(32).toString('hex');
const local=await localPostgres({databaseDir:path.join(root,'pg'),port:55618,user:'postgres',password,persistent:true,onLog:()=>{},onError:()=>{}});
const pool=database(`postgresql://postgres:${password}@127.0.0.1:55618/identity_test`);let server:Server|undefined,started=false;
type Actor={cookie:string;csrf:string};const origin='http://127.0.0.1:4618';
async function request(actor:Actor|null,url:string,body?:unknown,key=randomUUID()){
 const r=await fetch(origin+'/api'+url,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','Idempotency-Key':key,...(actor?{Cookie:actor.cookie,'X-CSRF-Token':actor.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''};
}
try{
 await local.initialise();await local.start();started=true;await local.createDatabase('identity_test');await migrate(pool);
 for(const role of ['admin','sales'])await pool.query('INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$2)',[randomUUID(),role,role+'@identity.test',await hashPassword(password)]);
 server=createApp(pool,{origin}).listen(4618,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));
 const a=await request(null,'/auth/login',{email:'admin@identity.test',password}),s=await request(null,'/auth/login',{email:'sales@identity.test',password});
 const admin={cookie:a.cookie,csrf:a.data.csrf},sales={cookie:s.cookie,csrf:s.data.csrf};
 assert.equal((await request(sales,'/customer-identities/sources/initialize',{})).status,403);
 const key=randomUUID();assert.equal((await request(admin,'/customer-identities/sources/initialize',{},key)).status,200);assert.equal((await request(admin,'/customer-identities/sources/initialize',{},key)).status,200);
 const sources=(await request(admin,'/customer-identities/sources')).data;assert.equal(sources.length,6);
 assert.equal((await pool.query('SELECT count(*)::int n FROM users')).rows[0].n,2);
 const c=await request(admin,'/customers',{company:'ISOLATED identity test'});assert.equal(c.status,200);
 const input={partnerId:sources[0].id,firstContactDate:'2026-09-22',confirmHistoricalInfoOnly:false};
 assert.equal((await request(sales,`/customers/${c.data.id}/identity`,input)).status,404);
 const k=randomUUID(),first=await request(admin,`/customers/${c.data.id}/identity`,input,k);assert.equal(first.status,200);assert.equal(first.data.code,'A001260922001');
 assert.deepEqual((await request(admin,`/customers/${c.data.id}/identity`,input,k)).data,first.data);
 assert.equal((await request(admin,`/customers/${c.data.id}/identity`,{...input,firstContactDate:'2026-09-21'})).status,409);
 assert.equal((await pool.query('SELECT count(*)::int n FROM crm_customer_code_ledger')).rows[0].n,1);
 assert.equal((await request(admin,`/customers/${c.data.id}/identity`)).data.identity.name,'潘总');
 console.log('PASS actual identity HTTP: source-only partners, no employee creation, sales isolation, permanent first developer/date, 13-digit number, duplicate request and immutable identity');
}finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));await pool.end();if(started)await local.stop();}
