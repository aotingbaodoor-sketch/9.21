import {Decimal} from 'decimal.js';
import type {Product, QuoteLine} from './quoting.ts';

export const MOQ_VERSION='Q-MOQ-D2';
export const doorTypes=['ENT','INT','SUB','DBL'] as const;
export const doorLabels={ENT:'入户门',INT:'室内门',SUB:'子母门',DBL:'双开门'};
const defaults={WI:1.3,ENT:2.5,SUB:3,DBL:3.5};
const doorCategories=new Set(['平开门','推拉门','折叠门','提升推拉门','转轴门','入户门','全铝室内门','铝木门','隐形门','艺术玻璃门']);
export function billingBasis(p:Product,line:QuoteLine,widthMm:number,heightMm:number){
 const actual=new Decimal(widthMm).mul(heightMm).div(1e6);
 const type=p.door_type??(['平开窗','推拉窗'].includes(p.category)?'WI':p.category==='护墙板'?'WP':null);
 const errors:string[]=[],approvals:string[]=[],warnings:string[]=[];
 let minimum:number|null=null,billed:number|null=actual.toNumber();
 if(!type&&doorCategories.has(p.category)) errors.push('门型尚未确认，请跟单员在产品主档选择ENT/INT/SUB/DBL；不得根据名称猜测或只改计价单位');
 if(type&&type in defaults){
   const required=defaults[type as keyof typeof defaults];
   minimum=Math.max(p.moq_area??required,required);
   if(p.moq_area!=null&&p.moq_area<required)errors.push(`${type}的MOQ配置低于${MOQ_VERSION}最低${required}㎡，请修正主档，不能绕过最低计费面积`);
   if(p.moq_area==null)warnings.push(`${type}缺少MOQ配置，按${MOQ_VERSION}默认${minimum}㎡/件回落；请跟单员补齐主档`);
   if(p.moq_uom&&p.moq_uom!=='㎡')errors.push('该门窗类型须按面积计费；更改单位不能代替更换SKU');
   if(!['area','area_options'].includes(p.pricing))errors.push('面积类门窗的单价单位尚未核实为元/㎡，禁止自动换算或套用樘价');
   billed=Decimal.max(actual,minimum,p.minArea).toNumber();
 }else if(type==='INT'){
   billed=null;
   // Owner confirmed per-door on 2026-10-19; an approved per-door source is still mandatory.
   if(p.moq_uom!=='樘'||!['piece','unit'].includes(p.pricing)||!p.piecePriceEvidence||p.piecePriceEvidence.trim().length<10)
     errors.push('室内门已确认按樘计价，但缺少已批准樘价表依据或单位不是元/樘；请管理员核准樘价，禁止沿用㎡单价');
   const maxH=Math.min(p.max_h_m??2.75,2.75),maxW=Math.min(p.max_w_m??1,1);
   if(new Decimal(heightMm).gt(maxH*1000)||new Decimal(widthMm).gt(maxW*1000)){
     if(!line.nonstandard)errors.push('室内门成品外框超限：请走定做审批、换SKU改子母门，或拆分多樘；不能仅改单位/增加附加费');
     else {approvals.push('超限室内门定做，必须技术及人工核价审批');if(line.unitPrice===null)errors.push('定做室内门不得自动套用P-GUIDE，请填写人工核价并审批');}
   }
 }else if(type!=='WP')billed=Decimal.max(actual,p.minArea).toNumber();
 const explanation=type==='INT'?'室内门按樘计价，不抬升面积；尺寸为成品外框':minimum!==null?`每件计费面积=max(实际面积,${minimum}㎡)；按${line.quantity}件汇总；生产尺寸不变`:'按实际尺寸及原产品计价规则，未新增面积起订限制';
 return {ruleVersion:MOQ_VERSION,type,actualArea:actual.toNumber(),billingArea:billed,pieces:line.quantity,minimumArea:minimum,totalActualArea:actual.mul(line.quantity).toNumber(),totalBillingArea:billed===null?null:new Decimal(billed).mul(line.quantity).toNumber(),explanation,errors,approvals,warnings};
}
export type BillingBasis=ReturnType<typeof billingBasis>;
