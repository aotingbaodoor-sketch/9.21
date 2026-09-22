import { lazy, Suspense, useState } from "react";
import {
  factoryRuleSchema,
  pricingLabels,
  basisLabels,
  type FactoryProduct,
} from "../../shared/factory.ts";
import { useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Field, Loading, Panel, Modal } from "./ui.tsx";
import { Purchase } from "./SupplyChain.tsx";
import { NumberField } from "./NumberField.tsx";
const FactoryProductEditor = lazy(() =>
  import("./FactoryProductEditor.tsx").then((module) => ({
    default: module.FactoryProductEditor,
  })),
);

type PurchaseOrder = {
  id: string;
  order_number: string;
  status: string;
  promised_date: string | null;
  factory_name: string;
  company?: string;
};
const labels: Record<string, string> = {
  draft: "草稿",
  submitted: "待公司审核",
  approved: "已发布销售目录",
  rejected: "已驳回",
  disabled: "已停用",
};

export function FactoryProducts() {
  const { user, revision } = useSession(),
    products = useResource<FactoryProduct[]>(
      "/supply/factory-products",
      revision,
    );
  const [editor, setEditor] = useState<FactoryProduct | "new" | null>(null);
  if (products.loading) return <Loading />;
  return (
    <Panel title={user.role === "factory" ? "我的供货产品" : "工厂产品审核"}>
      <p className="quote-help">
        工厂录入供货成本，公司单独设置销售价。只有审核通过的版本才会发布到销售目录。
      </p>
      {user.role === "factory" && (
        <button className="primary" onClick={() => setEditor("new")}>
          ＋ 录入供货产品
        </button>
      )}
      <ErrorBox message={products.error} />
      <div className="factory-catalog-grid">
        {products.data?.map((p) => (
          <FactoryProductCard
            key={`${p.id}:${p.version}`}
            product={p}
            edit={() => setEditor(p)}
          />
        ))}
      </div>
      {!products.data?.length && (
        <div className="supply-empty">暂无供货产品。</div>
      )}
      {editor && (
        <Modal
          title={editor === "new" ? "录入供货产品" : `编辑 ${editor.sku}`}
          close={() => setEditor(null)}
        >
          <Suspense fallback={<Loading />}>
            <FactoryProductEditor
              key={editor === "new" ? "new" : editor.id}
              product={editor === "new" ? undefined : editor}
              close={() => setEditor(null)}
            />
          </Suspense>
        </Modal>
      )}
    </Panel>
  );
}
function FactoryProductCard({
  product: p,
  edit,
}: {
  product: FactoryProduct;
  edit: () => void;
}) {
  const { user, refresh, notify } = useSession(),
    m = useMutation(),
    rule = factoryRuleSchema.parse(p.pricing_rule);
  const writable =
    user.role === "factory" && ["draft", "rejected"].includes(p.status);
  const [reading, setReading] = useState(false);
  const action = (name: string, message: string) =>
    void m.run(
      `/supply/factory-products/${p.id}/${name}`,
      "POST",
      { version: p.version },
      () => {
        notify(message);
        refresh();
      },
    );
  const upload = async (file: File) => {
    if (
      file.size > 2 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    ) {
      m.setError("请选择不超过2MB的 PNG、JPEG 或 WebP 图片");
      return;
    }
    setReading(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(file);
      });
      await m.run(
        `/supply/factory-products/${p.id}/images`,
        "POST",
        { name: file.name, mime: file.type, data, version: p.version },
        () => {
          notify("产品图片已保存");
          refresh();
        },
      );
    } catch {
      m.setError("图片读取失败，请重新选择");
    } finally {
      setReading(false);
    }
  };
  return (
    <article className="factory-product">
      <div className="factory-product-head">
        <b>
          {p.sku} · {p.name_zh}
        </b>
        <span className="supply-status">{labels[p.status] ?? p.status}</span>
      </div>
      <p>
        {p.factory_name} · {p.category} · {p.series || "未填写系列"}
      </p>
      <p>{p.specification || "未填写规格"}</p>
      <dl>
        <dt>工厂供货价</dt>
        <dd>
          {p.currency} {Number(p.supply_price).toFixed(2)}
        </dd>
        <dt>计价方式</dt>
        <dd>{pricingLabels[p.pricing_method]}</dd>
        <dt>交期 / 价格有效期</dt>
        <dd>
          {p.lead_days}天 / {rule.priceValidUntil ?? "未填写"}
        </dd>
      </dl>
      <div className="factory-images">
        {(p.image_ids ?? []).map((id, i) => (
          <a
            key={id}
            href={`/api/supply/factory-product-images/${id}`}
            target="_blank"
            rel="noreferrer"
          >
            <img
              src={`/api/supply/factory-product-images/${id}`}
              loading="lazy"
              alt={`${p.name_zh} 产品图${i + 1}`}
            />
          </a>
        ))}
      </div>
      {!!p.image_urls?.length && (
        <p className="quote-help">
          保留了{p.image_urls.length}
          个旧图片地址。为避免外部图片失效或跟踪，请在草稿中上传图片文件；旧网址不自动加载。
        </p>
      )}
      <details>
        <summary>查看尺寸、规格和供货规则</summary>
        <p>
          宽{rule.minWidthMm}–{rule.maxWidthMm}mm；高{rule.minHeightMm}–
          {rule.maxHeightMm}mm；最低计费面积{rule.minArea}㎡
        </p>
        <dl>
          {Object.entries(rule.standardSpecs)
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
        <p>
          包装：{rule.packing.type || "未配置"}；厚度{rule.packing.depthMm}
          mm；每包{rule.packing.unitsPerPackage}件；包装成本
          {rule.packing.costPerPackage ?? "待填"} CNY
        </p>
        <p>
          宽/高余量 {rule.packing.widthAllowanceMm}/
          {rule.packing.heightAllowanceMm}mm；净重
          {rule.packing.kgPerSqm ?? "待填"}kg/㎡＋
          {rule.packing.fixedKg ?? "待填"}kg/件；皮重
          {rule.packing.tareKg ?? "待填"}kg/包
        </p>
        {rule.bands.map((b, i) => (
          <p key={i}>
            面积≤{b.maxArea}㎡：供货{b.cost} CNY/件
          </p>
        ))}
        {rule.formula.map((f, i) => (
          <p key={i}>
            {f.name}：{basisLabels[f.basis]} × {f.coefficient} × 成本{f.cost}
          </p>
        ))}
        {rule.options.map((o) => (
          <p key={o.id}>
            {o.nameZh}（{basisLabels[o.basis]}）：成本{o.cost ?? "待填"}；
            {o.required ? "必选" : "可选"}
          </p>
        ))}
      </details>
      {p.review_note && (
        <p className="quote-issues">审核意见：{p.review_note}</p>
      )}
      {writable && (
        <>
          <Field label="上传产品图片（每张≤2MB，最多12张）">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={m.busy || reading || (p.image_ids?.length ?? 0) >= 12}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
          </Field>
          <div className="actions">
            <button disabled={m.busy || reading} onClick={edit}>
              编辑产品及计价规则
            </button>
            <button
              className="primary"
              disabled={m.busy || reading}
              onClick={() => action("submit", "已提交公司审核")}
            >
              提交公司审核
            </button>
          </div>
        </>
      )}
      {user.role === "factory" && p.status === "approved" && (
        <>
          <p className="quote-help">
            发起修订后可修改产品、成本和图片；再次审核通过前，销售目录保持旧版本。
          </p>
          <button
            disabled={m.busy}
            onClick={() =>
              action("revise", "已建立修订草稿，可以编辑后重新提交审核")
            }
          >
            发起修订
          </button>
        </>
      )}
      {user.role === "admin" && p.status === "submitted" && (
        <ProductReview product={p} />
      )}
      <ErrorBox message={m.error} />
    </article>
  );
}
function ProductReview({ product: p }: { product: FactoryProduct }) {
  const { refresh, notify } = useSession(),
    m = useMutation(),
    rule = factoryRuleSchema.parse(p.pricing_rule);
  const [note, setNote] = useState(""),
    [guide, setGuide] = useState<number | null>(null),
    [minimum, setMinimum] = useState<number | null>(null),
    [retail, setRetail] = useState<number | null>(null),
    [packing, setPacking] = useState<number | null>(null);
  const [bands, setBands] = useState<(number | null)[]>(() =>
      rule.bands.map(() => null),
    ),
    [formula, setFormula] = useState<(number | null)[]>(() =>
      rule.formula.map(() => null),
    ),
    [options, setOptions] = useState<Record<string, number | null>>({});
  const ready =
    guide !== null &&
    minimum !== null &&
    guide >= minimum &&
    packing !== null &&
    bands.every((v) => v !== null) &&
    formula.every((v) => v !== null) &&
    rule.options.every((o) => options[o.id] != null);
  const review = (status: "approved" | "rejected") =>
    void m.run(
      `/supply/factory-products/${p.id}/review`,
      "POST",
      {
        status,
        note,
        guidePrice: guide,
        minimumPrice: minimum,
        retailPrice: retail,
        active: true,
        version: p.version,
        ...(status === "approved"
          ? {
              commercial: {
                packingSale: packing,
                bandSales: bands,
                formulaSales: formula,
                optionSales: options,
              },
            }
          : {}),
      },
      () => {
        notify(
          status === "approved" ? "已发布到销售产品目录" : "已退回工厂修改",
        );
        refresh();
      },
    );
  return (
    <div className="factory-review">
      <h4>公司销售定价（人民币）</h4>
      <p className="quote-help">
        请填写真实销售价格，不会自动按供货价加成。0表示已确认不收费，空白表示未配置。
      </p>
      <NumberField
        label="销售指导价"
        nullable
        value={guide}
        onChange={setGuide}
      />
      <NumberField
        label="最低销售价"
        nullable
        value={minimum}
        onChange={setMinimum}
      />
      <NumberField
        label="建议零售价（可空）"
        nullable
        value={retail}
        onChange={setRetail}
      />
      <NumberField
        label={`包装销售价 / 包（供货成本 ${rule.packing.costPerPackage}）`}
        nullable
        value={packing}
        onChange={setPacking}
      />
      {rule.bands.map((b, i) => (
        <NumberField
          key={i}
          label={`档位${i + 1} 销售价 / 件（≤${b.maxArea}㎡，成本${b.cost}）`}
          nullable
          value={bands[i]}
          onChange={(v) => setBands(bands.map((r, n) => (n === i ? v : r)))}
        />
      ))}
      {rule.formula.map((f, i) => (
        <NumberField
          key={i}
          label={`构成${i + 1} ${f.name} 销售单价（成本${f.cost}）`}
          nullable
          value={formula[i]}
          onChange={(v) => setFormula(formula.map((r, n) => (n === i ? v : r)))}
        />
      ))}
      {rule.options.map((o) => (
        <NumberField
          key={o.id}
          label={`选配 ${o.nameZh} 销售价（成本${o.cost}）`}
          nullable
          value={options[o.id] ?? null}
          onChange={(v) => setOptions({ ...options, [o.id]: v })}
        />
      ))}
      <Field label="审核意见">
        <textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="actions">
        <button
          className="primary"
          disabled={m.busy || !ready}
          onClick={() => review("approved")}
        >
          审核通过并发布
        </button>
        <button
          disabled={m.busy || !note.trim()}
          onClick={() => review("rejected")}
        >
          退回修改
        </button>
      </div>
      <ErrorBox message={m.error} />
    </div>
  );
}
export function FactoryOrders() {
  const { user, revision } = useSession(),
    orders = useResource<PurchaseOrder[]>("/supply/purchase-orders", revision),
    [selected, setSelected] = useState("");
  if (orders.loading) return <Loading />;
  return (
    <>
      <Panel title={user.role === "factory" ? "工厂采购订单" : "我的跟单任务"}>
        <p className="quote-help">
          {user.role === "factory"
            ? "只显示本工厂采购订单，可确认接单并提交生产反馈。"
            : "只显示已分配给你的采购订单，可审核反馈、质检、返工及分批发货。"}
        </p>
        <ErrorBox message={orders.error} />
        <div className="supply-grid">
          {orders.data?.map((o) => (
            <button
              className="supply-card"
              key={o.id}
              onClick={() => setSelected(o.id)}
            >
              <b>{o.order_number}</b>
              <span>{o.company}</span>
              <span className="supply-status">{o.status}</span>
              <small>
                {o.factory_name} · 交期{o.promised_date || "待确认"}
              </small>
            </button>
          ))}
        </div>
        {!orders.data?.length && (
          <div className="supply-empty">暂时没有分配给本账号的采购订单。</div>
        )}
      </Panel>
      {selected && <Purchase key={selected} id={selected} />}
    </>
  );
}
