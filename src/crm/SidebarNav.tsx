import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { User } from '../../shared/contracts.ts';
import { activeMenu, ancestorIds, menuLinks, visibleMenu, type MenuNode } from './navigation.ts';
import './navigation.css';

const storageKey = (role: string) => `autinberg.menu.v21.${role}`;
function readExpanded(role: string): Record<string, boolean> {
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(storageKey(role)) || '{}');
    return data && typeof data === 'object' && !Array.isArray(data)
      ? Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'boolean')) : {};
  } catch { return {}; }
}

// Keyed by location in Root: restore preferences and open the current page's ancestors.
// Desktop and mobile intentionally render the same tree and links.
export function SidebarNav({ role, pathname, search, onNavigate }: {
  role: User['role']; pathname: string; search: string; onNavigate: () => void;
}) {
  const nodes = visibleMenu(role), active = activeMenu(nodes, pathname, search);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({
    ...readExpanded(role), ...Object.fromEntries(ancestorIds(nodes, active?.id).map(id => [id, true])),
  }));
  function update(next: Record<string, boolean>) {
    setExpanded(next);
    try { sessionStorage.setItem(storageKey(role), JSON.stringify(next)); } catch { /* Browser storage is optional. */ }
  }
  function toggleAll(open: boolean) {
    const ids = (items: readonly MenuNode[]): string[] => items.flatMap(n => n.children ? [n.id, ...ids(n.children)] : []);
    update(Object.fromEntries(ids(nodes).map(id => [id, open])));
  }
  function render(items: readonly MenuNode[], level = 0) {
    return items.map(node => {
      if (node.href) return <Link key={node.id} to={node.href} data-menu-id={node.id}
        className={`menu-link${active?.id === node.id ? ' active' : ''}`} aria-current={active?.id === node.id ? 'page' : undefined}
        onClick={onNavigate} title={node.reference ? '引用销售部同一份报价规则，不建立第二份配置' : undefined}>
        {node.label}
      </Link>;
      const enabled = menuLinks(node.children || []).length > 0, open = Boolean(expanded[node.id]);
      return <section key={node.id} className={`menu-group menu-level-${level}`} data-menu-group={node.id} data-business-owner={node.businessOwner}>
        <button type="button" className="menu-toggle" disabled={!enabled}
          aria-expanded={enabled ? open : undefined} aria-controls={enabled ? `menu-${node.id}` : undefined}
          onClick={() => update({ ...expanded, [node.id]: !open })}>
          <span>{node.label}</span><span className="menu-indicator" aria-hidden="true">{enabled ? (open ? '▾' : '▸') : '—'}</span>
          {!enabled && <small>{role === 'admin' ? '待启用' : '暂无可用入口'}</small>}
        </button>
        {enabled && <div id={`menu-${node.id}`} className="menu-children" hidden={!open}>
          {node.businessOwner && <small className="menu-owner">业务归属：{node.businessOwner} 客资转化</small>}
          {render(node.children || [], level + 1)}
        </div>}
      </section>;
    });
  }
  return <>
    <div className="menu-controls"><button type="button" onClick={() => toggleAll(true)}>全部展开</button><button type="button" onClick={() => toggleAll(false)}>全部收起</button></div>
    <nav aria-label="主导航">{render(nodes)}</nav>
  </>;
}
