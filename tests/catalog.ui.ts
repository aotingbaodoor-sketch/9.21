import assert from "node:assert/strict";
import path from "node:path";
import { expect, type Browser } from "@playwright/test";
import { testPng } from "./catalog.scenario.ts";
import { future } from "./quoting.fixtures.ts";

export async function catalogUi(
  browser: Browser,
  origin: string,
  password: string,
  artifacts: string,
) {
  const factory = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const admin = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors: string[] = [];
  for (const page of [factory, admin])
    page.on("pageerror", (error) => errors.push(error.message));
  async function signIn(page: typeof factory, email: string) {
    await page.goto(origin + "/login");
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL((url) => url.pathname !== "/login");
  }
  await signIn(factory, "factory-a@test.invalid");
  await factory.getByRole("link", { name: "供货产品", exact: true }).click();
  await factory
    .getByRole("button", { name: "＋ 录入供货产品", exact: true })
    .click();
  const form = factory.getByRole("dialog", {
    name: "录入供货产品",
    exact: true,
  });
  await form.getByLabel("产品编号 *", { exact: true }).fill("TEST-UI-CATALOG");
  await form.getByLabel("中文名称 *", { exact: true }).fill("测试UI工厂门");
  await form.getByLabel("基础供货价（人民币）", { exact: true }).fill("100");
  await expect(
    form
      .getByRole("combobox", { name: "计价方式", exact: true })
      .locator("option"),
  ).toHaveCount(10);
  await form
    .getByRole("combobox", { name: "计价方式", exact: true })
    .selectOption("range");
  await form
    .getByRole("button", { name: "＋ 添加面积档位", exact: true })
    .click();
  await form.getByLabel("档位1 面积上限㎡", { exact: true }).fill("10");
  await form.getByLabel("档位1 每件供货价", { exact: true }).fill("1000");
  await form.getByLabel("供货价有效期", { exact: true }).fill(future);
  await form
    .getByRole("combobox", { name: "示意图类型", exact: true })
    .selectOption("sliding");
  await form.getByText("选配与加价成本（0项）", { exact: true }).click();
  await form.getByRole("button", { name: "＋ 添加选配", exact: true }).click();
  await form.getByLabel("选配1 名称", { exact: true }).fill("TEST玻璃升级");
  await form.getByLabel("选配1 供货成本", { exact: true }).fill("20");
  await form.getByLabel("已核对本产品包装规则", { exact: true }).check();
  for (const [label, value] of [
    ["包装类型", "TEST木箱"],
    ["包装厚度 mm", "120"],
    ["每㎡净重 kg", "20"],
    ["每件固定净重 kg", "0"],
    ["每包包装自重 kg", "5"],
    ["每包包装成本 CNY", "100"],
  ])
    await form.getByLabel(label, { exact: true }).fill(value);
  await form.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(form).toHaveCount(0);
  const card = factory
    .locator("article.factory-product")
    .filter({ hasText: "TEST-UI-CATALOG" });
  await card
    .getByLabel("上传产品图片（每张≤2MB，最多12张）", { exact: true })
    .setInputFiles({
      name: "TEST.png",
      mimeType: "image/png",
      buffer: Buffer.from(testPng, "base64"),
    });
  await expect(
    card.getByRole("img", { name: "测试UI工厂门 产品图1", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      card
        .getByRole("img", { name: "测试UI工厂门 产品图1", exact: true })
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await card
    .getByRole("button", { name: "编辑产品及计价规则", exact: true })
    .click();
  const editor = factory.getByRole("dialog", {
    name: "编辑 TEST-UI-CATALOG",
    exact: true,
  });
  await expect(
    editor.getByLabel("档位1 每件供货价", { exact: true }),
  ).toHaveValue("1000");
  await editor.getByLabel("最小宽度 mm", { exact: true }).fill("300");
  await editor.getByRole("button", { name: "保存草稿", exact: true }).click();
  await card.getByRole("button", { name: "提交公司审核", exact: true }).click();
  await expect(card.getByText("待公司审核", { exact: true })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "编辑产品及计价规则", exact: true }),
  ).toHaveCount(0);
  await signIn(admin, "admin@test.invalid");
  await admin.getByRole("link", { name: "工厂产品审核", exact: true }).click();
  const review = admin
    .locator("article.factory-product")
    .filter({ hasText: "TEST-UI-CATALOG" });
  await expect(
    review.getByRole("button", { name: "审核通过并发布", exact: true }),
  ).toBeDisabled();
  await expect(review.getByLabel("销售指导价", { exact: true })).toHaveValue(
    "",
  );
  await review.getByLabel("销售指导价", { exact: true }).fill("1500");
  await review.getByLabel("最低销售价", { exact: true }).fill("1200");
  await review
    .getByLabel("包装销售价 / 包（供货成本 100）", { exact: true })
    .fill("140");
  await review
    .getByLabel("档位1 销售价 / 件（≤10㎡，成本1000）", { exact: true })
    .fill("1500");
  await review
    .getByLabel("选配 TEST玻璃升级 销售价（成本20）", { exact: true })
    .fill("40");
  await review
    .getByRole("button", { name: "审核通过并发布", exact: true })
    .click();
  await expect(
    review.getByText("已发布销售目录", { exact: true }),
  ).toBeVisible();
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.getByRole("button", { name: "菜单", exact: true }).click();
  await admin.getByRole("link", { name: "合作工厂管理", exact: true }).click();
  await expect(
    admin.getByRole("heading", { name: "合作工厂管理", exact: true }).first(),
  ).toBeVisible();
  await admin.screenshot({
    path: path.join(artifacts, "factory-admin-mobile.png"),
    fullPage: false,
  });
  await factory.reload();
  await card.getByRole("button", { name: "发起修订", exact: true }).click();
  await expect(card.getByText("草稿", { exact: true })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await factory.screenshot({
    path: path.join(artifacts, "catalog-desktop.png"),
    fullPage: false,
  });
  await factory.setViewportSize({ width: 390, height: 844 });
  await card
    .getByRole("button", { name: "编辑产品及计价规则", exact: true })
    .click();
  await expect(editor.getByLabel("最小宽度 mm", { exact: true })).toHaveValue(
    "300",
  );
  await factory.screenshot({
    path: path.join(artifacts, "catalog-mobile.png"),
    fullPage: false,
  });
  assert.ok(
    await factory.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual(errors, []);
  await admin.close();
  await factory.close();
}
