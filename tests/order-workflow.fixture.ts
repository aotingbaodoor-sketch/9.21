// Existing fulfillment regression scenarios must now prepare actual server evidence.
// This helper is test-only; never run it against production orders.
export async function prepareTestProduction<A>(
  ok: (actor: A, path: string, method: string, body: unknown) => Promise<any>,
  actor: A,
  orderId: string,
  projectId: string,
  items: { id: string }[],
) {
  const endpoint = `/supply/orders/${orderId}/evidence`;
  await ok(actor, endpoint, "POST", {
    kind: "deposit",
    amount: 10,
    currency: "USD",
    receivedAt: new Date().toISOString(),
    reference: "ISOLATED TEST deposit",
  });
  const file = await ok(actor, `/quoting/projects/${projectId}/files`, "POST", {
    name: "TEST measurement.pdf",
    mime: "application/pdf",
    data: Buffer.from("%PDF-1.4\nTEST ONLY").toString("base64"),
    kind: "technical",
  });
  const measurement = await ok(actor, endpoint, "POST", {
    kind: "measurement",
    fileId: file.id,
    note: "ISOLATED TEST measured",
  });
  await ok(actor, endpoint, "POST", {
    kind: "dimensions",
    measurementId: measurement.id,
    lines: items.map((i) => ({ itemId: i.id, widthMm: 1000, heightMm: 2000 })),
    note: "ISOLATED TEST confirmed",
  });
  const wo=await ok(actor,'/supply/chain','POST',{salesOrderId:orderId,expectedDelivery:'2027-01-30',confirmationFileId:file.id,orderType:'bulk',tradeTerm:'FOB'});
  return {workOrderId:wo.id,fileId:file.id};
}
export async function startTestProduction<A>(ok:(actor:A,path:string,method:string,body:unknown)=>Promise<any>,actor:A,orderId:string,work:{workOrderId:string;fileId:string},purchaseOrderId:string){
 await ok(actor,`/supply/chain/${work.workOrderId}/manufacturing`,'POST',{purchaseOrderId,technical:{profile:'6063-T5 approved',glass:'5+12A+5',hardware:'Approved sample H1',finish:'RAL 9016',sampleReference:'Signed sample S1',packing:'Timber crate',requiredDate:'2027-01-30'}});
 await ok(actor,`/supply/chain/${work.workOrderId}/advance`,'POST',{stage:'material_ready',fileId:work.fileId,inspectionResult:'passed',note:'ISOLATED approved IQC'});
 await ok(actor,`/supply/orders/${orderId}/evidence`,'POST',{kind:'instruction',note:'ISOLATED approved numbered production instruction'});
}
