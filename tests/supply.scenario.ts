import assert from "node:assert/strict";
import type { User } from "../shared/contracts.ts";
import type { fixtures } from "./quoting.fixtures.ts";

type Agent = { cookie: string; csrf: string; user: User };
// The harness intentionally accepts arbitrary API response shapes so assertions
// verify the wire contract rather than sharing server implementation types.
type Request = (actor: Agent | null, path: string, method?: string, body?: unknown) => Promise<{ status: number; data: any }>;
type Ok = (actor: Agent | null, path: string, method?: string, body?: unknown) => Promise<any>;

export async function supplyScenario(ctx: {
  ok: Ok; request: Request; login: (email: string) => Promise<Agent>;
  admin: Agent; a: Agent; b: Agent; fa: Agent; fb: Agent;
  customerId: string; factoryId: string; password: string;
  fixture: ReturnType<typeof fixtures>; pass: (name: string) => void;
}) {
  const { ok, request, login, admin, a, b, fa, fb, customerId, factoryId, fixture, password, pass } = ctx;
  for (const name of ["follow-a", "follow-b"]) await ok(admin, "/team", "POST", { name, email: `${name}@test.invalid`, role: "coordinator", password });
  const follow = await login("follow-a@test.invalid"), other = await login("follow-b@test.invalid");
  const productId = (await ok(fa, "/supply/factory-products", "POST", {
    sku: "FACTORY-CYCLE", nameZh: "工厂完整流程测试门", nameEn: "TEST Factory Workflow Door",
    category: "推拉门", series: "TEST", specification: "ISOLATED TEST ONLY", imageUrls: [],
    supplyPrice: 1000, currency: "CNY", pricingMethod: "area_options", leadDays: 25,
    pricingRule: { ...fixture.product, id: undefined, prices: undefined },
  })).id;
  await ok(fa, `/supply/factory-products/${productId}/submit`, "POST", { version: 1 });
  await ok(admin, `/supply/factory-products/${productId}/review`, "POST", { version: 2, status: "approved", note: "TEST pricing and packing checked", guidePrice: 1500, minimumPrice: 1200, retailPrice: 1800, active: true });
  const product = (await ok(a, "/quoting/products")).find((p: { sku: string }) => p.sku === "FACTORY-CYCLE");
  assert.ok(product);
  const projectId = (await ok(a, "/quoting/projects", "POST", { customerId, name: "TEST full factory cycle" })).id;
  const input = structuredClone(fixture.input);
  input.lines[0].productId = product.id;
  input.incoterm = "EXW";
  input.freightId = null;
  input.namedPlace = "TEST factory";
  const quoteId = (await ok(a, `/quoting/projects/${projectId}/versions`, "POST", { baseVersion: 1, input, reason: "TEST real factory catalogue to order" })).id;
  let quote = await ok(a, `/quoting/versions/${quoteId}`);
  assert.ok(quote.snapshot.total > 0);
  assert.ok(quote.snapshot.lines[0].svg.includes("<svg"));
  await ok(a, `/quoting/versions/${quoteId}/submit`, "POST", { version: quote.version });
  quote = await ok(a, `/quoting/versions/${quoteId}`);
  await ok(a, `/quoting/versions/${quoteId}/issue`, "POST", { version: quote.version });
  quote = await ok(a, `/quoting/versions/${quoteId}`);
  const confirmed = await ok(a, `/quoting/versions/${quoteId}/confirm`, "POST", { version: quote.version, contact: "TEST buyer", evidence: "TEST buyer approved factory-origin product configuration" });
  const orders = await ok(admin, "/supply/orders");
  let salesId = "";
  for (const row of orders) {
    const detail = await ok(admin, `/supply/orders/${row.id}`);
    if (detail.order.quotation_order_id === confirmed.id) salesId = row.id;
  }
  assert.ok(salesId, "confirmed factory quote creates sales order");
  const sales = await ok(a, `/supply/orders/${salesId}`);
  assert.equal(sales.order.snapshot, undefined);
  assert.ok(!JSON.stringify(sales).includes("unitPrice"));
  const purchaseId = (await ok(admin, `/supply/orders/${salesId}/purchase-orders`, "POST", { factoryId, itemIds: [sales.items[0].id], promisedDate: null })).id;
  const base = `/supply/purchase-orders/${purchaseId}`;
  assert.equal((await request(admin, `/supply/orders/${salesId}/purchase-orders`, "POST", { factoryId, itemIds: [sales.items[0].id], promisedDate: null })).status, 409);
  let order = await ok(fa, base);
  await ok(admin, `${base}/assign`, "POST", { userId: follow.user.id, version: order.order.version });
  order = await ok(fa, base);
  await ok(fa, `${base}/confirm`, "POST", { version: order.order.version, price: 14400, promisedDate: "2020-01-01", note: "TEST intentionally overdue" });
  order = await ok(fa, base);
  assert.equal(order.order.company, undefined);
  assert.ok(!JSON.stringify(order.items).includes("unitPrice"));
  assert.equal((await ok(a, base)).order.factory_confirmed_price, undefined);
  assert.equal((await ok(follow, base)).order.factory_confirmed_price, undefined);
  for (const actor of [b, fb, other]) {
    assert.equal((await request(actor, base)).status, 404);
    assert.equal((await request(actor, `${base}/fulfillment`)).status, 404);
  }
  assert.equal((await request(follow, "/customers")).status, 403);
  pass("工厂自行录价并经审核的同一产品，销售真实报价出图、确认、拆单；跟单A/B和价格字段隔离");

  const feedback = (stage: string, quantity = 3) => ({ stage, quantity, actualAt: new Date().toISOString(), plannedAt: null, note: "TEST factory feedback" });
  const updateId = (await ok(fa, `${base}/updates`, "POST", feedback("materials"))).id;
  assert.equal((await ok(follow, `${base}/fulfillment`)).progress.pending, 1);
  assert.equal((await ok(follow, `${base}/fulfillment`)).progress.overdue, true);
  const photo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFT8AAAAASUVORK5CYII=", "base64");
  const photoBody = { updateId, kind: "photo", name: "TEST production.png", mime: "image/png", data: photo.toString("base64") };
  const media = (await ok(fa, `${base}/media`, "POST", photoBody)).id;
  assert.deepEqual(await ok(follow, `/supply/media/${media}`), photo);
  for (const actor of [b, fb, other]) assert.equal((await request(actor, `/supply/media/${media}`)).status, 404);
  assert.equal((await request(fa, `${base}/media`, "POST", { ...photoBody, data: Buffer.from("not an image").toString("base64") })).status, 400);
  const review = { version: 1, status: "approved", note: "TEST follow-up verified" };
  assert.equal((await request(fa, `${base}/updates/${updateId}/review`, "POST", review)).status, 403);
  assert.equal((await request(other, `${base}/updates/${updateId}/review`, "POST", review)).status, 404);
  await ok(follow, `${base}/updates/${updateId}/review`, "POST", review);
  assert.equal((await ok(fa, base)).order.status, "in_production");
  assert.equal((await request(fa, `${base}/media`, "POST", photoBody)).status, 409);
  assert.equal((await request(follow, `${base}/updates/${updateId}/review`, "POST", review)).status, 409);
  assert.equal((await request(fa, `${base}/updates`, "POST", feedback("shipped"))).status, 422);
  const duplicateId = (await ok(fa, `${base}/updates`, "POST", feedback("materials", 1))).id;
  assert.equal((await request(follow, `${base}/updates/${duplicateId}/review`, "POST", review)).status, 422);
  await ok(follow, `${base}/updates/${duplicateId}/review`, "POST", { ...review, status: "rejected" });
  pass("工厂照片上传、越权附件拒绝、反馈待审/批准/退回、逾期提醒和数量上限");

  const itemId = order.items[0].id;
  const pack = (label: string, quantity: number) => ({ label, lengthMm: 2200, widthMm: 2600, heightMm: 200, netKg: 100 * quantity, grossKg: 105 * quantity, items: [{ itemId, quantity }] });
  const p1 = (await ok(fa, `${base}/packages`, "POST", pack("TEST P1", 1))).id;
  const p2 = (await ok(fa, `${base}/packages`, "POST", pack("TEST P2", 2))).id;
  assert.equal((await request(fa, `${base}/packages`, "POST", pack("TEST overflow", 1))).status, 422);
  const shipBody = (id: string) => ({ packageIds: [id], carrier: "TEST forwarder", trackingNumber: "TEST tracking" });
  const races = await Promise.all([request(fa, `${base}/shipments`, "POST", shipBody(p1)), request(fa, `${base}/shipments`, "POST", shipBody(p1))]);
  assert.deepEqual(races.map(r => r.status).sort(), [200, 409]);
  const s1 = races.find(r => r.status === 200)!.data.id;
  const s2 = (await ok(fa, `${base}/shipments`, "POST", shipBody(p2))).id;
  const dispatch = (shipment: string, actor = follow) => request(actor, `${base}/shipments/${shipment}/dispatch`, "POST", { version: 1 });
  assert.equal((await dispatch(s1)).status, 422);
  const quality = { status: "failed", note: "TEST glass requires rework", checklist: [{ name: "glass", passed: false }] };
  assert.equal((await request(fa, `${base}/quality`, "POST", quality)).status, 403);
  await ok(follow, `${base}/quality`, "POST", quality);
  let rework = (await ok(fa, `${base}/fulfillment`)).reworks[0];
  const passedQuality = { status: "passed", note: "TEST reinspection passed", checklist: [{ name: "glass", passed: true }] };
  assert.equal((await request(follow, `${base}/quality`, "POST", passedQuality)).status, 422);
  assert.equal((await request(admin, `${base}/reworks/${rework.id}/submit`, "POST", { version: rework.version, note: "admin cannot impersonate factory" })).status, 403);
  await ok(fa, `${base}/reworks/${rework.id}/submit`, "POST", { version: rework.version, note: "TEST factory completed rework" });
  rework = (await ok(follow, `${base}/fulfillment`)).reworks[0];
  await ok(follow, `${base}/reworks/${rework.id}/review`, "POST", { ...review, version: rework.version });
  await ok(follow, `${base}/quality`, "POST", passedQuality);
  assert.equal((await dispatch(s1)).status, 422, "packing must be approved first");
  const packingId = (await ok(fa, `${base}/updates`, "POST", feedback("packing"))).id;
  await ok(follow, `${base}/updates/${packingId}/review`, "POST", review);
  const issueId = (await ok(fa, `${base}/issues`, "POST", { severity: "high", description: "TEST missing transport protection" })).id;
  assert.equal((await dispatch(s1)).status, 422);
  await ok(follow, `${base}/issues/${issueId}/resolve`, "POST", { version: 1, resolution: "TEST protection verified" });
  assert.equal((await dispatch(s1, fa)).status, 403);
  assert.equal((await dispatch(s1)).status, 200);
  assert.equal((await ok(fa, base)).order.status, "ready");
  assert.equal((await dispatch(s2)).status, 200);
  assert.equal((await ok(fa, base)).order.status, "shipped");
  assert.equal((await request(fa, `${base}/shipments/${s1}/receive`, "POST", { version: 2, evidence: "TEST invalid self-receipt" })).status, 403);
  await ok(follow, `${base}/shipments/${s1}/receive`, "POST", { version: 2, evidence: "TEST buyer receipt for first package" });
  assert.notEqual((await ok(a, `/supply/orders/${salesId}`)).order.status, "closed");
  await ok(follow, `${base}/shipments/${s2}/receive`, "POST", { version: 2, evidence: "TEST buyer receipt for remaining packages" });
  assert.equal((await ok(a, `/supply/orders/${salesId}`)).order.status, "closed");
  assert.equal((await request(fa, `${base}/updates`, "POST", feedback("packing"))).status, 409);
  pass("质检失败→工厂返工→跟单复核→复检→包装审核→两批发货签收；重复包装、跳过审核与自签收均被拒绝");
}
