// Browser plugin not available: existing isolated Playwright workflow, no production mutations.
import { chromium, expect, type Page } from "@playwright/test";
import { TC_FIELDS, PRODUCTION_FIELDS } from "../shared/technical.ts";
const fieldSelect = (page: Page, label: string) =>
  page
    .locator("label")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("select");
export async function uiSession(origin: string, password: string) {
  const browser = await chromium.launch({ channel: "msedge", headless: true }),
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
    errors: string[] = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel("邮箱", { exact: true }).fill("admin@chain.invalid");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "退出", exact: true }),
  ).toBeVisible();
  return { browser, page, errors };
}
async function response(
  page: Page,
  suffix: string,
  click: () => Promise<void>,
) {
  const pending = page.waitForResponse(
    (r) => r.url().endsWith(suffix) && r.request().method() === "POST",
  );
  await click();
  const r = await pending;
  expect(r.status(), await r.text()).toBe(200);
  return {
    value: await r.json(),
    body: r.request().postDataJSON(),
    key: r.request().headers()["idempotency-key"],
  };
}
export async function uiProject(
  page: Page,
  origin: string,
  customerId: string,
  name: string,
) {
  await page.goto(origin + "/technical");
  await page
    .getByText("选择在用客户 → 新建报价项目 → 创建TC", { exact: true })
    .click();
  await page
    .locator("label")
    .filter({ has: page.getByText("在用客户", { exact: true }) })
    .locator("select")
    .selectOption(customerId);
  await page.getByLabel("新报价项目名称", { exact: true }).fill(name);
  const r = await response(page, "/api/quoting/projects", () =>
    page.getByRole("button", { name: "创建项目并填写TC" }).click(),
  );
  await expect(
    page.getByRole("button", { name: "保存TC", exact: true }),
  ).toBeVisible();
  return r.value.id;
}
export async function uiTc(page: Page, origin: string, body: any) {
  console.log("UI TC form", body.technical.items[0].kind);
  await page.goto(origin + "/technical");
  await fieldSelect(page, "选择客户项目").selectOption(body.projectId);
  await page.getByRole("button", { name: "创建TC", exact: true }).click();
  const i = body.technical.items[0];
  await page
    .getByLabel("产品行标识（与报价行一致）", { exact: true })
    .fill(i.lineKey);
  await fieldSelect(page, "类型").selectOption(i.kind);
  for (const [k, label] of Object.entries({
    quantity: "数量",
    widthMm: "宽 mm",
    heightMm: "高 mm",
  }))
    await page.getByLabel(label, { exact: true }).fill(String(i[k]));
  for (const [key, label] of Object.entries(TC_FIELDS))
    await page
      .getByLabel(label + " · 我方确认配置", { exact: true })
      .fill(i.fields[key]);
  console.log("UI TC technical fields filled");
  await page
    .getByLabel(TC_FIELDS.special + " · 客户原始需求", { exact: true })
    .fill(body.business.originalRequirements["Door-01"].special);
  await page.getByText("商务信息（绝不进入工厂版）", { exact: true }).click();
  for (const [key, label] of Object.entries({
    projectName: "项目名称",
    country: "国家/地区",
    port: "目的港",
    upgradeFees: "升级费用",
    certificationPayer: "认证检测费用承担",
    certificationPeriod: "预计认证周期",
  }))
    if (body.business[key])
      await page.getByLabel(label, { exact: true }).fill(body.business[key]);
  await page.getByLabel("新建 / 升版原因", { exact: true }).fill(body.reason);
  const r = await response(page, "/api/supply/technical", () =>
    page.getByRole("button", { name: "保存TC", exact: true }).click(),
  );
  await page.waitForURL("**/technical/" + r.value.id);
  return r;
}
export async function uiDrawing(
  page: Page,
  origin: string,
  tcId: string,
  bytes: Buffer,
) {
  console.log("UI original drawing and redaction");
  await page.goto(origin + "/technical/" + tcId);
  await page
    .getByLabel("内部原图（PDF/PNG/JPEG，4MB内，PDF最多5页）", { exact: true })
    .setInputFiles({
      name: "SECRET customer original.pdf",
      mimeType: "application/pdf",
      buffer: bytes,
    });
  await page
    .getByRole("group", { name: "对应TC产品行" })
    .getByRole("checkbox")
    .check();
  const uploaded = await response(
    page,
    `/api/supply/technical/${tcId}/drawings`,
    () => page.getByRole("button", { name: "上传内部原图" }).click(),
  );
  await page
    .getByRole("link", { name: "SECRET customer original.pdf", exact: true })
    .click();
  const surface = page.getByTestId("drawing-mask-surface");
  await expect(surface.locator("img")).toBeVisible();
  await expect
    .poll(() =>
      surface
        .locator("img")
        .evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
    )
    .toBe(true);
  await surface.scrollIntoViewIfNeeded();
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + 1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height * 0.34, {
    steps: 5,
  });
  await page.mouse.up();
  await page
    .getByLabel("副本变更原因", { exact: true })
    .fill("ISOLATED: remove private title, preserve technical dimensions");
  const redacted = await response(
    page,
    `/api/supply/technical-drawings/${uploaded.value.id}/redactions`,
    () =>
      page.getByRole("button", { name: "生成新脱敏副本（重新审核）" }).click(),
  );
  await expect(page.getByText(/服务端副本 V1/)).toBeVisible();
  return { drawing: uploaded.value, redaction: redacted.value };
}
export async function uiReview(
  page: Page,
  origin: string,
  drawingId: string,
  redactionId: string,
) {
  await page.goto(origin + "/technical/drawings/" + drawingId);
  await page.getByLabel("已核查第1页", { exact: true }).check();
  await page
    .getByLabel("客户身份、联系方式、地址和签字已去除", { exact: true })
    .check();
  await page
    .getByLabel("尺寸、结构及技术要求完整保留", { exact: true })
    .check();
  await page
    .getByLabel("审核意见", { exact: true })
    .fill(
      "ISOLATED visual review: private header removed, 1000 x 2000 retained",
    );
  await response(
    page,
    `/api/supply/drawing-redactions/${redactionId}/review`,
    () =>
      page.getByRole("button", { name: "审核通过此副本", exact: true }).click(),
  );
  await expect(page.getByText(/服务端副本 V\d+ · 审核通过/)).toBeVisible();
}
export async function uiConfirm(
  page: Page,
  origin: string,
  tcId: string,
  fileId: string,
  date: string,
  quoteId: string,
) {
  await page.goto(origin + "/technical/" + tcId);
  await fieldSelect(page, "签字凭证").selectOption(fileId);
  await page
    .getByLabel("客户签字人", { exact: true })
    .fill("ISOLATED Buyer signature");
  await page.getByLabel("实际签字日期", { exact: true }).fill(date);
  await page
    .getByLabel("我已核对签字文件对应此TC版本", { exact: true })
    .check();
  await response(page, `/api/supply/technical/${tcId}/confirm`, () =>
    page.getByRole("button", { name: "确认并锁定签字记录" }).click(),
  );
  await page
    .getByRole("heading", { name: "关联报价版本", exact: true })
    .locator("..")
    .getByRole("combobox")
    .last()
    .selectOption(quoteId);
  await response(page, `/api/supply/technical/${tcId}/bind-quote`, () =>
    page.getByRole("button", { name: "核对数量尺寸并绑定" }).click(),
  );
}
export async function uiDraft(
  page: Page,
  origin: string,
  woId: string,
  body: any,
) {
  console.log("UI MO draft");
  await page.goto(origin + "/supply/chain/" + woId);
  await fieldSelect(page, "采购单").selectOption(body.purchaseOrderId);
  await fieldSelect(page, "源TC版本").selectOption(body.tcId);
  await page
    .getByRole("button", { name: "载入源TC数量（可分批，0表示本批不生产）" })
    .click();
  await page.getByLabel("Door-01", { exact: true }).fill("1");
  for (const [key, label] of Object.entries(PRODUCTION_FIELDS))
    await page.getByLabel(label, { exact: true }).fill(body.production[key]);
  const r = await response(
    page,
    `/api/supply/chain/${woId}/manufacturing-drafts`,
    () => page.getByRole("button", { name: "生成草稿并检查差异" }).click(),
  );
  await page.waitForURL("**/supply/manufacturing-drafts/" + r.value.id);
  return r.value;
}
export async function uiWrongTechnical(page: Page, origin: string, id: string) {
  await page.goto(origin + "/supply/manufacturing-drafts/" + id);
  await page
    .locator("label")
    .filter({ has: page.getByText(TC_FIELDS.finalHardware, { exact: true }) })
    .locator("textarea")
    .fill("WRONG");
  const wait = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/supply/manufacturing-drafts/" + id) &&
      r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "保存生产段并重新检查差异" }).click();
  expect((await wait).status()).toBe(200);
  await expect(page.getByText(/UPGRADED H3 FINAL → WRONG/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "核验门禁并签认下达" }),
  ).toBeDisabled();
}
export async function uiIssue(page: Page, origin: string, id: string) {
  await page.goto(origin + "/supply/manufacturing-drafts/" + id);
  await page
    .getByLabel("甲方确认：我已核对并批准此版本的全部技术、数量与生产要求", {
      exact: true,
    })
    .check();
  const r = await response(
    page,
    `/api/supply/manufacturing-drafts/${id}/issue`,
    () => page.getByRole("button", { name: "核验门禁并签认下达" }).click(),
  );
  await page.waitForURL("**/supply/manufacturing/" + r.value.id);
  return r;
}
