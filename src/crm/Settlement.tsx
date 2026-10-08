import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Field, Loading, Panel } from "./ui.tsx";
type File = { id: string; name: string };
function FileChoice({
  files,
  value,
  onChange,
  label,
  required = true,
}: {
  files: File[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  required?: boolean;
}) {
  return (
    <Field label={label}>
      <select
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">请选择本项目已上传的凭证</option>
        {files.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
export function FulfillmentApprovers() {
  const r = useResource<any>("/settings/fulfillment-approvers"),
    users = useResource<any[]>("/team"),
    m = useMutation(),
    { notify } = useSession();
  const [finance, setFinance] = useState<string | undefined>(),
    [release, setRelease] = useState<string | undefined>();
  if (r.loading) return <Loading />;
  return (
    <Panel title="履约财务核验与放单职责">
      <p>
        明确选择真实负责人员。未配置时禁止核验或放单，不自动按显示姓名授权。目前仅支持在职管理员担任核验人员。
      </p>
      <ErrorBox message={r.error || m.error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void m.run(
            "/settings/fulfillment-approvers",
            "PUT",
            {
              financeUserId: (finance ?? r.data?.finance_user_id) || null,
              releaseUserId: (release ?? r.data?.release_user_id) || null,
            },
            () => notify("核验职责已保存并记录审计"),
          );
        }}
      >
        {(
          [
            [
              "财务核验人",
              finance ?? r.data?.finance_user_id ?? "",
              setFinance,
            ],
            [
              "放单审批人",
              release ?? r.data?.release_user_id ?? "",
              setRelease,
            ],
          ] as const
        ).map(([label, value, set]) => (
          <Field label={label} key={label}>
            <select value={value} onChange={(e) => set(e.target.value)}>
              <option value="">未配置（阻止操作）</option>
              {users.data
                ?.filter((u) => u.active && u.role === "admin")
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {u.email}
                  </option>
                ))}
            </select>
          </Field>
        ))}
        <button disabled={m.busy}>保存核验职责</button>
      </form>
    </Panel>
  );
}
export default function Settlement({
  id,
  files,
  projectId,
}: {
  id: string;
  files: File[];
  projectId: string;
}) {
  const { user, revision, refresh } = useSession(),
    r = useResource<any>(`/supply/chain/${id}/settlement`, revision),
    m = useMutation();
  const [method, setMethod] = useState("A"),
    [bill, setBill] = useState("to_order"),
    [percent, setPercent] = useState("30");
  const [proof, setProof] = useState<Record<string, string>>({}),
    [checks, setChecks] = useState<Record<string, boolean>>({});
  const [receipt, setReceipt] = useState({
    amount: "",
    reference: "",
    receivedAt: "",
    fileId: "",
  });
  const [forwarder, setForwarder] = useState({
    company: "",
    contact: "",
    channel: "",
    pickupAt: "",
    port: "",
    vehicle: "",
    driver: "",
    fileId: "",
  });
  const [stageFile, setStageFile] = useState(""),
    [stageNote, setStageNote] = useState(""),
    [stageAt, setStageAt] = useState("");
  const [releaseFile, setReleaseFile] = useState(""),
    [releaseType, setReleaseType] = useState("original_bl");
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  const d = r.data,
    base = `/supply/chain/${id}`,
    admin = user.role === "admin";
  const run = (path: string, body: unknown) =>
    void m.run(base + path, "POST", body, refresh);
  return (
    <Panel title="付款、货代与凭证核实">
      <ErrorBox message={m.error} />
      <p>
        正式报价：{d.total} {d.currency}；已核实到账：{d.paid}；未结：
        {d.remaining}。{d.settled ? "已结清" : "未结清不放单"}
      </p>
      <p>
        提前到账单独记账，不跳过22态。这里仅登记已发生事实，不转账、不自动向客户或货代发送文件。
      </p>
      {admin && (
        <p>
          <Link to={`/quotations/${projectId}`}>在报价项目上传真实凭证</Link>
          ；核验人员在系统设置中配置。
        </p>
      )}
      {d.terms ? (
        <p>
          已锁定付款方式 {d.terms.method} · 定金 {d.terms.deposit_percent}% ·
          提单 {d.terms.bill_type}。原依据不可覆盖。
        </p>
      ) : (
        admin && (
          <details>
            <summary>核实合同付款条件 A / B / C</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run("/payment-terms", {
                  method,
                  customerForwarder: method === "C",
                  billType: bill,
                  depositPercent: Number(percent),
                  contractFileId: proof.contract || "",
                  repeatFileId: proof.repeat || null,
                  namedConsentFileId: proof.named || null,
                  guaranteeFileId: proof.guarantee || null,
                  blDraftFileId: proof.draft || null,
                  blChecks: Object.fromEntries(
                    [
                      "shipper",
                      "consignee",
                      "goods",
                      "quantity",
                      "amount",
                      "seal",
                    ].map((k) => [k, !!checks[k]]),
                  ),
                });
              }}
            >
              <p>
                登记实际合同依据，不代表系统生成或签署法律终稿。低于30%须股东会签，当前不允许例外。
              </p>
              <Field label="付款方式">
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                >
                  <option value="A">A 新客：30%＋70%装船前</option>
                  <option value="B">B 复购：30%＋70%见提单副本</option>
                  <option value="C">C 客户指定货代：至少50%或装船前付清</option>
                </select>
              </Field>
              <Field label="合同定金比例 %">
                <input
                  required
                  type="number"
                  min="30"
                  max="100"
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                />
              </Field>
              <Field label="提单类型">
                <select value={bill} onChange={(e) => setBill(e.target.value)}>
                  <option value="to_order">To Order 指示提单</option>
                  <option value="telex">电放（结清后才能下指令）</option>
                  <option value="named">记名提单（须书面同意）</option>
                  <option value="seaway">海运单（须已结清）</option>
                </select>
              </Field>
              {(
                [
                  ["contract", "实际合同/客户确认依据", true],
                  ["repeat", "复购依据", method === "B"],
                  ["named", "我方同意记名提单的书面凭证", bill === "named"],
                  ["guarantee", "客户指定货代放货保函", method === "C"],
                  ["draft", "已核对的提单草稿", method === "C"],
                ] as const
              )
                .filter(([key, , required]) => key === "contract" || required)
                .map(([key, label, required]) => (
                  <FileChoice
                    key={key}
                    files={files}
                    label={label}
                    value={proof[key] || ""}
                    required={required}
                    onChange={(v) => setProof({ ...proof, [key]: v })}
                  />
                ))}
              {method === "C" && (
                <fieldset>
                  <legend>提单草稿六项人工核对</legend>
                  {(
                    [
                      ["shipper", "Shipper"],
                      ["consignee", "Consignee"],
                      ["goods", "品名"],
                      ["quantity", "数量"],
                      ["amount", "金额"],
                      ["seal", "封条号"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        required
                        checked={!!checks[key]}
                        onChange={(e) =>
                          setChecks({ ...checks, [key]: e.target.checked })
                        }
                      />
                      {label}已核对{" "}
                    </label>
                  ))}
                </fieldset>
              )}
              <button disabled={m.busy}>核实并锁定付款依据</button>
            </form>
          </details>
        )
      )}
      {admin && (
        <details>
          <summary>登记追加到账（财务核验）</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run("/receipts", {
                amount: receipt.amount,
                currency: d.currency,
                bankReference: receipt.reference,
                receivedAt: new Date(receipt.receivedAt).toISOString(),
                fileId: receipt.fileId,
              });
            }}
          >
            <p>已有定金已计入，不要重复登记；新增收款签发AR并永久留档。</p>
            <Field label={`本次实际到账金额 ${d.currency}`}>
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={receipt.amount}
                onChange={(e) =>
                  setReceipt({ ...receipt, amount: e.target.value })
                }
              />
            </Field>
            <Field label="银行流水号">
              <input
                required
                value={receipt.reference}
                onChange={(e) =>
                  setReceipt({ ...receipt, reference: e.target.value })
                }
              />
            </Field>
            <Field label="实际到账时间">
              <input
                required
                type="datetime-local"
                value={receipt.receivedAt}
                onChange={(e) =>
                  setReceipt({ ...receipt, receivedAt: e.target.value })
                }
              />
            </Field>
            <FileChoice
              label="到账凭证"
              files={files}
              value={receipt.fileId}
              onChange={(fileId) => setReceipt({ ...receipt, fileId })}
            />
            <button disabled={m.busy}>财务确认到账</button>
          </form>
          {d.receipts.map((r: any) => (
            <p key={r.id}>
              {r.doc_no} · {r.amount} {r.currency} · {r.bank_reference}
            </p>
          ))}
        </details>
      )}
      {d.forwarder ? (
        <p>
          货代：{d.forwarder.company} ·{" "}
          {d.forwarder.source === "customer_nominated"
            ? "客户指定（无指令权，经客户协调）"
            : "我方代找"}{" "}
          · {d.forwarder.port}
        </p>
      ) : (
        admin &&
        d.terms && (
          <details>
            <summary>登记货代与提货安排</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run("/forwarder", {
                  ...forwarder,
                  pickupAt: new Date(forwarder.pickupAt).toISOString(),
                  source: d.terms.customer_forwarder
                    ? "customer_nominated"
                    : "we_arranged",
                });
              }}
            >
              {(
                [
                  ["company", "货代公司"],
                  ["contact", "联系人"],
                  ["channel", "联系渠道"],
                  ["port", "装运港"],
                  ["vehicle", "车辆资料"],
                  ["driver", "司机资料"],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    required
                    value={forwarder[key]}
                    onChange={(e) =>
                      setForwarder({ ...forwarder, [key]: e.target.value })
                    }
                  />
                </Field>
              ))}
              <Field label="约定提货时间">
                <input
                  required
                  type="datetime-local"
                  value={forwarder.pickupAt}
                  onChange={(e) =>
                    setForwarder({ ...forwarder, pickupAt: e.target.value })
                  }
                />
              </Field>
              <FileChoice
                label="货代指定/提货安排凭证"
                files={files}
                value={forwarder.fileId}
                onChange={(fileId) => setForwarder({ ...forwarder, fileId })}
              />
              <button disabled={m.busy}>核实并保存货代安排</button>
            </form>
          </details>
        )
      )}
      {admin && d.next?.ordinal >= 6 && d.next?.ordinal <= 18 && (
        <details>
          <summary>下一节点：{d.next.name_cn}</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run("/verify-stage", {
                stage: d.next.code,
                fileId: stageFile,
                note: stageNote,
                occurredAt: new Date(stageAt).toISOString(),
              });
            }}
          >
            <p>质检、包装、物流回传和付款条件由服务器逐项核对，不能跳级。</p>
            <FileChoice
              label="本节点事实凭证"
              files={files}
              value={stageFile}
              onChange={setStageFile}
            />
            <Field label="事实说明">
              <textarea
                required
                minLength={2}
                value={stageNote}
                onChange={(e) => setStageNote(e.target.value)}
              />
            </Field>
            <Field label="实际发生时间">
              <input
                required
                type="datetime-local"
                value={stageAt}
                onChange={(e) => setStageAt(e.target.value)}
              />
            </Field>
            <label>
              <input required type="checkbox" />
              我已核实凭证与实际情况一致
            </label>
            <button disabled={m.busy}>核实并完成该节点</button>
          </form>
        </details>
      )}
      {d.release ? (
        <p>
          已登记人工放单：{d.release.type} ·{" "}
          {new Date(d.release.releasedAt).toLocaleString()}
        </p>
      ) : (
        admin && (
          <details>
            <summary>放单核验（必须结清）</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run("/release", {
                  releaseType,
                  fileId: releaseFile,
                  confirmSettled: true,
                });
              }}
            >
              <Field label="放单类型">
                <select
                  value={releaseType}
                  onChange={(e) => setReleaseType(e.target.value)}
                >
                  <option value="original_bl">释放正本提单</option>
                  <option value="telex">电放指令</option>
                  <option value="delivery_permit">放货许可</option>
                </select>
              </Field>
              <FileChoice
                label="放单审批凭证"
                files={files}
                value={releaseFile}
                onChange={setReleaseFile}
              />
              <label>
                <input required type="checkbox" disabled={!d.settled} />
                已核实全额到账，同意放单
              </label>
              <button disabled={m.busy || !d.settled}>
                人工批准并登记放单
              </button>
              <p>仅保存审批，不自动发送。未结清的直接接口请求同样拒绝。</p>
            </form>
          </details>
        )
      )}
    </Panel>
  );
}
