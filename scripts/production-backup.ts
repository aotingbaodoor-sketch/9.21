// Read-only, consistent snapshot. Secrets are encrypted before any file write.
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createCipheriv,createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {matchesMigrationChecksum} from '../server/migration-checksum.ts';
const [cli,destination]=process.argv.slice(2);
if(!cli||!destination)throw new Error('CLI path and backup destination required');
let pool:pg.Pool|undefined;
try {
 const vars=JSON.parse(execFileSync(cli,['variable','list','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 const url=new URL(vars.DATABASE_URL);for(const k of ['sslmode','sslrootcert','sslcert','sslkey'])url.searchParams.delete(k);
 process.env.PGPASSWORD=vars.PGPASSWORD;
 pool=new pg.Pool({connectionString:url.toString(),ssl:{ca:readFileSync(new URL('../config/supabase-prod-ca.crt',import.meta.url),'utf8'),rejectUnauthorized:true},max:1,connectionTimeoutMillis:15000,statement_timeout:30000});
 const db=await pool.connect();
 let payload;
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const migrations=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  const definitions=migrations.map(m=>{const sql=readFileSync(fileURLToPath(new URL('../server/migrations/'+m.name,import.meta.url)),'utf8');if(!matchesMigrationChecksum(sql,m.checksum))throw new Error('MIGRATION_CHECKSUM');return {name:m.name,sql};});
  const tables:Record<string,unknown[]>={};
  // PostgreSQL JSON preserves full timestamp precision and DATE values, avoiding
  // the JavaScript Date millisecond conversion during backup.
  for(const {tablename} of (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)tables[tablename]=(await db.query(`SELECT row_to_json(t) AS row FROM public."${tablename.replaceAll('"','""')}" t`)).rows.map(r=>r.row);
  payload={format:'autinberg-production-snapshot-v1',createdAt:new Date().toISOString(),definitions,tables,variables:vars,rollbackCommit:vars.APP_VERSION ?? null,rollbackDeployment:process.argv[4] ?? null};
  await db.query('ROLLBACK');
 }finally{db.release();}
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const encrypted=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
 const protectedKey=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"],{input:key.toString('base64'),encoding:'utf8',stdio:['pipe','pipe','pipe']});
 const archive=JSON.stringify({format:'aes-256-gcm-dpapi-current-user',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),protectedKey,encrypted:encrypted.toString('base64')});
 mkdirSync(path.dirname(destination),{recursive:true});writeFileSync(destination,archive,{flag:'wx'});
 console.log(JSON.stringify({backup:destination,sha256:createHash('sha256').update(archive).digest('hex'),tables:Object.keys(payload.tables).length,counts:Object.fromEntries(Object.entries(payload.tables).map(([k,v])=>[k,v.length])),migrations:payload.definitions.length}));
 key.fill(0);
}catch(e){console.error('Backup failed; no secret details emitted.',(e as {code?:string}).code||'CHECK_FAILED');process.exitCode=1;}finally{await pool?.end();}
