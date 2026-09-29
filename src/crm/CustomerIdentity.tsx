import {useState} from 'react';
import {useResource,useMutation} from './api.ts';
import {useSession} from './context.tsx';
import {Panel,Field,ErrorBox} from './ui.tsx';
export function CustomerIdentity({customerId}:{customerId:string}){
 const {user,revision,refresh,notify}=useSession(),m=useMutation();
 const sources=useResource<{id:string;partner_code:string;name:string}[]>('/customer-identities/sources',revision);
 const info=useResource<{status:string|null;identity:{code:string;name:string;contact_date:string}|null}>(`/customers/${customerId}/identity`,revision);
 const [partnerId,setPartner]=useState(''),[date,setDate]=useState(''),[confirmed,setConfirmed]=useState(false);
 return <Panel title="首次开发资料与永久编号">
  <ErrorBox message={sources.error||info.error||m.error}/>
  {info.data?.identity?<p>{info.data.identity.code} · 首次开发人：{info.data.identity.name} · 首次开发日：{info.data.identity.contact_date}（更换负责人不会改号）</p>:<>
   <p>资料核实后方可签发报价。来源人不是登录账号；不知道的资料请留空，不能借用他人身份。</p>
   {user.role==='admin'&&sources.data?.length===0&&<button disabled={m.busy} onClick={()=>void m.run('/customer-identities/sources/initialize','POST',{},()=>{refresh();notify('已登记交付包A001～A006来源人，未创建员工账号');})}>登记交付包中的6位来源人</button>}
   <form onSubmit={e=>{e.preventDefault();void m.run(`/customers/${customerId}/identity`,'POST',{partnerId,firstContactDate:date,confirmHistoricalInfoOnly:confirmed},()=>{refresh();notify('首次开发资料和永久编号已保存');});}}>
    <div className="form-grid"><Field label="真实首次开发人"><select required value={partnerId} onChange={e=>setPartner(e.target.value)}><option value="">请选择已核实来源人</option>{sources.data?.map(p=><option key={p.id} value={p.id}>{p.partner_code} · {p.name}</option>)}</select></Field><Field label="真实首次开发日"><input type="date" required value={date} onChange={e=>setDate(e.target.value)}/></Field></div>
    {info.data?.status===null&&user.role==='admin'&&<label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核实此历史客户仍在资料阶段，未进入后续业务</label>}
    <button disabled={m.busy||!info.data||!sources.data?.length||(info.data.status===null&&user.role!=='admin')}>核实建档并永久发号</button>
   </form></>}
 </Panel>;
}
