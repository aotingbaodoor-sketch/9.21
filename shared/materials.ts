import {z} from 'zod';
const text=z.string().trim().min(1).max(200),money=z.number().finite().min(0).max(1e9);
export const costSource=z.object({sourceDate:z.iso.date(),validFrom:z.iso.date(),validUntil:z.iso.date(),provider:text,evidence:z.url().startsWith('https://')});
export const materialSchema=costSource.extend({factoryId:z.uuid(),supplierCode:text,name:text,specification:z.string().trim().min(1).max(2000),unit:z.enum(['piece','set','kg','m','sqm']),currency:z.string().regex(/^[A-Z]{3}$/),cost:money}).superRefine((r,c)=>{if(r.validFrom>r.validUntil)c.addIssue({code:'custom',message:'生效日期晚于有效期'});});
export type Material=z.infer<typeof materialSchema> & {id:string;series_id:string;version:number;is_current:boolean};
export const materialReference=z.object({id:z.uuid(),version:z.number().int().positive(),name:text,currency:z.string(),unit:z.string(),coefficient:z.number().positive(),cost:money,cnyPerUnit:z.number().positive(),sourceDate:z.iso.date(),validFrom:z.iso.date(),validUntil:z.iso.date(),fx:z.object({cnyPerUnit:z.number().positive(),date:z.iso.date(),validUntil:z.iso.date(),source:z.string(),bufferPct:z.number()}).nullable()});
