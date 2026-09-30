import {z} from 'zod';
import {dateSchema} from './contracts.ts';
export const pricingConfigSchema=z.object({
 enabled:z.boolean(), times:z.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)).min(1).max(4),
 referenceDays:z.number().int().min(1).max(14), mode:z.enum(['manual','ecb_reference']),
 currencies:z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(35),bufferPct:z.number().min(0).max(20),
});
export type PricingConfig=z.infer<typeof pricingConfigSchema>;
export const provenanceSchema=z.object({
 provider:z.string().trim().min(1).max(200), sourceDate:dateSchema, validFrom:dateSchema,
 importedAt:z.iso.datetime(), importId:z.uuid(), method:z.literal('manual_import'),
 approvedAt:z.iso.datetime(), note:z.string().max(1000),
});
export const freightLimitsSchema=z.object({minCbm:z.number().min(0).nullable(),maxCbm:z.number().positive().nullable(),minKg:z.number().min(0).nullable(),maxKg:z.number().positive().nullable()});
export type PriceBasis={settingsVersion:number;fx:Record<string,unknown>;productVersions:Record<string,number>;freightVersion:number|null;fxBatchId:string|null;policyVersion:number};
export const feeNames:Record<string,string>={domestic:'国内段',export:'出口港杂',international:'主运费',insurance:'保险',destination:'目的港杂',customs:'清关',duty:'税费',delivery:'派送',other:'其他附加费'};
export const unitNames:Record<string,string>={fixed:'每票',cbm:'每立方米',kg:'每公斤',chargeableKg:'每计费公斤',container:'每柜',area:'每平方米',area_options:'每平方米＋选项',linear:'每米',piece:'每件',unit:'每樘',set:'每套',fixed_product:'固定价',range:'面积分档',material:'材料组合',composite:'组合配置'};
