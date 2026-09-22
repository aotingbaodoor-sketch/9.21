import { useState } from "react";
import { Link } from "react-router-dom";
import type { CustomerInput, User } from "../../shared/contracts.ts";
import { download, useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Panel } from "./ui.tsx";
type Legacy = Record<string, unknown>;
type Preview = {
  id: string;
  rows: {
    index: number;
    data: CustomerInput;
    alreadyImported: boolean;
    duplicates: { id: string; company: string }[];
  }[];
};
export default function ImportPage() {
  const { revision, notify, refresh } = useSession(),
    team = useResource<User[]>("/team", revision),
    m = useMutation(),
    [rows, setRows] = useState<Legacy[]>([]),
    [ownerMap, setOwnerMap] = useState<Record<string, string>>({}),
    [backedUp, setBacked] = useState(false),
    [preview, setPreview] = useState<Preview | null>(null),
    [include, setInclude] = useState<number[]>([]),
    [result, setResult] = useState<{
      count: number;
      customers: { id: string; company: string }[];
    } | null>(null);
  const owners = [
    ...new Set(rows.map((r) => String(r.ownerId || r.owner || "未分配"))),
  ];
  const load = (value: unknown) => {
    const data = value as {
      customers?: Legacy[];
      abcrm?: Legacy[];
      "ab-customers"?: Legacy[];
    };
    const customers = Array.isArray(value)
      ? value
      : data.customers || data.abcrm || data["ab-customers"];
    if (!Array.isArray(customers) || !customers.length)
      throw new Error("未找到客户数组。支持旧版备份或本系统导出文件。");
    if (customers.length > 1000)
      throw new Error("单次最多导入1000位客户，请拆分文件");
    setRows(customers);
    setOwnerMap({});
    setBacked(false);
    setPreview(null);
    setResult(null);
  };
  const localBackup = () => {
    try {
      const raw =
        localStorage.getItem("abcrm") || localStorage.getItem("ab-customers");
      if (!raw)
        throw new Error(
          "当前网址下没有旧客户。请在原来的网址打开旧数据并备份后上传。",
        );
      const customers = JSON.parse(raw);
      const records = JSON.parse(localStorage.getItem("ab-records") || "[]");
      download("奥汀堡CRM-旧浏览器原始备份.json", {
        format: "legacy-browser",
        exportedAt: new Date().toISOString(),
        customers,
        records,
      });
      load(customers);
      setBacked(true);
      notify("旧客户原始备份已下载，浏览器数据保持不变");
    } catch (e) {
      m.setError((e as Error).message);
    }
  };
  return (
    <Panel title="旧数据备份与导入">
      <div className="info">
        先备份，再映射负责人并逐条核对重复客户。导入不会清空浏览器数据，也不会覆盖数据库中的客户。导入完成后请核对结果并妥善保存原始备份。
      </div>
      <div className="actions">
        <button onClick={localBackup}>备份并读取当前浏览器旧客户</button>
        <button
          disabled={!rows.length}
          onClick={() => {
            download("奥汀堡CRM-导入前客户备份.json", { customers: rows });
            setBacked(true);
          }}
        >
          下载待导入数据备份
        </button>
      </div>
      <label className="file-label">
        或上传旧客户备份 JSON
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              if (file.size > 2500000)
                throw new Error("文件超过2.5MB，请拆分后导入");
              load(JSON.parse(await file.text()));
              m.setError("");
            } catch (error) {
              m.setError((error as Error).message);
            }
          }}
        />
      </label>
      <p className="muted">
        旧版原型没有保存跟进内容。本入口迁移客户资料；完整数据库及历史恢复请使用服务器备份恢复命令。上传的原始文件请保留。
      </p>
      <ErrorBox message={m.error || team.error} />
      {rows.length > 0 && !result && (
        <>
          <p>
            读取到 {rows.length} 位客户。请确认旧数据中的负责人对应到正式账号。
          </p>
          {owners.map((owner) => (
            <div className="import-map" key={owner}>
              <span>{owner}</span>
              <select
                aria-label={`映射 ${owner}`}
                value={ownerMap[owner] || ""}
                onChange={(e) => {
                  setOwnerMap({ ...ownerMap, [owner]: e.target.value });
                  setPreview(null);
                }}
              >
                <option value="">请选择正式负责人</option>
                {team.data
                  ?.filter((u) => u.active)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} · {u.email}
                    </option>
                  ))}
              </select>
            </div>
          ))}
          <label className="check-label">
            <input
              type="checkbox"
              checked={backedUp}
              onChange={(e) => setBacked(e.target.checked)}
            />
            我已将原始数据备份到安全位置
          </label>
          <button
            className="primary"
            disabled={m.busy || !backedUp || owners.some((o) => !ownerMap[o])}
            onClick={() =>
              void m.run<Preview>(
                "/import/preview",
                "POST",
                { customers: rows, ownerMap, backedUp: true },
                (data) => {
                  setPreview(data);
                  setInclude(
                    data.rows
                      .filter((r) => !r.alreadyImported && !r.duplicates.length)
                      .map((r) => r.index),
                  );
                },
              )
            }
          >
            {m.busy ? "预检中…" : "预检重复客户"}
          </button>
        </>
      )}
      {preview && !result && (
        <>
          <h3>核对导入清单</h3>
          <p>
            重复客户默认不选中；确认确为不同客户后可手动选中。已成功导入过的客户不会再次创建。
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>导入</th>
                  <th>公司</th>
                  <th>负责人</th>
                  <th>核对结果</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.index}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`导入 ${r.data.company}`}
                        disabled={r.alreadyImported}
                        checked={include.includes(r.index)}
                        onChange={(e) =>
                          setInclude(
                            e.target.checked
                              ? [...include, r.index]
                              : include.filter((x) => x !== r.index),
                          )
                        }
                      />
                    </td>
                    <td>{r.data.company}</td>
                    <td>
                      {team.data?.find((u) => u.id === r.data.ownerId)?.name}
                    </td>
                    <td>
                      {r.alreadyImported
                        ? "已导入"
                        : r.duplicates.length
                          ? "疑似重复"
                          : "可导入"}
                      {r.duplicates.map((d) => (
                        <p key={`${d.id}:${d.company}`}>
                          {d.id ? (
                            <Link to={`/customers/${d.id}`}>{d.company}</Link>
                          ) : (
                            d.company
                          )}
                        </p>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className="primary"
            disabled={m.busy || !include.length}
            onClick={() =>
              void m.run<{
                count: number;
                customers: { id: string; company: string }[];
              }>(
                `/import/${preview.id}/commit`,
                "POST",
                { include, confirmed: true },
                (data) => {
                  setResult(data);
                  refresh();
                  notify("导入完成，请逐条核对");
                },
              )
            }
          >
            {m.busy ? "导入中…" : `确认导入 ${include.length} 位客户`}
          </button>
        </>
      )}
      {result && (
        <div className="success">
          <b>成功导入 {result.count} 位客户，旧数据未删除。</b>
          {result.customers.map((c) => (
            <p key={c.id}>
              <Link to={`/customers/${c.id}`}>{c.company} · 打开核对</Link>
            </p>
          ))}
          <button
            onClick={() => download("奥汀堡CRM-导入成功回执.json", result)}
          >
            下载导入回执
          </button>
        </div>
      )}
    </Panel>
  );
}
