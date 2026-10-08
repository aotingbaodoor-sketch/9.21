import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useResource } from './api.ts';
import { useSession } from './context.tsx';
import { ErrorBox, Field, Loading } from './ui.tsx';
import { FileChoice } from './Settlement.tsx';
type Attachment={id:string;name:string};
type Props={order:any;files:Attachment[];logistics:any[]};
const duties:Record<string,string>={finance:'财务核验',cs:'客户关系确认',scm:'供应链关闭审批'};
function EvidenceForm({title,fields,files,submit,busy,label='保存事实记录'}:{title:string;fields:{key:string;label:string;type?:string;options?:[string,string][]}[];files:Attachment[];submit:(v:Record<string,string>)=>void;busy:boolean;label?:string}){
 const [form,setForm]=useState<Record<string,string>>({});
 const set=(key:string,value:string)=>setForm(v=>({...v,[key]:value}));
 return <details><summary>{title}</summary><form onSubmit={e=>{e.preventDefault();submit(form);}}>{fields.map(f=>f.type==='file'?<FileChoice key={f.key} label={f.label} files={files} value={form[f.key]||''} onChange={v=>set(f.key,v)}/>:<Field key={f.key} label={f.label}>{f.options?<select required value={form[f.key]||''} onChange={e=>set(f.key,e.target.value)}><option value="">请选择</option>{f.options.map(([v,l])=><option value={v} key={v}>{l}</option>)}</select>:f.type==='textarea'?<textarea required minLength={2} maxLength={2000} value={form[f.key]||''} onChange={e=>set(f.key,e.target.value)}/>:<input required type={f.type||'text'} minLength={f.type?undefined:2} maxLength={2000} value={form[f.key]||''} onChange={e=>set(f.key,e.target.value)}/>}</Field>)}<button disabled={busy}>{label}</button></form></details>;
}
export default function Completion({order:w,files,logistics}:Props){
 const {revision,refresh,user,notify}=useSession(),r=useResource<any>(`/supply/chain/${w.id}/completion`,revision),m=useMutation();
 const [podSource,setPodSource]=useState(''),[podFile,setPodFile]=useState('');
 const [uploading,setUploading]=useState(false),[uploadError,setUploadError]=useState('');
 const run=(path:string,body:unknown)=>void m.run(`/supply/chain/${w.id}${path}`,'POST',body,()=>{notify('已保存并记录审计');refresh();});
 async function upload(file:File){
  setUploadError('');setUploading(true);
  try{
   if(file.size>2e6)throw new Error('附件须小于2MB，请压缩扫描件后上传');
   let binary='';for(const byte of new Uint8Array(await file.arrayBuffer()))binary+=String.fromCharCode(byte);
   await m.run<{id:string}>(`/quoting/projects/${w.project_id}/files`,'POST',{name:file.name,mime:file.type,data:btoa(binary),kind:'reference'},()=>{notify('凭证已保存，请选择后登记');refresh();});
  }catch(e){setUploadError(e instanceof Error?e.message:'上传失败');}finally{setUploading(false);}
 }
 if(r.loading)return <Loading/>;
 if(!r.data)return <ErrorBox message={r.error}/>;
 const d=r.data;
 const proof={key:'fileId',label:'本项目事实凭证',type:'file'};
 return <section className="card" id="completion">
  <h2>签收、验收、质保与关闭</h2>
  <p>工单 {w.doc_no} · 客户编号 {w.customer_code}。按实际凭证逐步完成；过期不会自动代表客户验收。</p>
  <ErrorBox message={m.error||uploadError}/>
  <Field label="上传POD、验收或售后凭证（PDF/PNG/JPG，2MB）"><input type="file" accept="application/pdf,image/png,image/jpeg" disabled={m.busy||uploading} onChange={e=>{const f=e.target.files?.[0];if(f)void upload(f);e.target.value='';}}/></Field>
  <details><summary>登记客户签收单 POD 回传</summary><form onSubmit={e=>{e.preventDefault();run('/logistics',{docType:'pod',fileId:podFile,sourceName:podSource,receivedOn:new Date().toISOString(),externalNo:''});}}>
   <FileChoice label="已上传的POD文件" files={files} value={podFile} onChange={setPodFile}/><Field label="POD实际提供方"><input required value={podSource} onChange={e=>setPodSource(e.target.value)}/></Field><button disabled={m.busy}>保存POD，待管理员核对</button><p>请管理员在下方“物流回传件”核对一致后，再登记签收。</p>
  </form></details>
  {d.delivery?<p>实际签收：{d.delivery.delivered_on} · 签收人：{d.delivery.signed_by} · 异议期限：{d.delivery.objection_deadline} · 提单：{d.delivery.bl_no}</p>:w.current_stage==='balance_settled'?<EvidenceForm title="19 · 登记客户实际签收" files={files} busy={m.busy} label="核实POD并确认签收" fields={[
   {key:'podDocumentId',label:'已核对的POD',options:logistics.filter(l=>l.doc_type==='pod'&&l.check_result==='matched').map(l=>[l.id,l.source_name+' · '+l.received_on])},
   {key:'arrivalOn',label:'实际到港日期',type:'date'},{key:'deliveredOn',label:'实际签收日期',type:'date'},
   {key:'signedBy',label:'客户或指定收货人签名'},{key:'containerNo',label:'集装箱号'},
   {key:'packageCondition',label:'包装状况',options:[['intact','完好'],['damaged','破损（必须附凭证）']]},
   {key:'damageFileId',label:'现场/包装核实凭证',type:'file'},
  ]} submit={v=>run('/delivery',v)}/>:<p>签收入口将在“尾款结清”节点核实完成后开放；当前为 {w.current_stage}。</p>}
  {d.acceptance.map((a:any)=><p key={a.id}>验收 {a.occurred_on}：{a.result==='accepted'?'合格':'有异议'} · {a.note}</p>)}
  {w.current_stage==='delivered'&&<EvidenceForm title="20 · 填写客户开箱验收结果" files={files} busy={m.busy} fields={[
   {key:'result',label:'开箱验收结论',options:[['accepted','合格，无异议'],['objection','有异议，建立售后事项']]},
   {key:'occurredOn',label:'实际验收日期',type:'date'},{key:'note',label:'客户验收意见',type:'textarea'},proof,
  ]} submit={v=>run('/acceptance',v)}/>}
  {d.warranty?<><p>供应商内部质保起算日：{d.warranty.from}（仅取实际签收日，不对客户承诺固定期限）</p>{d.warranty.supplierSnapshot?.map((t:any,i:number)=><p key={i}>{t.part}：{t.from}—{t.until}（供应商追责参考）</p>)}</>:w.current_stage==='accepted'&&<button disabled={m.busy} onClick={()=>run('/warranty',{confirmDeliveryAnchor:true})}>21 · 核实签收日并起算内部质保</button>}
  <div id="aftersales"><h3>关联售后与安装回访</h3>
   <EvidenceForm title="登记投诉或售后事项" files={files} busy={m.busy} fields={[{key:'category',label:'问题类别'},{key:'description',label:'实际问题描述',type:'textarea'},{key:'responsibleParty',label:'责任方（未核实请填待核实）'},proof]} submit={v=>run('/after-sales',v)}/>
   {d.cases.map((c:any)=><div key={c.id}><p>{c.doc_no} · {c.category} · {c.confirmed_at?'已处理':'未结'} · {c.description}</p>{c.confirmed_at?<p>处理：{c.action}；客户回访：{c.followup}</p>:<EvidenceForm title={`处理售后 ${c.doc_no}`} files={files} busy={m.busy} fields={[{key:'action',label:'实际处理措施',type:'textarea'},{key:'followup',label:'客户确认与回访结果',type:'textarea'},proof]} submit={v=>run(`/after-sales/${c.id}/resolve`,v)}/>}</div>)}
   {d.delivery&&<EvidenceForm title="登记安装指导与回访" files={files} busy={m.busy} fields={[{key:'visitedOn',label:'回访日期',type:'date'},{key:'installationSupport',label:'安装支持',options:[['remote','已提供远程指导'],['onsite','已派员'],['not_needed','经确认不需要']]},{key:'result',label:'实际回访结果与满意度',type:'textarea'},proof]} submit={v=>run('/visit',v)}/>}
   {d.visits.map((v:any)=><p key={v.id}>{v.visited_on} · {v.result}</p>)}
  </div>
  <div id="close-confirmations"><h3>22 · 工单关闭核验</h3>
   {d.closed?<p>已于 {new Date(d.closed.closed_at).toLocaleString()} 关闭。原凭证和编号永久保留；新增售后仍可关联此工单。</p>:<>
    {d.missingDuties.length>0&&<p className="notice">尚未指定：{d.missingDuties.map((k:string)=>duties[k]).join('、')}。{user.role==='admin'&&<Link to="/settings">配置岗位职责</Link>}</p>}
    {d.blockers.map((b:any)=><p key={b.reason}><a href={b.href}>{b.reason} → 处理入口</a></p>)}
    <p>退税单证条件④：{d.taxEnabled?'需已移交财务的凭证':'不适用（服务器配置未启用出口退税）'}。</p>
    {w.current_stage==='warranty_started'&&Object.entries(d.canConfirm).filter(([,can])=>can).map(([kind])=><EvidenceForm key={kind} title={`${duties[kind]}签认`} files={files} busy={m.busy} fields={[proof,{key:'note',label:`${duties[kind]}意见`,type:'textarea'}]} submit={v=>run('/close-confirmation',{...v,kind})}/>)}
    {d.canConfirm.scm&&w.current_stage==='warranty_started'&&<EvidenceForm title="核实四项条件并关闭工单" files={files} busy={m.busy||d.blockers.length>0} fields={d.taxEnabled?[{key:'taxDocsFileId',label:'退税单证移交凭证',type:'file'}]:[]} label="关闭工单（保留全部历史）" submit={v=>run('/close',{taxDocsFileId:v.taxDocsFileId||null})}/>}
   </>}
  </div>
 </section>;
}
