import { useState } from "react";
import { freightSchema, productSchema, quotationSettingsSchema, categories, methods } from "../../shared/quoting.ts";
import type { Freight, Product, QuotationSettings } from "../../shared/quoting.ts";
import { useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Field, Loading, Panel } from "./ui.tsx";
const today = () => new Date().toISOString().slice(0,10);
export function QuoteAdmin({mode}:{mode:"products"|"freight"|"settings"}) {
  const {user,revision,refresh,notify}=useSession();
  const resource=useResource<unknown>(`/quoting/${mode}`,revision),m=useMutation();
  const [editing,setEditing]=useState<string|null>(null),[raw,setRaw]=useState(""),[error,setError]=useState("");
  if((mode!=="freight" && user.role!=="admin") || (mode==="freight" && !["admin","logistics"].includes(user.role))) return <ErrorBox message="无维护权限"/>;
  if(resource.loading) return <Loading/>;
  if(!resource.data) return <ErrorBox message={resource.error}/>;
  const settings=mode==="settings"? resource.data as {data:QuotationSettings;version:number}:null;
  const records=mode!=="settings"?resource.data as (Product|Freight)[]:[];
  const start=(r?:Product|Freight)=>{
    setEditing(r?.id||"new");setError("");
    const blank=mode==="products"?productSchema.parse({sku:"",nameZh:"未命名产品",nameEn:"Unnamed product",category:"推拉门",active:false}):mode==="freight"?freightSchema.parse({name:"新运价（待配置）",country:"待确认",currency:"CNY",validFrom:today(),validUntil:today(),active:false,fees:[]}):settings?.data;
    setRaw(JSON.stringify(r||blank,null,2));
  };
  const save=()=>{
    try {
      const value=JSON.parse(raw); const parsed=mode==="products"?productSchema.parse(value):mode==="freight"?freightSchema.parse(value):quotationSettingsSchema.parse(value);
      setError("");void m.run(`/quoting/${mode}${mode!=="settings" && editing!=="new"?`/${editing}`:""}`,mode==="settings"||editing!=="new"?"PUT":"POST",mode==="settings"?{data:parsed,version:settings!.version}:{...parsed,version:value.version},()=>{setEditing(null);refresh();notify("已保存，旧报价快照不会改变");});
    }catch(e){setError((e as Error).message);}
  };
  const title=mode==="products"?"产品库与计价规则":mode==="freight"?"海外运价库":"公司报价规则、汇率与权限";
  let parsed: Record<string,unknown>|null=null;try{parsed=JSON.parse(raw);}catch{/* Keep invalid JSON visible for correction. */}
  const field=(key:string,value:unknown)=>{if(parsed)setRaw(JSON.stringify({...parsed,[key]:value},null,2));};
  return <Panel title={title}><p className="quote-help">规则只影响新建报价版本。价格统一以人民币配置，汇率为“1 外币 = 多少人民币”。null 表示未核实，0 表示明确确认免费；不得用 0 代替未知费用。所有修改有版本冲突检查和审计记录。</p><p><a href="/quoting-guide.html" target="_blank" rel="noreferrer">查看字段、计价、运费及权限配置说明</a></p>{editing===null?<><button className="primary" onClick={()=>{if(mode==="settings"){setEditing("settings");setRaw(JSON.stringify(settings!.data,null,2));}else if(mode==="products"){setEditing("new");setRaw(JSON.stringify(productSchema.parse({sku:"NEW-SKU",nameZh:"未命名产品",nameEn:"Unnamed product",category:"推拉门",active:false}),null,2));}else start();}}>{mode==="settings"?"编辑规则 / 汇率 / 权限":"新增"}</button>{mode==="settings"?<p>{settings!.data.configured?"公司规则已确认":"尚未确认公司规则，不能正式发布报价。"} · 版本 {settings!.version}</p>:<div className="quote-projects">{records.map(r=><div className="quote-project" key={r.id}><b>{"sku"in r?`${r.sku} · ${r.nameZh}`:r.name}</b><small>{r.active?"启用":"停用"} · 版本 {r.version}</small><button onClick={()=>{setEditing(r.id);setRaw(JSON.stringify(r,null,2));setError("");}}>编辑 / 停用</button></div>)}</div>}</>:<><fieldset disabled={m.busy} className="quote-fieldset">{parsed&&mode==="products"&&<div className="form-grid">{[["sku","SKU"],["nameZh","中文名称"],["nameEn","英文名称"],["series","系列"]].map(([k,l])=><Field key={k} label={l}><input value={String(parsed![k]||"")} onChange={e=>field(k,e.target.value)}/></Field>)}<Field label="品类"><select value={String(parsed.category)} onChange={e=>field("category",e.target.value)}>{categories.map(c=><option key={c}>{c}</option>)}</select></Field><Field label="计价方式"><select value={String(parsed.pricing)} onChange={e=>field("pricing",e.target.value)}>{methods.map(c=><option key={c}>{c}</option>)}</select></Field></div>}<Field label="完整配置（JSON；详细字段见上方说明）"><textarea className="quote-json" value={raw} onChange={e=>setRaw(e.target.value)} spellCheck={false}/></Field><p className="quote-help">产品：prices 六层价格、options 加价选项、packing 包装规则、formula 受限构成公式。运价：fees 分项费用、confirmed 已核实范围。公司：fx 汇率、policies 员工授权、合同条款和银行信息。停用请将 active 改为 false；不会删除历史报价。</p><div className="actions"><button className="primary" onClick={save}>校验并保存配置</button><button onClick={()=>setEditing(null)}>取消</button></div></fieldset><ErrorBox message={error||m.error}/></>}</Panel>;
}
