import { test } from "node:test";
import assert from "node:assert/strict";
import { assertShipmentPayment } from "../server/supply/settlement.ts";
const t = {
  method: "A",
  deposit_percent: 30,
  bill_type: "to_order",
  guarantee_file_id: "test",
  bl_draft_file_id: "test",
  bl_checks: {
    shipper: true,
    consignee: true,
    goods: true,
    quantity: true,
    amount: true,
    seal: true,
  },
};
const s = (paid: string) => ({
  paid,
  total: "100.00",
  settled: Number(paid) >= 100,
  currency: "USD",
  remaining: String(100 - Number(paid)),
  receipts: [],
});
test("A/B/C payment branches use actual amounts and never confuse B with customer-forwarder C", () => {
  assert.throws(() => assertShipmentPayment(t, s("30")), /A/);
  assert.doesNotThrow(() => assertShipmentPayment(t, s("100")));
  assert.doesNotThrow(() =>
    assertShipmentPayment({ ...t, method: "B" }, s("30")),
  );
  assert.throws(
    () => assertShipmentPayment({ ...t, method: "B" }, s("29.99")),
    /定金/,
  );
  assert.throws(
    () => assertShipmentPayment({ ...t, method: "C" }, s("49.99")),
    /C/,
  );
  assert.doesNotThrow(() =>
    assertShipmentPayment({ ...t, method: "C" }, s("50")),
  );
  assert.throws(
    () =>
      assertShipmentPayment(
        { ...t, method: "C", guarantee_file_id: null },
        s("100"),
      ),
    /保函/,
  );
  assert.throws(
    () =>
      assertShipmentPayment(
        { ...t, method: "B", bill_type: "seaway" },
        s("30"),
      ),
    /海运单/,
  );
  assert.doesNotThrow(() =>
    assertShipmentPayment({ ...t, method: "B", bill_type: "telex" }, s("30")),
  );
  assert.throws(
    () =>
      assertShipmentPayment(
        { ...t, method: "C", bill_type: "seaway" },
        s("100"),
      ),
    /To Order/,
  );
  assert.throws(
    () =>
      assertShipmentPayment(
        { ...t, method: "C", bill_type: "telex" },
        s("100"),
      ),
    /To Order/,
  );
});
