import { useState } from 'react';
import { useMutation, useResource } from './api.ts';
import { useSession } from './context.tsx';
import { ErrorBox, Field, Loading, Panel } from './ui.tsx';
import {FulfillmentApprovers} from './Settlement.tsx';

const fields = [
  ['sla_assign_minutes','客资分配时限（分钟）'],
  ['sla_first_reply_minutes','首次人工回复时限（分钟）'],
  ['sla_quote_followup_hours','报价跟进时限（小时）'],
  ['sla_deposit_reminder_days','定金提醒时限（天）'],
  ['sla_aftersale_first_hours','售后首次响应时限（小时）'],
  ['sla_production_inquiry_days','生产询问时限（天）'],
] as const;
type Config = Record<typeof fields[number][0],number> & {escalation_after_breach:'notify_manager'|'none'};
export function WorkflowSettings() {
  const {data,error,loading}=useResource<Config>('/settings/workflow');
  if (loading) return <Loading />;
  if (!data) return <ErrorBox message={error} />;
  return <><WorkflowForm initial={data}/><FulfillmentApprovers/></>;
}
function WorkflowForm({initial}:{initial:Config}) {
  const [form,setForm]=useState(initial), mutation=useMutation(), {notify}=useSession();
  return <Panel title="工作流时限配置">
    <p>配置保存到数据库，无需重启。超时不得自动转派客户或推进业务状态。</p>
    <p className="muted">当前先保存规则配置；超时名单及 W-01～W-03 联动仍待验收。W-04～W-09 尚未启用。</p>
    <form onSubmit={e=>{e.preventDefault();void mutation.run<Config>('/settings/workflow','PUT',form,value=>{setForm(value);notify('工作流配置已保存并记录审计');});}}>
      <div className="form-grid">{fields.map(([key,label])=><Field key={key} label={label}>
        <input type="number" required min={1} step={1} value={form[key]} onChange={e=>setForm({...form,[key]:Number(e.target.value)})}/>
      </Field>)}
      <Field label="超时升级处理"><select value={form.escalation_after_breach} onChange={e=>setForm({...form,escalation_after_breach:e.target.value as Config['escalation_after_breach']})}>
        <option value="notify_manager">通知上级（不自动转派）</option><option value="none">仅列入名单</option>
      </select></Field></div>
      <ErrorBox message={mutation.error}/>
      <button className="primary" disabled={mutation.busy}>{mutation.busy?'保存中…':'保存工作流时限'}</button>
    </form>
  </Panel>;
}
