import { HttpError } from '../domain.ts';

// Business milestones are independent of the legacy factory fulfillment status.
// Evidence is loaded by the server, never accepted as booleans from a request.
export const orderMilestones = ['资料', '已报价', '已收定金', '已量尺', '生产中', '已发货', '已安装/完结'] as const;
export type OrderMilestone = (typeof orderMilestones)[number];
export type OrderEvidence = {
  informationComplete: boolean;
  formalQuoteIssued: boolean;
  depositReceived: boolean;
  measurementUploaded: boolean;
  finalDimensionsConfirmed: boolean;
  productionInstructionIssued: boolean;
  outgoingInspectionPassed: boolean;
  shipmentRecorded: boolean;
  installationConfirmed: boolean;
};

const requirements: readonly (readonly [keyof OrderEvidence, string])[] = [
  ['informationComplete', '资料完整'],
  ['formalQuoteIssued', '正式报价已生成'],
  ['depositReceived', '定金到账'],
  ['measurementUploaded', '量尺记录已上传'],
  ['finalDimensionsConfirmed', '最终尺寸已确认'],
  ['productionInstructionIssued', '生产指令已正式下达'],
  ['outgoingInspectionPassed', '出货检验通过'],
  ['shipmentRecorded', '发货信息已登记'],
  ['installationConfirmed', '安装已确认'],
];
const evidenceCount = [0, 2, 3, 5, 6, 8, 9] as const;

function requireEvidence(evidence: OrderEvidence, fields: readonly (readonly [keyof OrderEvidence, string])[]) {
  const missing = fields.filter(([field]) => evidence[field] !== true).map(([, label]) => label);
  if (missing.length) throw new HttpError(409, `缺少条件：${missing.join('、')}`);
}

export function requireProductionDraft(evidence: OrderEvidence) {
  requireEvidence(evidence, requirements.slice(2, 3));
}

// Called before creating an immutable instruction, not after factory feedback.
export function requireProductionInstruction(evidence: OrderEvidence) {
  requireEvidence(evidence, requirements.slice(0, 5));
}

export function requireProductionExecution(evidence: OrderEvidence) {
  requireEvidence(evidence, requirements.slice(0, 6));
}

export function requireOrderTransition(from: OrderMilestone, to: OrderMilestone, evidence: OrderEvidence) {
  const previous = orderMilestones.indexOf(from), next = orderMilestones.indexOf(to);
  if (previous < 0 || next !== previous + 1)
    throw new HttpError(409, '订单必须依次推进，不能跳过、回退或重复变更状态');
  requireEvidence(evidence, requirements.slice(0, evidenceCount[next]));
}
