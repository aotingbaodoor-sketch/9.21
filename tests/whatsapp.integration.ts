import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { localPostgres } from "../scripts/postgres-runtime.ts";
import { database, migrate } from "../server/db.ts";
import { createApp } from "../server/app.ts";
import { hashPassword, toUser } from "../server/domain.ts";
import { backup, restore } from "../server/backup.ts";
import {
  bindAccount,
  createWhatsAppService,
} from "../server/whatsapp/service.ts";
import {
  encrypt,
  decrypt,
  verifySignature,
  normalizeNumber,
  windowOpen,
  type WaConfig,
} from "../server/whatsapp/security.ts";
import { MetaError, type GraphApi } from "../server/whatsapp/graph.ts";
import type { User } from "../shared/contracts.ts";
import type { WaChat } from "../shared/whatsapp.ts";

// 独立PostgreSQL + 真实HTTP/会话/浏览器；仅Meta传输为注入式测试替身，不连接真实号码。
const runId = randomUUID(),
  password = randomBytes(24).toString("base64url"),
  dbPassword = randomBytes(24).toString("hex");
const origin = "http://127.0.0.1:4499",
  port = 55449,
  root = path.join(os.tmpdir(), "autinberg-whatsapp-test", runId);
const config: WaConfig = {
  appId: "100001",
  appSecret: randomBytes(32).toString("hex"),
  verifyToken: randomBytes(24).toString("hex"),
  encryptionKey: randomBytes(32).toString("hex"),
  graphVersion: "v99.0",
  signupConfigId: "100002",
  origin,
};
const token = randomBytes(32).toString("base64url"),
  client1 = "447700900101",
  client2 = "447700900102",
  phoneA = "200001",
  phoneB = "200002",
  waba = "300001";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
  "base64",
);
let failure: MetaError | null = null,
  earlyReceipt = false,
  sendCalls = 0;
const sent: { id: string; body: Record<string, unknown> }[] = [];
const graph: GraphApi = {
  async request<T>(
    endpoint: string,
    _token: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    if (failure) {
      const error = failure;
      failure = null;
      throw error;
    }
    if (endpoint.includes("/phone_numbers"))
      return {
        data: [
          {
            id: phoneA,
            display_phone_number: "+1 202 555 0101",
            verified_name: "TEST A",
          },
          {
            id: phoneB,
            display_phone_number: "+1 202 555 0102",
            verified_name: "TEST B",
          },
        ],
      } as T;
    if (endpoint.includes("subscribed_apps"))
      return (
        method === "POST"
          ? { success: true }
          : { data: [{ whatsapp_business_api_data: { id: config.appId } }] }
      ) as T;
    if (endpoint.startsWith("debug_token"))
      return {
        data: {
          is_valid: true,
          app_id: config.appId,
          scopes: [
            "whatsapp_business_management",
            "whatsapp_business_messaging",
          ],
        },
      } as T;
    if (endpoint.includes("message_templates"))
      return {
        data: [
          {
            id: "400001",
            name: "quote_update",
            language: "en_US",
            status: "APPROVED",
            category: "UTILITY",
            components: [
              { type: "BODY", text: "Hello {{1}}, your quote is ready." },
            ],
          },
          {
            id: "400002",
            name: "not_approved",
            language: "en_US",
            status: "REJECTED",
            category: "MARKETING",
            components: [],
          },
        ],
      } as T;
    if (endpoint.endsWith("/messages") && method === "POST") {
      sendCalls++;
      const id = "wamid.out." + randomUUID(),
        payload = body as Record<string, unknown>;
      sent.push({ id, body: payload });
      if (earlyReceipt) {
        earlyReceipt = false;
        await webhook(
          statusPayload(
            endpoint.split("/")[0],
            id,
            "read",
            String(payload.to),
            String(payload.biz_opaque_callback_data),
          ),
        );
        await service.processEvents();
      }
      return { messages: [{ id }] } as T;
    }
    throw new Error("Unexpected fake Meta endpoint");
  },
  async exchangeCode() {
    return token;
  },
  async media(id) {
    if (id === "media-fail") throw new MetaError("190");
    return id === "media-image"
      ? { bytes: png, mime: "image/png" }
      : id === "media-audio"
        ? { bytes: Buffer.from("RIFF0000WAVEfmt "), mime: "audio/wav" }
        : {
            bytes: Buffer.from("%PDF-1.4 test document"),
            mime: "application/pdf",
          };
  },
};
await mkdir(root, { recursive: true });
const pg = await localPostgres({
  databaseDir: path.join(root, "postgres"),
  port,
  user: "postgres",
  password: dbPassword,
  persistent: true,
  authMethod: "scram-sha-256",
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {},
  onError: () => {},
});
const url = `postgresql://postgres:${dbPassword}@127.0.0.1:${port}/whatsapp_test`;
let pool = database(url),
  service = createWhatsAppService(pool, config, graph),
  server: Server | undefined,
  browser: Browser | undefined,
  started = false;
