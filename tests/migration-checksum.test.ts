import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {migrationChecksum,matchesMigrationChecksum} from '../server/migration-checksum.ts';
test('only line endings are interchangeable, never SQL changes',()=>{
 const lf="SELECT 1;\nSELECT '中文';\n",crlf=lf.replaceAll('\n','\r\n');
 assert.equal(migrationChecksum(lf),migrationChecksum(crlf));
 for(const sql of [lf,crlf])for(const stored of [lf,crlf])assert.equal(matchesMigrationChecksum(sql,createHash('sha256').update(stored).digest('hex')),true);
 assert.equal(matchesMigrationChecksum(lf.replace('SELECT 1','SELECT 2'),migrationChecksum(lf)),false);
 assert.equal(matchesMigrationChecksum(lf+'-- edit',migrationChecksum(lf)),false);
});
