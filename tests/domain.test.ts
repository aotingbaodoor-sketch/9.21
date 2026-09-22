import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.ts";
import { database } from "../server/db.ts";
import {
  addDays,
  businessDay,
  dueStatus,
  hashPassword,
  verifyPassword,
} from "../server/domain.ts";
test("业务日期按上海时区，而不是 UTC 或浏览器时区", () => {
  assert.equal(
    businessDay("Asia/Shanghai", new Date("2026-09-21T16:01:00Z")),
    "2026-09-22",
  );
  assert.equal(
    businessDay("America/New_York", new Date("2026-09-21T01:00:00Z")),
    "2026-09-20",
  );
});
test("跨月、闰年、DST 的业务日递增及状态", () => {
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(dueStatus("2026-09-21", "2026-09-21"), "今日跟进");
  assert.equal(dueStatus("2026-09-21", "2026-09-22"), "已逾期");
  assert.equal(dueStatus("2026-09-22", "2026-09-21"), "即将跟进");
});
test("密码加盐哈希、正确校验及错误拒绝", async () => {
  const a = await hashPassword("independent-test-password"),
    b = await hashPassword("independent-test-password");
  assert.notEqual(a, b);
  assert.ok(await verifyPassword("independent-test-password", a));
  assert.equal(await verifyPassword("incorrect-password", a), false);
});
test("生产必须HTTPS且仅信任一层受控反向代理", async () => {
  const pool = database("postgresql://unused:unused@127.0.0.1/unused");
  try {
    assert.throws(
      () => createApp(pool, { production: true, origin: "http://crm.invalid" }),
      /HTTPS/,
    );
    const app = createApp(pool, {
      production: true,
      origin: "https://crm.invalid",
    });
    assert.equal(app.get("trust proxy"), 1);
    assert.equal(app.get("x-powered-by"), false);
  } finally {
    await pool.end();
  }
});
