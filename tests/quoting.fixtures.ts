import { randomUUID } from "node:crypto";
import { productSchema, freightSchema, quotationSettingsSchema, quoteInputSchema, lineSchema } from "../shared/quoting.ts";
// Artificial values ONLY for isolated test databases. Never imported into business data.
export const today = new Date().toISOString().slice(0,10);
export const future = new Date(Date.now()+90*864e5).toISOString().slice(0,10);
export function fixtures(){
 const product={...productSchema.parse({sku:"TEST-SLIDE",nameZh:"测试推拉门",nameEn:"TEST ONLY Sliding door",category:"推拉门",drawing:"sliding",prices:{factory:180,internal:200,guide:300,minimum:250,retail:400,special:280},priceValidUntil:future,standardSpecs:{glass:"TEST tempered glass"},packing:{configured:true,type:"TEST wooden crate",widthAllowanceMm:100,heightAllowanceMm:100,depthMm:120,unitsPerPackage:1,kgPerSqm:20,fixedKg:0,tareKg:5,costPerPackage:100,salePerPackage:140}}),id:randomUUID(),version:1};
 const settings=quotationSettingsSchema.parse({configured:true,companyZh:"测试奥汀堡公司（非商业报价）",companyEn:"AUTINBERG TEST ONLY",address:"TEST address, Foshan",contact:"test@example.invalid",minMarginPct:20,defaultPolicy:{maxDiscountPct:5,minMarginPct:20},fx:{USD:{cnyPerUnit:7.2,date:today,validUntil:future,source:"ISOLATED TEST FIXTURE, NOT LIVE FX",bufferPct:0}},termsEn:"TEST ONLY. Not a commercial offer.",termsZh:"仅供自动化测试，不是商业报价。"});
 const freight={...freightSchema.parse({name:"TEST Foshan Dubai",country:"UAE",city:"Dubai",originPort:"Shenzhen",destinationPort:"Jebel Ali",mode:"LCL",currency:"CNY",validFrom:today,validUntil:future,confirmed:["domestic","export","international"],fees:[{kind:"domestic",basis:"fixed",rate:70},{kind:"export",basis:"fixed",rate:140},{kind:"international",basis:"cbm",rate:50}]}),id:randomUUID(),version:1};
 const input=quoteInputSchema.parse({name:"TEST Dubai villa",country:"UAE",city:"Dubai",projectAddress:"TEST villa",deliveryAddress:"TEST Dubai address",currency:"USD",incoterm:"CFR",namedPlace:"Jebel Ali",originPort:"Shenzhen",destinationPort:"Jebel Ali",targetDate:future,validUntil:future,paymentTerms:"TEST ONLY payment terms",freightId:freight.id,lines:[lineSchema.parse({key:randomUUID(),productId:product.id,width:2000,height:2400,quantity:3,specs:product.standardSpecs})]});
 return{product,settings,freight,input};
}
