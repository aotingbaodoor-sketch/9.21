import { useResource, useMutation } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Loading } from "./ui.tsx";
import { Link, useParams } from "react-router-dom";
export function DocumentClasses() {
  const { revision, refresh } = useSession(),
    r = useResource<any[]>("/settings/document-classes", revision),
    m = useMutation();
  if (r.loading) return <Loading />;
  return (
    <section className="card">
      <h2>9.1 单据类码</h2>
      <p>
        24类：A类9个、B类15个。名称与格式读取服务器配置；停用仅阻止新发号，历史单据继续保留。MO新定义仅适用于新增生产指令，不改写历史文件。
      </p>
      <ErrorBox message={r.error || m.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>类码</th>
              <th>名称 / English</th>
              <th>A/B</th>
              <th>编号格式</th>
              <th>新发号</th>
            </tr>
          </thead>
          <tbody>
            {r.data?.map((c) => (
              <tr key={c.code}>
                <td>{c.code}</td>
                <td>
                  {c.name_cn}
                  <br />
                  {c.name_en}
                </td>
                <td>{c.family}</td>
                <td>{c.number_format}</td>
                <td>
                  <button
                    disabled={m.busy}
                    onClick={() =>
                      void m.run(
                        `/settings/document-classes/${c.code}`,
                        "PUT",
                        { enabled: !c.enabled },
                        refresh,
                      )
                    }
                  >
                    {c.enabled ? "已启用 · 点击停用" : "已停用 · 点击启用"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
export function NumberingLedger() {
  const r = useResource<any>("/master-data/numbering");
  if (r.loading) return <Loading />;
  return (
    <>
      <ErrorBox message={r.error} />
      <section className="card">
        <h2>8.7 统一发号台账</h2>
        <p>
          直接读取既有发号登记与客户编号，不建立第二份编号池。最近1000份单据；作废不释放号位。
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>已落库编号</th>
                <th>类型</th>
                <th>业务日期</th>
                <th>客户</th>
              </tr>
            </thead>
            <tbody>
              {r.data?.documents.map((d: any) => (
                <tr key={d.id}>
                  <td>{d.doc_no}</td>
                  <td>
                    {d.class_code} / {d.family}
                  </td>
                  <td>{d.doc_date}</td>
                  <td>
                    {d.customer_id ? (
                      <Link to={`/customers/${d.customer_id}/chain`}>
                        客户单据链
                      </Link>
                    ) : (
                      "明细行多客户关联"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>永久客户编号</h2>
        <table>
          <thead>
            <tr>
              <th>客户编号</th>
              <th>客户</th>
              <th>追溯</th>
            </tr>
          </thead>
          <tbody>
            {r.data?.customers.map((c: any) => (
              <tr key={c.id}>
                <td>{c.crm_customer_code}</td>
                <td>{c.company}</td>
                <td>
                  <Link to={`/customers/${c.id}/chain`}>查看全链</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>发号池</h2>
        <table>
          <thead>
            <tr>
              <th>独立范围键</th>
              <th>已发最大流水</th>
              <th>下一个流水（非预先发号）</th>
            </tr>
          </thead>
          <tbody>
            {r.data?.sequences.map((s: any) => (
              <tr key={s.scope_key}>
                <td>{s.scope_key}</td>
                <td>{s.last_value}</td>
                <td>{s.last_value + 1}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          客户、合伙人与单据的现有池均保留；EMP/SUP/AST与预留码段的建档发号界面仍在后续实施范围。
        </p>
      </section>
    </>
  );
}
export function CustomerDocumentChain() {
  const { id } = useParams(),
    r = useResource<any>(`/customers/${id}/document-chain`);
  if (r.loading) return <Loading />;
  return (
    <section className="card">
      <Link to={`/customers/${id}`}>← 客户详情</Link>
      <h2>客户单据与履约追溯</h2>
      <p>
        按独立客户关联查询，包含表头和多客户明细关联；不会按编号前缀推算客户。
      </p>
      <ErrorBox message={r.error} />
      <table>
        <thead>
          <tr>
            <th>单据号</th>
            <th>类别</th>
            <th>业务日期</th>
            <th>工单追溯</th>
          </tr>
        </thead>
        <tbody>
          {r.data?.documents.map((d: any) => (
            <tr key={d.id}>
              <td>{d.doc_no}</td>
              <td>{d.class_code}</td>
              <td>{d.doc_date}</td>
              <td>
                {d.work_order_id ? (
                  <Link to={`/supply/chain/${d.work_order_id}`}>工单详情</Link>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>外部回传件</h3>
      {r.data?.logistics.map((l: any) => (
        <p key={l.id}>
          {l.wo_no} · {l.doc_type} · {l.external_no || "未提供外部单号"} ·{" "}
          {l.check_result}
        </p>
      ))}
    </section>
  );
}
