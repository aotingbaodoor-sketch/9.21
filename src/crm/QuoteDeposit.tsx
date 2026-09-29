import {useState} from 'react';
import {useMutation} from './api.ts';
import {useSession} from './context.tsx';
import {ErrorBox,Field,Panel} from './ui.tsx';
import {Link} from 'react-router-dom';
export function QuoteDeposit({quote}:{quote:{id:string;payment?:{doc_no:string}|null;salesOrder?:{id:string;order_number:string}|null}}) {
 const {user,refresh,notify}=useSession(), m=useMutation();
 const [amount,setAmount]=useState(''),[currency,setCurrency]=useState(''),[received,setReceived]=useState(''),[reference,setReference]=useState('');
 return <Panel title="确认、定金与销售订单">
  <p>客户确认只记录采购意向，不代表付款，也不会自动生成SO或生产指令。</p>
  {quote.payment ? <p>已登记定金收款单：{quote.payment.doc_no}</p> : <p role="status">未登记定金：SO、PO禁止开立。</p>}
  {!quote.payment && user.role==='admin' && <form onSubmit={e=>{e.preventDefault();void m.run(`/quoting/versions/${quote.id}/deposit`,'POST',{kind:'deposit',amount:Number(amount),currency,receivedAt:new Date(received).toISOString(),reference},()=>{refresh();notify('定金到账记录已保存');});}}>
   <div className="form-grid"><Field label="实际到账金额"><input type="number" min="0.01" step="0.01" required value={amount} onChange={e=>setAmount(e.target.value)}/></Field>
   <Field label="到账币种"><input required pattern="[A-Z]{3}" placeholder="例如 CNY" value={currency} onChange={e=>setCurrency(e.target.value.toUpperCase())}/></Field>
   <Field label="实际到账时间"><input type="datetime-local" required value={received} onChange={e=>setReceived(e.target.value)}/></Field>
   <Field label="到账核实凭据"><textarea required minLength={2} maxLength={2000} value={reference} onChange={e=>setReference(e.target.value)}/></Field></div>
   <button disabled={m.busy}>登记已核实定金到账</button>
  </form>}
  {quote.salesOrder ? <p>销售订单：{quote.salesOrder.order_number} · <Link to="/supply">进入订单供应链</Link></p> : user.role==='admin' ? <button className="primary" disabled={!quote.payment||m.busy} onClick={()=>void m.run(`/quoting/versions/${quote.id}/sales-order`,'POST',{},()=>{refresh();notify('SO已开立；尚未下达生产指令');})}>定金已到账，开立SO</button> : <p>由管理员核实定金后开立SO。</p>}
  <p className="muted">投产仍必须具备：定金到账、量尺记录、最终尺寸确认及生产指令。</p><ErrorBox message={m.error}/>
 </Panel>;
}
