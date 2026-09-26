import assert from 'node:assert/strict';
import test from 'node:test';
import { orderMilestones, requireOrderTransition, requireProductionDraft, requireProductionExecution, requireProductionInstruction, type OrderEvidence } from '../server/supply/order-policy.ts';

const complete: OrderEvidence = {
  informationComplete: true, formalQuoteIssued: true, depositReceived: true,
  measurementUploaded: true, finalDimensionsConfirmed: true, productionInstructionIssued: true,
  outgoingInspectionPassed: true, shipmentRecorded: true, installationConfirmed: true,
};

test('deposit alone permits a draft but never a production instruction', () => {
  const depositOnly = Object.fromEntries(Object.keys(complete).map(key => [key, key === 'depositReceived'])) as OrderEvidence;
  assert.doesNotThrow(() => requireProductionDraft(depositOnly));
  assert.throws(() => requireProductionInstruction(depositOnly), /量尺记录已上传.*最终尺寸已确认/);
  assert.throws(() => requireProductionDraft({...complete, depositReceived: false}), /定金到账/);
});

test('each confirmed prerequisite independently prevents production when missing', () => {
  for (const key of ['informationComplete', 'formalQuoteIssued', 'depositReceived', 'measurementUploaded', 'finalDimensionsConfirmed'] as const) {
    assert.throws(() => requireProductionInstruction({...complete, [key]: false}), /缺少条件/);
    assert.throws(() => requireProductionExecution({...complete, [key]: false}), /缺少条件/);
  }
  assert.doesNotThrow(() => requireProductionInstruction({...complete, productionInstructionIssued: false}));
  assert.throws(() => requireProductionExecution({...complete, productionInstructionIssued: false}), /生产指令/);
});

test('all non-adjacent, backwards and repeated transitions fail even with all evidence', () => {
  for (let from = 0; from < orderMilestones.length; from++) {
    for (let to = 0; to < orderMilestones.length; to++) {
      const act = () => requireOrderTransition(orderMilestones[from], orderMilestones[to], complete);
      if (to === from + 1) assert.doesNotThrow(act);
      else assert.throws(act, /必须依次推进/);
    }
  }
});

test('each milestone checks cumulative evidence, not just its own fields', () => {
  const keys = Object.keys(complete) as (keyof OrderEvidence)[];
  const counts = [0, 2, 3, 5, 6, 8, 9];
  for (let next = 1; next < orderMilestones.length; next++) {
    for (let index = 0; index < keys.length; index++) {
      const evidence = {...complete, [keys[index]]: false};
      const act = () => requireOrderTransition(orderMilestones[next - 1], orderMilestones[next], evidence);
      if (index < counts[next]) assert.throws(act, /缺少条件/);
      else assert.doesNotThrow(act);
    }
  }
});
