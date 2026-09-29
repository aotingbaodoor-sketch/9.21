import {createHash} from 'node:crypto';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export const migrationChecksum=(sql:string)=>hash(sql.replace(/\r\n/g,'\n'));
export function matchesMigrationChecksum(sql:string,stored:string){
 const lf=sql.replace(/\r\n/g,'\n');
 return [hash(sql),hash(lf),hash(lf.replace(/\n/g,'\r\n'))].includes(stored);
}
