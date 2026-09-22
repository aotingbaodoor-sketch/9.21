import assert from "node:assert/strict";
import type { User } from "../shared/contracts.ts";
import type { fixtures } from "./quoting.fixtures.ts";
type Agent = { cookie: string; csrf: string; user: User };
type Request = (
  actor: Agent | null,
  path: string,
  method?: string,
  body?: unknown,
) => Promise<{ status: number; data: any }>;
type Ok = (
  actor: Agent | null,
  path: string,
  method?: string,
  body?: unknown,
) => Promise<any>;
export const testPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

export async function catalogScenario({
  ok,
  request,
  admin,
  a,
  fa,
  fb,
  fixture,
  pass,
}: {
  ok: Ok;
  request: Request;
  admin: Agent;
  a: Agent;
  fa: Agent;
  fb: Agent;
  fixture: ReturnType<typeof fixtures>;
  pass: (s: string) => void;
}) {
  const input = {
    sku: "TEST-CATALOG-RULES",
    nameZh: "工厂规则与图片测试",
    nameEn: "TEST Rules and Images",
    category: "推拉门",
    supplyPrice: 100,
    currency: "CNY",
    pricingMethod: "range",
    leadDays: 20,
    pricingRule: {},
  };
  const id = (await ok(fa, "/supply/factory-products", "POST", input)).id,
    base = `/supply/factory-products/${id}`;
  const row = async () =>
    (await ok(fa, "/supply/factory-products")).find(
      (p: { id: string }) => p.id === id,
    );
  assert.equal(
    (await request(fa, base + "/submit", "POST", { version: 1 })).status,
    422,
  );
  const rule = {
    ...fixture.product,
    prices: { guide: 1 },
    packing: { ...fixture.product.packing, salePerPackage: 1 },
    bands: [
      { maxArea: 5, cost: 400, sale: 1 },
      { maxArea: 10, cost: 800, sale: 1 },
    ],
    formula: [
      {
        name: "TEST profile",
        basis: "perimeter",
        coefficient: 1,
        cost: 10,
        sale: 1,
      },
    ],
    options: [
      {
        id: "glass",
        nameZh: "TEST玻璃",
        nameEn: "TEST glass",
        group: "glass",
        basis: "area",
        cost: 5,
        sale: 1,
        required: true,
      },
    ],
  };
  const edit = { ...input, pricingRule: rule, version: 1 };
  assert.equal((await request(fb, base, "PUT", edit)).status, 404);
  await ok(fa, base, "PUT", edit);
  assert.equal((await request(fa, base, "PUT", edit)).status, 409);
  const saved = await row();
  assert.equal(saved.pricing_rule.prices, undefined);
  assert.equal(saved.pricing_rule.packing.salePerPackage, undefined);
  assert.equal(saved.pricing_rule.bands[0].sale, undefined);
  assert.equal(saved.pricing_rule.options[0].sale, undefined);
  const photo = {
    version: saved.version,
    name: "TEST.png",
    mime: "image/png",
    data: testPng,
  };
  assert.equal(
    (await request(fb, base + "/images", "POST", photo)).status,
    404,
  );
  assert.equal(
    (
      await request(fa, base + "/images", "POST", {
        ...photo,
        data: Buffer.from("not an image").toString("base64"),
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await request(fa, base + "/images", "POST", {
        ...photo,
        data: Buffer.alloc(2097153).toString("base64"),
      })
    ).status,
    422,
  );
  const imageId = (await ok(fa, base + "/images", "POST", photo)).id,
    imageUrl = `/supply/factory-product-images/${imageId}`;
  assert.equal(
    (await request(fa, base + "/images", "POST", photo)).status,
    409,
  );
  assert.equal((await request(fb, imageUrl)).status, 404);
  assert.equal((await request(a, imageUrl)).status, 404);
  assert.equal((await request(null, imageUrl)).status, 401);
  assert.deepEqual(await ok(admin, imageUrl), Buffer.from(testPng, "base64"));
  const foreign = (
    await ok(fb, "/supply/factory-products", "POST", {
      ...input,
      sku: "TEST-FOREIGN-IMAGE",
    })
  ).id;
  assert.equal(
    (
      await request(fb, `/supply/factory-products/${foreign}`, "PUT", {
        ...edit,
        imageIds: [imageId],
      })
    ).status,
    422,
  );
  await ok(fa, base + "/submit", "POST", { version: (await row()).version });
  assert.equal(
    (
      await request(fa, base, "PUT", {
        ...edit,
        version: (await row()).version,
      })
    ).status,
    409,
  );
  const review = {
    status: "approved",
    guidePrice: 1000,
    minimumPrice: 900,
    retailPrice: 1200,
    version: (await row()).version,
  };
  assert.equal(
    (await request(fa, base + "/review", "POST", review)).status,
    403,
  );
  assert.equal(
    (await request(admin, base + "/review", "POST", review)).status,
    422,
  );
  const commercial = {
    packingSale: 140,
    bandSales: [1000, 2000],
    formulaSales: [50],
    optionSales: { glass: 25 },
  };
  const published = await ok(admin, base + "/review", "POST", {
    ...review,
    commercial,
  });
  const catalogue = async () =>
    (await ok(a, "/quoting/products")).find(
      (p: { id: string }) => p.id === published.approvedProductId,
    );
  const original = await catalogue();
  assert.equal(original.prices, undefined);
  const internal = (await ok(admin, "/quoting/products")).find(
    (p: { id: string }) => p.id === published.approvedProductId,
  );
  assert.equal(internal.prices.guide, 1000);
  assert.equal(internal.bands[0].sale, 1000);
  assert.equal(internal.formula[0].sale, 50);
  assert.equal(original.packing.salePerPackage, 140);
  assert.equal(original.options[0].sale, 25);
  assert.equal(original.options[0].cost, undefined);
  assert.deepEqual(original.imageIds, [imageId]);
  assert.equal((await request(a, imageUrl)).status, 200);
  pass(
    "工厂规则与图片：独立A/B权限、伪造/超大文件拒绝、并发版本冲突、未审核图片隔离、工厂不能注入销售价",
  );

  await ok(fa, base + "/revise", "POST", { version: (await row()).version });
  await ok(fa, base, "PUT", {
    ...edit,
    nameZh: "TEST revised after approval",
    imageIds: [],
    version: (await row()).version,
  });
  const secondImage = (
    await ok(fa, base + "/images", "POST", {
      ...photo,
      version: (await row()).version,
    })
  ).id;
  assert.equal(
    (await request(a, `/supply/factory-product-images/${secondImage}`)).status,
    404,
  );
  assert.deepEqual(await catalogue(), original);
  assert.equal((await request(a, imageUrl)).status, 200);
  await ok(fa, base + "/submit", "POST", { version: (await row()).version });
  assert.equal(
    (
      await request(admin, base + "/review", "POST", {
        status: "rejected",
        version: (await row()).version,
      })
    ).status,
    422,
  );
  await ok(admin, base + "/review", "POST", {
    status: "rejected",
    note: "TEST update specification",
    version: (await row()).version,
  });
  assert.deepEqual(await catalogue(), original);
  await ok(fa, base + "/submit", "POST", { version: (await row()).version });
  await ok(admin, base + "/review", "POST", {
    ...review,
    guidePrice: 1100,
    version: (await row()).version,
    commercial,
  });
  const revised = await catalogue();
  assert.equal(revised.nameZh, "TEST revised after approval");
  assert.equal(
    (await ok(admin, "/quoting/products")).find(
      (p: { id: string }) => p.id === published.approvedProductId,
    ).prices.guide,
    1100,
  );
  assert.deepEqual(revised.imageIds, [secondImage]);
  assert.equal(
    (await request(a, `/supply/factory-product-images/${secondImage}`)).status,
    200,
  );
  assert.equal((await request(a, imageUrl)).status, 404);
  assert.equal((await request(fa, imageUrl)).status, 200);
  assert.equal(
    (await request(fb, `/supply/factory-product-images/${secondImage}`)).status,
    404,
  );
  pass(
    "工厂修订→公司驳回→再次审核：批准前目录保持旧版，批准后才更新价格和图片，历史图片保留但不公开",
  );
}
