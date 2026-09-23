import assert from "node:assert/strict";
import test from "node:test";
import { setupChecks } from "../server/whatsapp/readiness.ts";
import { verifyAppToken, type GraphApi } from "../server/whatsapp/graph.ts";
import type { WaConfig } from "../server/whatsapp/security.ts";

const config: WaConfig = { appId: "100001", appSecret: "test-secret", verifyToken: "test-verify", encryptionKey: "a".repeat(64), graphVersion: "v99.0", signupConfigId: "", origin: "https://crm.example.invalid" };
test("readiness never exposes secrets and Embedded Signup is optional for company numbers", () => {
  const checks = setupChecks(config);
  assert.equal(checks.filter(c => c.required).every(c => c.configured), true);
  assert.equal(checks.find(c => c.id === "signup")?.required, false);
  for (const secret of [config.appSecret, config.verifyToken, config.encryptionKey]) assert.ok(!JSON.stringify(checks).includes(secret));
  assert.equal(setupChecks({ ...config, graphVersion: "invalid", encryptionKey: "bad" }).filter(c => c.required && !c.configured).length, 2);
});
test("tokens must belong to this Meta app, have both scopes and remain unexpired", async () => {
  const good = { is_valid: true, app_id: config.appId, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], expires_at: 0, data_access_expires_at: 0 };
  const graph = (data: unknown) => ({ request: async () => ({ data }) }) as unknown as GraphApi;
  await verifyAppToken(graph(good), config, "test-token");
  for (const change of [{ app_id: "other" }, { is_valid: false }, { scopes: [] }, { expires_at: 1 }, { data_access_expires_at: 1 }]) {
    await assert.rejects(verifyAppToken(graph({ ...good, ...change }), config, "test-token"), /Meta凭据/);
  }
});
