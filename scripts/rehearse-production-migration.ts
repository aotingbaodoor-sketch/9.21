// Decrypt only in memory; restore into a NEW local isolated database, never production.
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,readdirSync} from 'node:fs';
import {createDecipheriv,randomBytes,createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {localPostgres} from './postgres-runtime.ts';
import {database,migrate} from '../server/db.ts';
const archive=JSON.parse(readFileSync(process.argv[2],'utf8'));
const protectedKey=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"],{input:archive.protectedKey,encoding:'utf8',stdio:['pipe','pipe','pipe']});
const key=Buffer.from(protectedKey,'base64'),decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(archive.iv,'base64'));decipher.setAuthTag(Buffer.from(archive.tag,'base64'));
const snapshot=JSON.parse(Buffer.concat([decipher.update(Buffer.from(archive.encrypted,'base64')),decipher.final()]).toString());key.fill(0);
const root=mkdtempSync(path.join(os.tmpdir(),'autinberg-production-rehearsal-')),password=randomBytes(32).toString('hex');
const local=await localPostgres({databaseDir:path.join(root,'pg'),port:55617,user:'postgres',password,persistent:true,fastIsolatedInit:true,onLog:()=>{},onError:()=>{}});
let started=false;const pool=database(`postgresql://postgres:${password}@127.0.0.1:55617/production_rehearsal`);
pool.on('error',()=>{});
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
const digest=(rows:unknown[])=>createHash('sha256').update(JSON.stringify(rows.map(r=>JSON.stringify(canonical(r))).sort())).digest('hex');
try {
 await local.initialise();await local.start();started=true;await local.createDatabase('production_rehearsal');
 const db=await pool.connect();
 try {
  await db.query("SET TIME ZONE 'UTC'");
  await db.query('BEGIN');
  await db.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT now())');
  for(const d of snapshot.definitions)await db.query(d.sql);
  // Replica mode applies ONLY to this newly-created local rehearsal database.
  await db.query("SET LOCAL session_replication_role='replica'");
  for(const table of Object.keys(snapshot.tables))await db.query(`DELETE FROM ${quote(table)}`);
  for(const [table,rows] of Object.entries(snapshot.tables) as [string,Record<string,unknown>[]][]) {
   const columns=(await db.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows;
   const json=new Set(columns.filter(c=>['jsonb','json'].includes(c.data_type)).map(c=>c.column_name));
   for(const row of rows){const keys=Object.keys(row);await db.query(`INSERT INTO ${quote(table)}(${keys.map(quote).join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,keys.map(k=>json.has(k)?JSON.stringify(row[k]):row[k]));}
  }
  await db.query('COMMIT');
  for(const [table,rows] of Object.entries(snapshot.tables) as [string,Record<string,unknown>[]][]){const actual=(await db.query(`SELECT row_to_json(t) AS row FROM ${quote(table)} t`)).rows.map(r=>r.row);if(digest(actual)!==digest(rows)){const fields=new Set<string>();for(const r of rows){const a=actual.find(x=>x.id===r.id);if(a)for(const k of Object.keys(r))if(JSON.stringify(canonical(a[k]))!==JSON.stringify(canonical(r[k])))fields.add(k);}console.log('Mismatch field names only:',table,[...fields]);}assert.equal(digest(actual),digest(rows),`Restore mismatch: ${table}`);}
  console.log('PASS encrypted snapshot restored: all previous table contents match');
 } catch(e){await db.query('ROLLBACK');throw e;} finally{db.release();}
 await migrate(pool);
 for(const [table,rows] of Object.entries(snapshot.tables) as [string,Record<string,unknown>[]][]){
  if(table==='schema_migrations')continue;
  // 020 adds exactly TC and metadata to class configuration; it never replaces historical codes.
  const added=table==='crm_document_class'&&!rows.some(r=>r.code==='TC')?1:0;
  assert.equal(Number((await pool.query(`SELECT count(*) n FROM ${quote(table)}`)).rows[0].n),rows.length+added,table);
  // Compare every original column after migration, not just row counts.
  if(rows.length){
   const cols=Object.keys(rows[0]);
   const actual=(await pool.query(`SELECT row_to_json(t) AS row FROM (SELECT ${cols.map(quote).join(',')} FROM ${quote(table)}${table==='crm_document_class'&&added?" WHERE code<>'TC'":''}) t`)).rows.map(r=>r.row);
   assert.equal(digest(actual),digest(rows),`Original columns changed: ${table}`);
  }
 }
 assert.equal((await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,readdirSync('server/migrations').filter(f=>f.endsWith('.sql')).length);
 console.log('PASS current migrations on production copy; all previous table row counts preserved; production untouched');
}catch(e){const match=(e as Error).message.match(/Restore mismatch: [a-z_]+/);console.error('Rehearsal failed:',match?.[0]||(e as {code?:string}).code||'CHECK_FAILED');process.exitCode=1;}
finally{await pool.end();if(started)await local.stop();}
