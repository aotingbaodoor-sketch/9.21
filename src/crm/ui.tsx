import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useSession } from "./context.tsx";
import type { Customer, Grade } from "../../shared/contracts.ts";
export function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
export function ErrorBox({ message }: { message: string }) {
  return message ? (
    <div className="error" role="alert">
      {message}
    </div>
  ) : null;
}
export function Loading() {
  return (
    <p className="loading" role="status">
      正在读取数据…
    </p>
  );
}
export function Empty({ text = "暂无数据" }: { text?: string }) {
  return <div className="empty">{text}</div>;
}
export function GradeBadge({ grade }: { grade: Grade }) {
  return <span className={`grade ${grade}`}>{grade}</span>;
}
export function Status({ customer }: { customer: Customer }) {
  return (
    <span className={`status ${customer.status === "已逾期" ? "overdue" : ""}`}>
      ● {customer.status}
      {customer.overdueDays > 0 ? ` ${customer.overdueDays}天` : ""}
    </span>
  );
}
export function Pagination({
  page,
  pages,
  total,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="pagination">
      <span className="muted">
        共 {total} 条 · {page}/{pages} 页
      </span>
      <div className="actions">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
          上一页
        </button>
        <button disabled={page >= pages} onClick={() => onPage(page + 1)}>
          下一页
        </button>
      </div>
    </div>
  );
}
export function Modal({
  title,
  children,
  close,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
      if (e.key === "Tab" && el) {
        const focusable = Array.from(
          el.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,textarea,select,a[href],[tabindex="0"]',
          ),
        );
        const first = focusable[0],
          last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [busy, close]);
  return (
    <div className="modal-shade">
      <div
        className="modal"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-title">
          <h2>{title}</h2>
          <button disabled={busy} onClick={close} aria-label="关闭">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function CustomerTable({
  items,
  compact = false,
  onFollow,
  onEdit,
  onDelete,
  onRestore,
}: {
  items: Customer[];
  compact?: boolean;
  onFollow?: (c: Customer) => void;
  onEdit?: (c: Customer) => void;
  onDelete?: (c: Customer) => void;
  onRestore?: (c: Customer) => void;
}) {
  const { settings } = useSession();
  if (!items.length)
    return <Empty text="暂无客户。添加客户后即可开始持续跟进。" />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>客户名称 / 联系人</th>
            {!compact && <th>国家 / 来源</th>}
            <th>等级 / 阶段</th>
            <th>产品 / 负责人</th>
            <th>最后 / 下次跟进</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td className="company">
                {c.deletedAt ? (
                  <b>{c.company || c.contact || "WhatsApp 新客户"}</b>
                ) : (
                  <Link to={`/customers/${c.id}`}>
                    <b>{c.company || c.contact || "WhatsApp 新客户"}</b>
                  </Link>
                )}
                <small>{c.contact || "未填写联系人"}</small>
                {!!c.whatsappUnread && (
                  <Link
                    className="wa-unread"
                    to={`/customers/${c.id}?tab=whatsapp`}
                  >
                    {c.whatsappUnread} 条未读
                  </Link>
                )}
                {c.whatsappLastMessage && (
                  <small className="wa-preview">{c.whatsappLastMessage}</small>
                )}
                {c.whatsappNeedsAssignment && <small>等待管理员分配</small>}
                {c.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </td>
              {!compact && (
                <td>
                  {c.country || "—"}
                  <small>{c.source || "—"}</small>
                </td>
              )}
              <td>
                <GradeBadge grade={c.grade} />
                <small>{c.stage}</small>
              </td>
              <td>
                {c.product || "—"}
                <small>{c.owner}</small>
              </td>
              <td className="nowrap">
                <small>
                  {c.last
                    ? new Date(c.last).toLocaleString("zh-CN", {
                        timeZone: settings.timezone,
                      })
                    : "尚未跟进"}
                </small>
                {c.next}
              </td>
              <td>
                <Status customer={c} />
              </td>
              <td>
                <div className="actions">
                  {onRestore ? (
                    <button onClick={() => onRestore(c)}>恢复</button>
                  ) : (
                    <>
                      <button className="primary" onClick={() => onFollow?.(c)}>
                        跟进
                      </button>
                      {onEdit && (
                        <button onClick={() => onEdit(c)}>编辑</button>
                      )}
                      {onDelete && (
                        <button className="danger" onClick={() => onDelete(c)}>
                          删除
                        </button>
                      )}
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