const completed: string[] = [],
  pass = (name: string) => {
    completed.push(name);
    console.log("PASS " + name);
  };
type Agent = { cookie: string; csrf: string; user: User };
async function request(
  agent: Agent | null,
  route: string,
  method = "GET",
  body?: unknown,
  key: string = randomUUID(),
) {
  const response = await fetch(origin + "/api" + route, {
    method,
    headers: {
      Origin: origin,
      ...(agent ? { Cookie: agent.cookie, "X-CSRF-Token": agent.csrf } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "Idempotency-Key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie"),
  };
}
async function ok(
  agent: Agent | null,
  route: string,
  method = "GET",
  body?: unknown,
  key?: string,
) {
  const r = await request(agent, route, method, body, key);
  assert.equal(r.status, 200, `${method} ${route}: ${JSON.stringify(r.data)}`);
  return r.data;
}
async function login(email: string): Promise<Agent> {
  const r = await request(null, "/auth/login", "POST", { email, password });
  assert.equal(r.status, 200);
  return {
    cookie: r.cookie!.split(";")[0],
    csrf: r.data.csrf,
    user: r.data.user,
  };
}
async function start() {
  service = createWhatsAppService(pool, config, graph);
  server = createApp(pool, {
    origin,
    serveStatic: true,
    whatsapp: { config, graph },
  }).listen(4499, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
}
async function stop() {
  await new Promise<void>((resolve, reject) =>
    server ? server.close((e) => (e ? reject(e) : resolve())) : resolve(),
  );
}
const timestamp = (agoMinutes = 0) =>
  String(Math.floor((Date.now() - agoMinutes * 60000) / 1000));
function payload(
  phone: string,
  from: string,
  messages: Record<string, unknown>[],
) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: waba,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phone },
              contacts: [
                {
                  wa_id: from,
                  profile: {
                    name:
                      from === client1 ? "Test Client One" : "Test Client Two",
                  },
                },
              ],
              messages: messages.map((m) => ({
                from,
                timestamp: timestamp(),
                ...m,
              })),
            },
          },
        ],
      },
    ],
  };
}
function textPayload(
  phone: string,
  from: string,
  id: string,
  text = "Hello, I need aluminum windows",
  ago = 0,
) {
  return payload(phone, from, [
    { id, type: "text", text: { body: text }, timestamp: timestamp(ago) },
  ]);
}
function statusPayload(
  phone: string,
  id: string,
  status: string,
  waId: string,
  localId?: string,
) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: waba,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: phone },
              statuses: [
                {
                  id,
                  status,
                  recipient_id: waId,
                  timestamp: timestamp(),
                  ...(localId ? { biz_opaque_callback_data: localId } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
async function webhook(data: unknown, signature?: string) {
  const raw = JSON.stringify(data),
    r = await fetch(origin + "/api/whatsapp/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256":
          signature ||
          "sha256=" +
            createHmac("sha256", config.appSecret).update(raw).digest("hex"),
      },
      body: raw,
    });
  return r.status;
}
async function receive(data: unknown) {
  assert.equal(await webhook(data), 200);
  await service.processEvents(40);
}
const count = async (table: string, where = "TRUE") =>
  (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))
    .rows[0].n;
async function chat(a: Agent, id: string): Promise<WaChat> {
  return ok(a, `/whatsapp/customers/${id}/chat`);
}
async function customer(id: string) {
  return (await pool.query("SELECT * FROM customers WHERE id=$1", [id]))
    .rows[0];
}
async function assign(admin: Agent, id: string, userId: string) {
  const c = await customer(id);
  await ok(admin, "/whatsapp/assignments", "POST", {
    customers: [{ id, version: c.version }],
    ownerId: userId,
    reason: "隔离测试管理员确认",
  });
}
async function rules(admin: Agent, policy: string) {
  const view = await ok(admin, "/whatsapp/config");
  await ok(admin, "/whatsapp/settings", "PUT", {
    ...view.rules,
    reassignmentPolicy: policy,
  });
}
async function browserLogin(page: Page, email: string) {
  await page.goto(origin + "/login");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: /你好/ })).toBeVisible();
}

