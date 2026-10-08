import { useState } from "react";
import { useMutation, useResource } from "./api.ts";
import { useSession } from "./context.tsx";
import { ErrorBox, Field, Loading, Panel } from "./ui.tsx";
type Schedule = {
  time: string;
  timezone: "Asia/Shanghai";
  retentionDays: number;
};
type Run = {
  id: string;
  status: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  attempts: number;
  error: string | null;
  retention_error: string | null;
  object_key: string | null;
  sha256: string | null;
  bytes: number | null;
  app_version: string | null;
  table_counts: Record<string, number> | null;
  verified_at: string | null;
  deleted_at: string | null;
};
type Overview = {
  rule: {
    enabled: boolean;
    config: Schedule;
    version: number;
    next_run: string;
    last_heartbeat: string | null;
    last_success: string | null;
    last_error: string | null;
  };
  runs: Run[];
  storage: {
    url: string;
    bucket: string;
    keyId: string | null;
    missing: string[];
  };
  scope: string;
};
const time = (v: string | null) =>
  v
    ? new Date(v).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "尚无记录";
const labels: Record<string, string> = {
  verified: "云端回读校验通过",
  failed: "失败",
  running: "执行中",
  interrupted: "中断（自动重试）",
};
export default function Backups() {
  const { user } = useSession();
  return user.role === "admin" ? (
    <BackupAdmin />
  ) : (
    <ErrorBox message="仅管理员可查看备份恢复" />
  );
}
function BackupAdmin() {
  const { notify } = useSession(),
    [revision, setRevision] = useState(0),
    m = useMutation(),
    r = useResource<Overview>("/backups", revision, 15000);
  if (r.loading) return <Loading />;
  if (!r.data) return <ErrorBox message={r.error} />;
  const d = r.data,
    refresh = () => setRevision((v) => v + 1);
  return (
    <>
      <Panel
        title="9.6 云端备份与隔离恢复"
        action={
          <button
            disabled={m.busy || !!d.storage.missing.length}
            onClick={() =>
              void m.run<{ message: string }>(
                "/backups/run",
                "POST",
                {},
                (v) => {
                  notify(v.message);
                  refresh();
                },
              )
            }
          >
            立即备份
          </button>
        }
      >
        <p>
          服务器自动执行，不依赖本地电脑或浏览器。默认私有存储、AES-256-GCM
          加密；上传后回读、解密和 SHA256 校验通过才计为成功。
        </p>
        <ErrorBox
          message={
            m.error ||
            r.error ||
            d.rule.last_error ||
            d.storage.missing.join("；")
          }
        />
        <dl style={{ overflowWrap: "anywhere" }}>
          <dt>存储位置（私有）</dt>
          <dd>
            {d.storage.url || "待配置"}/storage · {d.storage.bucket}/production
          </dd>
          <dt>最近成功备份</dt>
          <dd>{time(d.rule.last_success)}</dd>
          <dt>下次执行（北京时间）</dt>
          <dd>{d.rule.enabled ? time(d.rule.next_run) : "定时任务已暂停"}</dd>
          <dt>服务器任务心跳</dt>
          <dd>{time(d.rule.last_heartbeat)}</dd>
          <dt>加密密钥标识（不是密钥）</dt>
          <dd>{d.storage.keyId || "待配置"}</dd>
        </dl>
        <BackupConfig key={d.rule.version} rule={d.rule} done={refresh} />
        <p className="muted">
          {d.scope}{" "}
          备份文件与解密密钥分开保存。此页不提供覆盖生产数据的恢复按钮；外部文件及服务器环境变量须另行保管。
        </p>
        <details>
          <summary>隔离恢复步骤</summary>
          <ol>
            <li>由授权运维获取对应加密文件、备份密钥和备份时的代码版本。</li>
            <li>创建隔离空数据库，运行该版本迁移；不得填写生产数据库地址。</li>
            <li>
              使用 cloud-backup-restore.ts
              校验、解密并恢复到隔离库，核对表数、业务条数及附件。
            </li>
            <li>
              审核恢复结果后另行制定生产切换方案；本页面不自动覆盖生产数据。
            </li>
          </ol>
        </details>
      </Panel>
      <Panel title="最近执行记录">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>开始 / 完成</th>
                <th>触发 / 状态</th>
                <th>尝试</th>
                <th>大小 / 版本</th>
                <th>校验与说明</th>
              </tr>
            </thead>
            <tbody>
              {d.runs.map((v) => (
                <tr key={v.id}>
                  <td>
                    {time(v.started_at)}
                    <br />
                    {time(v.finished_at)}
                  </td>
                  <td>
                    {v.trigger === "scheduled" ? "定时" : "管理员请求"}
                    <br />
                    {labels[v.status]}
                    {v.deleted_at && (
                      <>
                        <br />
                        已按保留周期清理
                      </>
                    )}
                  </td>
                  <td>{v.attempts}</td>
                  <td>
                    {v.bytes === null
                      ? "—"
                      : (v.bytes / 1024).toFixed(1) + " KB"}
                    <br />
                    {v.app_version?.slice(0, 7) || "未记录"}
                  </td>
                  <td>
                    {v.error || v.retention_error || time(v.verified_at)}
                    <details>
                      <summary>文件与表数</summary>
                      <p style={{ overflowWrap: "anywhere" }}>
                        {v.object_key || "未上传"}
                        <br />
                        SHA256：{v.sha256 || "未生成"}
                      </p>
                      {v.table_counts && (
                        <ul>
                          {Object.entries(v.table_counts).map(
                            ([name, count]) => (
                              <li key={name}>
                                {name}：{count}
                              </li>
                            ),
                          )}
                        </ul>
                      )}
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!d.runs.length && <p>尚未执行，不能视为已经备份。</p>}
      </Panel>
    </>
  );
}
function BackupConfig({
  rule,
  done,
}: {
  rule: Overview["rule"];
  done: () => void;
}) {
  const [enabled, setEnabled] = useState(rule.enabled),
    [config, setConfig] = useState(rule.config),
    m = useMutation();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.run(
          "/backups/config",
          "PUT",
          { enabled, config, version: rule.version },
          done,
        );
      }}
    >
      <div className="form-grid">
        <Field label="定时任务">
          <select
            value={enabled ? "on" : "off"}
            onChange={(e) => setEnabled(e.target.value === "on")}
          >
            <option value="on">启用</option>
            <option value="off">暂停</option>
          </select>
        </Field>
        <Field label="每日时间（北京时间）">
          <input
            type="time"
            required
            value={config.time}
            onChange={(e) => setConfig({ ...config, time: e.target.value })}
          />
        </Field>
        <Field label="保留天数（7–30天）">
          <input
            type="number"
            required
            min="7"
            max="30"
            value={config.retentionDays}
            onChange={(e) =>
              setConfig({ ...config, retentionDays: Number(e.target.value) })
            }
          />
        </Field>
      </div>
      <p>
        仅在新备份校验通过后清理已过期副本；清理失败会保留旧副本并提醒。单份加密文件上限16MB，不自动升级套餐。
      </p>
      <ErrorBox message={m.error} />
      <button disabled={m.busy}>保存计划</button>
    </form>
  );
}
