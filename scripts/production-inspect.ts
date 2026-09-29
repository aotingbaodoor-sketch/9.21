// Read-only production inspection. Never print environment values or raw DB errors.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import pg from 'pg';
const cli=process.argv[2];
if(!cli) throw new Error('Pass Railway CLI path');
let pool:pg.Pool|undefined;
try {
 const vars=JSON.parse(execFileSync(cli,['variable','list','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 const url=new URL(vars.DATABASE_URL);
 console.log(JSON.stringify({variableNames:Object.keys(vars).sort(),databaseHost:url.hostname,databaseUser:decodeURIComponent(url.username),databasePort:url.port,passwordInUrl:!!url.password,passwordVariablePresent:!!vars.PGPASSWORD,passwordType:typeof vars.PGPASSWORD}));
 const ssl={ca:readFileSync('config/supabase-prod-ca.crt','utf8'),rejectUnauthorized:true};
 for(const key of ['sslmode','sslrootcert','sslcert','sslkey'])url.searchParams.delete(key);
 // pg's connection-string parser overrides the config password with an empty URL
 // password. Production uses PGPASSWORD as the documented fallback instead.
 process.env.PGPASSWORD=vars.PGPASSWORD;
 pool=new pg.Pool({connectionString:url.toString(),ssl,max:1,connectionTimeoutMillis:15000,statement_timeout:15000});
 const db=await pool.connect();
 try {
  await db.query('BEGIN READ ONLY');
  const migrations=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const counts:Record<string,number>={};
  for(const {tablename} of tables)counts[tablename]=Number((await db.query(`SELECT count(*) AS n FROM public."${tablename.replaceAll('"','""')}"`)).rows[0].n);
  const admin=(await db.query('SELECT role,active FROM users WHERE lower(email)=$1',['aotingbaodoor@gmail.com'])).rows;
  console.log(JSON.stringify({migrations,counts,admin},null,2));
  await db.query('ROLLBACK');
 } finally {db.release();}
} catch(e) {const m=String((e as Error).message);console.error('Production inspection failed safely:',{code:(e as {code?:string}).code||'CHECK_CONNECTION',timeout:/timeout|timed out/i.test(m),certificate:/certificate|self.signed/i.test(m),authentication:/password authentication|SASL/i.test(m),nonStringPassword:/password must be a string/.test(m),serverSignature:/server signature/.test(m),name:(e as Error).name});process.exitCode=1;}
finally {await pool?.end();}