try {
  assert.equal(normalizeNumber("00 44 (7700) 900101"), client1);
  assert.equal(decrypt(encrypt(token, config), config), token);
  assert.throws(() =>
    decrypt(encrypt(token, config), {
      ...config,
      encryptionKey: randomBytes(32).toString("hex"),
    }),
  );
  assert.equal(
    verifySignature(
      Buffer.from("{}"),
      "sha256=" + "0".repeat(64),
      config.appSecret,
    ),
    false,
  );
  assert.equal(windowOpen(new Date(Date.now() - 86400001)), false);
  pass("加密凭据可解密且拒绝错误密钥、国际号码标准化、签名与24小时边界");
  await pg.initialise();
  await pg.start();
  started = true;
  await pg.createDatabase("whatsapp_test");
  await pg.createDatabase("whatsapp_restore");
  await migrate(pool);
  await migrate(pool);
  const adminId = randomUUID();
  await pool.query(
    "INSERT INTO users(id,name,email,password_hash,role) VALUES($1,'测试管理员','admin@wa.invalid',$2,'admin')",
    [adminId, await hashPassword(password)],
  );
  await start();
  const admin = await login("admin@wa.invalid");
  const aId = (
      await ok(admin, "/team", "POST", {
        name: "销售A",
        email: "a@wa.invalid",
        password,
        role: "sales",
      })
    ).id,
    bId = (
      await ok(admin, "/team", "POST", {
        name: "销售B",
        email: "b@wa.invalid",
        password,
        role: "sales",
      })
    ).id;
  let a = await login("a@wa.invalid");
  const b = await login("b@wa.invalid");
  const aa = await bindAccount(
      pool,
      config,
      {
        userId: aId,
        wabaId: waba,
        phone: {
          id: phoneA,
          display_phone_number: "+12025550101",
          verified_name: "TEST A",
        },
        token,
        subscriptionStatus: "subscribed",
      },
      admin.user,
    ),
    bb = await bindAccount(
      pool,
      config,
      {
        userId: bId,
        wabaId: waba,
        phone: {
          id: phoneB,
          display_phone_number: "+12025550102",
          verified_name: "TEST B",
        },
        token,
        subscriptionStatus: "subscribed",
      },
      admin.user,
    );
  await assert.rejects(
    () =>
      bindAccount(
        pool,
        config,
        {
          userId: bId,
          wabaId: waba,
          phone: { id: phoneA, display_phone_number: "+12025550101" },
          token,
        },
        admin.user,
      ),
    /已绑定其他员工/,
  );
  const view = await ok(a, "/whatsapp/config");
  assert.equal(view.accounts.length, 1);
  assert.equal(view.accounts[0].id, aa.id);
  assert.ok(
    !JSON.stringify(await ok(admin, "/whatsapp/config")).includes(token),
  );
  assert.ok(
    !(
      await pool.query("SELECT token_encrypted FROM whatsapp_accounts")
    ).rows.some((r) => r.token_encrypted === token),
  );
  assert.equal(
    (await request(a, `/whatsapp/accounts/${bb.id}/test`, "POST", {})).status,
    404,
  );
  await ok(a, `/whatsapp/accounts/${aa.id}/test`, "POST", {});
  pass(
    "真实管理员创建销售A/B并独立登录；号码唯一绑定；永久Token不回显且加密入库",
  );
  assert.equal(
    (
      await request(a, "/whatsapp/signup/start", "POST", {
        existingCloudApiConfirmed: true,
      })
    ).status,
    503,
  );
  config.origin = "https://test.invalid";
  const signup = await ok(a, "/whatsapp/signup/start", "POST", {
    existingCloudApiConfirmed: true,
  });
  const authBody = {
    sessionId: signup.id,
    code: "simulated-one-time-code",
    wabaId: waba,
    phoneNumberId: phoneA,
  };
  assert.equal(
    (await request(b, "/whatsapp/signup/complete", "POST", authBody)).status,
    409,
  );
  await ok(a, "/whatsapp/signup/complete", "POST", authBody);
  assert.equal(
    (await request(a, "/whatsapp/signup/complete", "POST", authBody)).status,
    409,
  );
  config.origin = origin;
  pass(
    "正式授权服务端模拟：缺HTTPS拒绝、授权会话绑定本人、code流程一次消费；未验证真实Meta弹窗",
  );
  const verified = await fetch(
    origin +
      `/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${config.verifyToken}&hub.challenge=test-challenge`,
  );
  assert.equal(verified.status, 200);
  assert.equal(await verified.text(), "test-challenge");
  assert.equal(
    (
      await fetch(
        origin +
          "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x",
      )
    ).status,
    403,
  );
  const first = textPayload(
    phoneA,
    client1,
    "wamid.in.1",
    "Company: Aurora Glass; Country: UK; Email: buyer@example.invalid; quantity: 20; aluminum windows",
  );
  assert.equal(await webhook(first, "sha256=" + "0".repeat(64)), 401);
  assert.equal(await count("customers"), 0);
  assert.equal(await webhook(first), 200);
  assert.equal(await count("customers"), 0);
  await service.processEvents();
  assert.equal(await count("customers"), 1);
  await receive(first);
  await receive({ ...first, extra: "different delivery envelope" });
  await receive(textPayload(phoneA, client1, "wamid.in.2"));
  assert.equal(await count("customers"), 1);
  assert.equal(await count("whatsapp_messages"), 2);
  assert.equal(await count("notifications", "kind='whatsapp'"), 2);
  const c1 = (
    await pool.query("SELECT id FROM customers WHERE wa_id=$1", [client1])
  ).rows[0].id;
  const basic = await customer(c1);
  assert.equal(basic.owner_id, aId);
  assert.equal(basic.grade, "C");
  assert.equal(basic.company, "");
  assert.equal(basic.data.country, "");
  assert.equal(basic.data.contact, "Test Client One");
  assert.equal(basic.data.source, "WhatsApp自动录入");
  await receive(textPayload(phoneB, client2, "wamid.in.b"));
  const c2 = (
    await pool.query("SELECT id FROM customers WHERE wa_id=$1", [client2])
  ).rows[0].id;
  assert.equal((await customer(c2)).owner_id, bId);
  assert.equal(
    (await request(a, `/whatsapp/customers/${c2}/chat`)).status,
    404,
  );
  assert.equal((await request(a, `/customers/${c2}`)).status, 404);
  assert.equal((await ok(a, "/whatsapp/summary")).metrics.total, 1);
  assert.equal(
    (await ok(a, "/whatsapp/summary")).daily.reduce(
      (n: number, r: { count: number }) => n + r.count,
      0,
    ),
    1,
  );
  assert.equal(
    (await request(a, "/whatsapp/assignment-candidates")).status,
    403,
  );
  assert.equal(
    (await ok(admin, `/whatsapp/assignment-candidates?ownerId=${aId}`)).total,
    1,
  );
  assert.equal(
    (await ok(admin, "/whatsapp/assignment-candidates?page=2")).items.length,
    0,
  );
  assert.equal((await ok(a, "/customers")).total, 1);
  let ca = await chat(a, c1),
    conv = ca.conversations[0].id;
  const bconv = (await chat(b, c2)).conversations[0].id;
  assert.equal(
    (
      await request(a, "/whatsapp/send", "POST", {
        conversationId: bconv,
        text: "forbidden",
      })
    ).status,
    404,
  );
  assert.equal(
    (await request(a, `/whatsapp/conversations/${bconv}/read`, "POST", {}))
      .status,
    404,
  );
  const suggestion = ca.suggestions.find((s) => s.field === "company")!;
  await ok(a, `/whatsapp/suggestions/${suggestion.id}/review`, "POST", {
    accept: true,
    version: ca.customerVersion,
  });
  assert.equal((await customer(c1)).company, "Aurora Glass");
  const other = ca.suggestions.find((s) => s.field === "country")!;
  assert.equal(
    (
      await request(a, `/whatsapp/suggestions/${other.id}/review`, "POST", {
        accept: true,
        version: ca.customerVersion,
      })
    ).status,
    409,
  );
  pass(
    "签名校验、持久化后ACK、事件/消息双幂等、AB员工自动归属与接口隔离、资料人工确认及版本冲突",
  );
  await receive(
    payload(phoneA, client1, [
      {
        id: "wamid.image",
        type: "image",
        image: { id: "media-image", mime_type: "image/png" },
      },
      {
        id: "wamid.audio",
        type: "audio",
        audio: { id: "media-audio", mime_type: "audio/wav" },
      },
      {
        id: "wamid.document",
        type: "document",
        document: {
          id: "media-doc",
          mime_type: "application/pdf",
          filename: "quote.pdf",
        },
      },
      {
        id: "wamid.location",
        type: "location",
        location: { latitude: 1.2, longitude: 3.4, name: "Site A" },
      },
      {
        id: "wamid.contacts",
        type: "contacts",
        contacts: [
          {
            name: { formatted_name: "Contact card" },
            phones: [{ phone: "+447700900111" }],
          },
        ],
      },
      {
        id: "wamid.reply",
        type: "text",
        text: { body: "Quoted specification" },
        context: { id: "wamid.in.1" },
      },
      { id: "wamid.unsupported", type: "future_type" },
    ]),
  );
  await service.processMedia(10);
  ca = await chat(a, c1);
  assert.equal(ca.messages.filter((m) => m.mediaStatus === "ready").length, 3);
  assert.ok(
    ca.messages
      .find((m) => m.whatsappMessageId === "wamid.reply")
      ?.quotedText?.includes("Aurora Glass"),
  );
  const imageId = ca.messages.find((m) => m.messageType === "image")!.id;
  const media = await fetch(
    origin + `/api/whatsapp/messages/${imageId}/media`,
    { headers: { Cookie: a.cookie } },
  );
  assert.equal(media.status, 200);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
  assert.equal(
    (
      await fetch(origin + `/api/whatsapp/messages/${imageId}/media`, {
        headers: { Cookie: b.cookie },
      })
    ).status,
    404,
  );
  assert.equal(
    (await fetch(origin + `/api/whatsapp/messages/${imageId}/media`)).status,
    401,
  );
  const partial = await fetch(
    origin + `/api/whatsapp/messages/${imageId}/media`,
    { headers: { Cookie: a.cookie, Range: "bytes=0-7" } },
  );
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 8);
  pass(
    "图片/语音/文档队列及鉴权下载、Range、联系人/地址/引用/未知类型留存；其他销售和匿名访问被拒绝",
  );
  // 验证辅助提取写库故障不会让基础客户与消息丢失。
  await pool.query(
    "CREATE FUNCTION test_reject_suggestion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.value LIKE '%trigger-extraction-failure%' THEN RAISE EXCEPTION 'synthetic extraction failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_suggestion_failure BEFORE INSERT ON whatsapp_suggestions FOR EACH ROW EXECUTE FUNCTION test_reject_suggestion()",
  );
  await receive(
    textPayload(
      phoneA,
      client1,
      "wamid.extractfail",
      "Company: trigger-extraction-failure",
    ),
  );
  assert.equal(
    await count("whatsapp_messages", "whatsapp_message_id='wamid.extractfail'"),
    1,
  );
  assert.equal(await count("whatsapp_alerts", "code='EXTRACTION'"), 1);
  await pool.query(
    "DROP TRIGGER test_suggestion_failure ON whatsapp_suggestions; DROP FUNCTION test_reject_suggestion()",
  );
  pass("解析写入故障注入：原始入站消息仍提交，管理员获得告警");
  const key = randomUUID(),
    out = await ok(
      a,
      "/whatsapp/send",
      "POST",
      { conversationId: conv, text: "Test quotation reply" },
      key,
    );
  assert.equal(
    (
      await ok(
        a,
        "/whatsapp/send",
        "POST",
        { conversationId: conv, text: "Test quotation reply" },
        key,
      )
    ).id,
    out.id,
  );
  earlyReceipt = true;
  await service.processOutbound();
  let message = (
    await pool.query("SELECT * FROM whatsapp_messages WHERE id=$1", [out.id])
  ).rows[0];
  assert.equal(sendCalls, 1);
  assert.equal(message.delivery_status, "read");
  await receive(
    statusPayload(phoneA, message.whatsapp_message_id, "sent", client1),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT delivery_status FROM whatsapp_messages WHERE id=$1",
        [out.id],
      )
    ).rows[0].delivery_status,
    "read",
  );
  const uncertain = await ok(a, "/whatsapp/send", "POST", {
    conversationId: conv,
    text: "Result unknown",
  });
  failure = new MetaError("UNKNOWN", true);
  await service.processOutbound();
  assert.equal(
    (
      await pool.query(
        "SELECT delivery_status FROM whatsapp_messages WHERE id=$1",
        [uncertain.id],
      )
    ).rows[0].delivery_status,
    "unknown",
  );
  assert.equal(
    (await request(a, `/whatsapp/messages/${uncertain.id}/retry`, "POST", {}))
      .status,
    409,
  );
  await receive(
    statusPayload(
      phoneA,
      "wamid.recovered-response",
      "delivered",
      client1,
      uncertain.id,
    ),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT delivery_status FROM whatsapp_messages WHERE id=$1",
        [uncertain.id],
      )
    ).rows[0].delivery_status,
    "delivered",
  );
  assert.ok(
    (
      await pool.query(
        "SELECT last_outbound_at FROM whatsapp_conversations WHERE id=$1",
        [conv],
      )
    ).rows[0].last_outbound_at,
  );
  const failed = await ok(a, "/whatsapp/send", "POST", {
    conversationId: conv,
    text: "Definite failure",
  });
  failure = new MetaError("131026");
  await service.processOutbound();
  assert.equal(
    (
      await pool.query(
        "SELECT delivery_status FROM whatsapp_messages WHERE id=$1",
        [failed.id],
      )
    ).rows[0].delivery_status,
    "failed",
  );
  await ok(a, `/whatsapp/messages/${failed.id}/retry`, "POST", {});
  await service.processOutbound();
  await pool.query(
    "UPDATE whatsapp_conversations SET last_inbound_at=now()-interval '25 hours' WHERE id=$1",
    [conv],
  );
  assert.equal(
    (
      await request(a, "/whatsapp/send", "POST", {
        conversationId: conv,
        text: "Outside window",
      })
    ).status,
    409,
  );
  await ok(a, `/whatsapp/accounts/${aa.id}/templates/sync`, "POST", {});
  assert.equal(
    (
      await request(a, "/whatsapp/send", "POST", {
        conversationId: conv,
        templateId: "400002",
        consentConfirmed: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(a, "/whatsapp/send", "POST", {
        conversationId: conv,
        templateId: "400001",
        templateParameters: ["Client"],
      })
    ).status,
    400,
  );
  const templated = await ok(a, "/whatsapp/send", "POST", {
    conversationId: conv,
    templateId: "400001",
    templateParameters: ["Client"],
    consentConfirmed: true,
  });
  await service.processOutbound();
  assert.equal(
    (
      await pool.query(
        "SELECT delivery_status FROM whatsapp_messages WHERE id=$1",
        [templated.id],
      )
    ).rows[0].delivery_status,
    "sent",
  );
  assert.equal(sent.at(-1)!.body.type, "template");
  await receive(textPayload(phoneA, client1, "wamid.reopen"));
  conv = (await chat(a, c1)).conversations[0].id;
  pass(
    "人工回复幂等、状态先于HTTP响应及乱序不降级、失败可重试/结果不明不盲重发、24小时及审核模板限制",
  );
  // 未回复应从最早未回复消息算起，而非被客户最近补充消息重置。
  await receive(
    textPayload(phoneB, client2, "wamid.old", "Question pending", 1500),
  );
  await receive(
    textPayload(phoneB, client2, "wamid.new", "Additional details", 1),
  );
  await service.reminders();
  await service.reminders();
  assert.equal(await count("notifications", "kind='whatsapp_timeout'"), 3);
  assert.equal(
    (await ok(b, "/whatsapp/summary")).metrics.overdueConversations,
    1,
  );
  const beforeUnread = (await ok(a, "/whatsapp/summary")).metrics.unread;
  assert.ok(beforeUnread > 0);
  await ok(a, `/whatsapp/conversations/${conv}/read`, "POST", {});
  assert.equal((await ok(a, "/whatsapp/summary")).metrics.unread, 0);
  assert.ok((await ok(b, "/whatsapp/summary")).metrics.unread > 0);
  pass("30/120/1440分钟未回复提醒去重，以最早未回复为准；标记已读只影响本人");
  await receive(
    textPayload(phoneB, client1, "wamid.cross", "Cross employee contact"),
  );
  assert.equal(await count("customers"), 2);
  const conflict = await ok(b, "/whatsapp/conflicts");
  assert.equal(conflict.count, 1);
  assert.deepEqual(conflict.items, []);
  assert.ok(!JSON.stringify(conflict).includes("Aurora"));
  assert.equal(
    (await request(b, `/whatsapp/customers/${c1}/chat`)).status,
    404,
  );
  await assign(admin, c1, bId);
  assert.equal(
    (await request(a, `/whatsapp/customers/${c1}/chat`)).status,
    404,
  );
  assert.ok((await chat(b, c1)).messages.length > 8);
  assert.equal(
    (
      await request(b, "/whatsapp/send", "POST", {
        conversationId: conv,
        text: "Wrong staff number",
      })
    ).status,
    403,
  );
  await receive(textPayload(phoneA, client1, "wamid.keep"));
  assert.equal((await customer(c1)).owner_id, bId);
  await rules(admin, "number_owner");
  await receive(textPayload(phoneA, client1, "wamid.number-owner"));
  assert.equal((await customer(c1)).owner_id, aId);
  await assign(admin, c1, bId);
  await rules(admin, "pool");
  await receive(textPayload(phoneA, client1, "wamid.pool"));
  assert.equal((await customer(c1)).wa_needs_assignment, true);
  assert.equal(
    (await request(b, `/whatsapp/customers/${c1}/chat`)).status,
    404,
  );
  await assign(admin, c1, aId);
  await rules(admin, "keep");
  assert.ok((await chat(a, c1)).assignments.length >= 5);
  pass(
    "跨员工同一客户不复制、不泄密；管理员移交与三种后续入站归属规则；历史完整保留",
  );
  const queued = await ok(a, "/whatsapp/send", "POST", {
      conversationId: conv,
      text: "Must not send after transfer",
    }),
    sentBefore = sendCalls;
  await assign(admin, c1, bId);
  await service.processOutbound();
  assert.equal(sendCalls, sentBefore);
  assert.equal(
    (
      await pool.query(
        "SELECT delivery_status FROM whatsapp_messages WHERE id=$1",
        [queued.id],
      )
    ).rows[0].delivery_status,
    "failed",
  );
  await assign(admin, c1, aId);
  const expiry = await ok(a, "/whatsapp/send", "POST", {
    conversationId: conv,
    text: "Expired token case",
  });
  failure = new MetaError("190");
  await service.processOutbound();
  assert.equal(
    (
      await pool.query("SELECT error_code FROM whatsapp_messages WHERE id=$1", [
        expiry.id,
      ])
    ).rows[0].error_code,
    "190",
  );
  assert.equal(
    (await ok(admin, "/whatsapp/config")).accounts.find(
      (x: { id: string }) => x.id === aa.id,
    ).connectionStatus,
    "error",
  );
  assert.ok(
    (await ok(admin, "/whatsapp/config")).alerts.some(
      (x: { code: string }) => x.code === "190",
    ),
  );
  await ok(a, `/whatsapp/accounts/${aa.id}/test`, "POST", {});
  await receive(textPayload("999999", client1, "wamid.unknown-phone"));
  assert.equal(await count("whatsapp_webhook_events", "status='retry'"), 1);
  assert.ok(
    (await ok(admin, "/whatsapp/config")).alerts.some(
      (x: { code: string }) => x.code === "WEBHOOK",
    ),
  );
  pass(
    "后台发送前重新校验移交权限；Token失效与未知号码事件保留重试并向管理员告警",
  );
  const archive = await backup(pool);
  const restorePool = database(
    `postgresql://postgres:${dbPassword}@127.0.0.1:${port}/whatsapp_restore`,
  );
  try {
    await migrate(restorePool);
    const restored = await restore(restorePool, archive);
    assert.equal(restored.whatsapp_messages, await count("whatsapp_messages"));
    assert.equal(
      (await restorePool.query("SELECT count(*)::int AS n FROM sessions"))
        .rows[0].n,
      0,
    );
    assert.equal(
      decrypt(
        (
          await restorePool.query(
            "SELECT token_encrypted FROM whatsapp_accounts LIMIT 1",
          )
        ).rows[0].token_encrypted,
        config,
      ),
      token,
    );
    await assert.rejects(() => restore(restorePool, archive), /不是空库/);
  } finally {
    await restorePool.end();
  }
  const messageCount = await count("whatsapp_messages");
  await stop();
  await pool.end();
  await pg.stop();
  started = false;
  await pg.start();
  started = true;
  pool = database(url);
  await start();
  assert.equal(await count("whatsapp_messages"), messageCount);
  assert.equal((await chat(a, c1)).conversations.length, 2);
  pass(
    "独立库恢复含消息/媒体/绑定/加密凭据，拒绝覆盖非空库；数据库和服务双重启数据仍在",
  );
  // Browser plugin/browser技能未列出，按frontend-testing-debugging使用项目Playwright回归。
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const desktop = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await desktop.newPage(),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      !m.text().includes("404") &&
      !(m.text().includes("401") && m.location().url.endsWith("/api/auth/me"))
    )
      errors.push(m.text());
  });
  await browserLogin(page, "admin@wa.invalid");
  await page.goto(origin + "/whatsapp/integration");
  await expect(
    page.getByRole("heading", { name: "WhatsApp集成状态", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "当前仅本机地址，Meta不能回调。必须完成公司公网HTTPS部署后再配置真实接入。",
    ),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(root, "desktop-integration.png"),
    fullPage: false,
  });
  await page.goto(origin + "/analytics");
  await expect(
    page.getByRole("heading", {
      name: "每日新增WhatsApp客户（近30天）",
      exact: true,
    }),
  ).toBeVisible();
  const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    }),
    mp = await mobile.newPage();
  mp.on("pageerror", (e) => errors.push(e.message));
  await browserLogin(mp, "a@wa.invalid");
  await mp.goto(origin + "/whatsapp/account");
  await expect(
    mp.getByRole("heading", { name: "我的WhatsApp", exact: true }),
  ).toBeVisible();
  await expect(mp.getByText("永久Token", { exact: false })).toHaveCount(0);
  await mp.goto(origin + "/whatsapp");
  await mp.getByLabel("搜索WhatsApp客户或最近消息").fill("Aurora");
  await mp.locator(".wa-inbox a").first().click();
  await expect(
    mp.getByRole("heading", { name: "WhatsApp聊天", exact: true }),
  ).toBeVisible();
  await mp
    .getByLabel("回复内容", { exact: true })
    .fill("Mobile quotation reply verified");
  await mp
    .getByRole("button", { name: "确认发送WhatsApp", exact: true })
    .click();
  await expect(
    mp.getByText("消息已进入发送队列，请查看送达状态"),
  ).toBeVisible();
  await service.processOutbound();
  await mp.reload();
  await expect(
    mp.getByText("Mobile quotation reply verified", { exact: true }),
  ).toBeVisible();
  await expect(
    mp
      .locator(".wa-message.outbound")
      .filter({ hasText: "Mobile quotation reply verified" }),
  ).toContainText("已发送");
  assert.equal(
    await mp.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    true,
  );
  assert.ok((await mp.title()).includes("奥汀堡"));
  await mp.screenshot({
    path: path.join(root, "mobile-chat.png"),
    fullPage: false,
  });
  await mp.locator(".wa-composer").scrollIntoViewIfNeeded();
  await mp.screenshot({
    path: path.join(root, "mobile-reply.png"),
    fullPage: false,
  });
  await mp.goto(origin + `/customers/${c2}?tab=whatsapp`);
  await expect(mp.getByRole("alert")).toContainText("客户不存在或无权访问");
  assert.equal(
    (
      await mp.request.get(origin + `/api/whatsapp/customers/${c2}/chat`)
    ).status(),
    404,
  );
  await mp.goto(origin + "/whatsapp");
  assert.deepEqual(errors, []);
  pass(
    "Edge桌面1440px/手机390px：独立账号、集成状态、收件箱搜索、聊天与人工回复、越权页面及接口拒绝、无JS异常/横向溢出",
  );
  const u = (await ok(admin, "/team")).find((x: User) => x.id === aId);
  await ok(admin, `/team/${aId}`, "PUT", {
    name: u.name,
    email: u.email,
    role: u.role,
    active: false,
    version: u.version,
  });
  assert.equal((await request(a, "/whatsapp/config")).status, 401);
  assert.equal(
    (await mp.request.get(origin + "/api/whatsapp/inbox")).status(),
    401,
  );
  await receive(textPayload(phoneA, client1, "wamid.disabled"));
  assert.equal((await customer(c1)).wa_needs_assignment, true);
  await assign(admin, c1, bId);
  assert.ok((await chat(b, c1)).messages.length > 0);
  pass("停用员工旧会话立即失效；停用号码入站交管理员；批量移交保留聊天");
  // 恢复测试员工用于验证注销/重新绑定，不操作正式账号。
  const row = (await pool.query("SELECT * FROM users WHERE id=$1", [aId]))
    .rows[0];
  await pool.query("UPDATE users SET active=true WHERE id=$1", [aId]);
  a = await login(row.email);
  const accountView = (await ok(a, "/whatsapp/config")).accounts[0];
  await ok(a, `/whatsapp/accounts/${aa.id}/disconnect`, "POST", {
    version: accountView.version,
    confirm: true,
  });
  assert.equal(
    (await ok(a, "/whatsapp/config")).accounts[0].credentialConfigured,
    false,
  );
  assert.equal(
    (await request(a, `/whatsapp/accounts/${aa.id}/test`, "POST", {})).status,
    409,
  );
  assert.equal(await count("whatsapp_messages"), messageCount + 2);
  await bindAccount(
    pool,
    config,
    {
      userId: aId,
      wabaId: waba,
      phone: { id: phoneA, display_phone_number: "+12025550101" },
      token,
    },
    toUser(row),
  );
  pass("断开仅清除CRM凭据，不删除记录、不注销Meta号码；同员工可重新绑定");
  await writeFile(
    path.join(root, "results.json"),
    JSON.stringify(
      {
        runId,
        completed,
        meta: "SIMULATED transport only; no live WhatsApp delivery",
        artifacts: root,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    `ALL ${completed.length} WHATSAPP CHECK GROUPS PASSED; evidence: ${root}`,
  );
} catch (error) {
  console.error("WHATSAPP INTEGRATION FAILED", error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop().catch(() => {});
  await pool.end().catch(() => {});
  if (started) await pg.stop();
  console.log(
    "隔离WhatsApp测试停止；测试目录保留，未连接真实Meta或更改正式数据。",
  );
}
