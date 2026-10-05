import type { User } from '../../shared/contracts.ts';

type Role = User['role'];
export type MenuNode = {
  id: string;
  label: string;
  href?: string;
  roles?: readonly Role[];
  hidden?: boolean;
  reference?: boolean;
  businessOwner?: string;
  children?: readonly MenuNode[];
};
const all: readonly Role[] = ['admin', 'sales', 'technical', 'logistics', 'factory', 'coordinator'];
const office: readonly Role[] = ['admin', 'sales'];
const tasks: readonly Role[] = ['admin', 'technical', 'logistics'];
const link = (id: string, label: string, href: string, roles: readonly Role[], extra: Partial<MenuNode> = {}): MenuNode => ({ id, label, href, roles, ...extra });
const pending = (id: string, label: string, children?: readonly MenuNode[]): MenuNode => ({ id, label, hidden: true, children });

// AUT-IT-MENU-FIX V2.1: display configuration only, never an API authorization policy.
// TEC stays visible following the user's explicit resolution of sections 3/5/7.
// Original route access and server authorization are unchanged.
export const MENU: readonly MenuNode[] = [
  link('dashboard', '工作台', '/dashboard', all),
  { id: 'governance', label: '0 经营驾驶舱', children: [link('analytics', '数据统计', '/analytics', ['admin'])] },
  { id: 'ms', label: '1 市场销售中心 MS', children: [
    pending('mar', '1.1 营销部 MAR'),
    { id: 'cat', label: '1.2 商品部 CAT', children: [link('products', '产品与价格', '/quotations/products', ['admin'])] },
    { id: 'sal', label: '1.3 销售部 SAL', children: [
      link('customers', '客户主数据', '/customers', office),
      link('followups', '跟进（今日视图）', '/follow-ups', office),
      link('records', '跟进（历史记录）', '/records', office),
      link('quotations', '报价单', '/quotations', office),
      { id: 'quote-tools', label: '报价工具', children: [
        link('daily-prices', '每日价格与运费', '/daily-prices', ['admin', 'sales', 'logistics']),
        link('quote-settings', '报价规则与汇率', '/quotations/settings', ['admin']),
      ] },
      link('sales-analytics', '数据统计（业务员视角）', '/analytics', ['sales']),
    ] },
    { id: 'conversion', label: '1.4 客资转化', children: [link('whatsapp-integration', '1.4.1 WhatsApp 集成', '/whatsapp/integration', ['admin'], { businessOwner: '1.4.1' })] },
    pending('trf', '1.5 流量部 TRF'),
    pending('aft', '1.6 售后服务部 AFT'),
    pending('cus', '1.7 客户成功部 CUS', [pending('tra', '1.7.1 培训组 TRA')]),
  ] },
  { id: 'tec', label: '2 产品技术部 TEC', children: [
    link('technical-tasks', '技术任务', '/quotations/tasks?entry=technical-tasks', tasks),
    link('product-review', '产品技术审核', '/factory/products', ['admin']),
  ] },
  { id: 'scm', label: '3 供应链管理部 SCM', children: [
    link('freight', '物流与货代', '/quotations/freight', ['admin', 'logistics']),
    link('supply', '订单与履约', '/supply', ['admin', 'sales', 'technical', 'logistics']),
    link('order-chain', '订单履约链（WO / PO / MO）', '/supply/chain', ['admin','sales','technical','logistics','coordinator']),
    link('factories', '供应商与工厂合作', '/supply/factories', ['admin']),
    // Extra existing specialist entries absent from the document's admin list.
    link('factory-products', '供货产品', '/factory/products', ['factory']),
    link('factory-orders', '工厂订单', '/factory/orders', ['factory']),
    link('assigned', '我的跟单任务', '/supply/assigned', ['coordinator', 'technical', 'logistics']),
  ] },
  { id: 'adm', label: '4 综合管理部 ADM', children: [
    { id: 'fin', label: '4.1 财务组 FIN', children: [] },
    { id: 'hum', label: '4.2 人力行政组 HUM', children: [link('team', '员工管理', '/team', ['admin'])] },
    { id: 'legal', label: '4.3 制度与法务', children: [] },
  ] },
  { id: 'it', label: '5 信息技术部 IT', children: [pending('inf', '5.1 硬件与基础设施组 INF'), pending('app', '5.2 应用与自动化组 APP')] },
  { id: 'workflow', label: '6 流程与审批域', children: [
    link('approvals', '报价审批', '/quotations/tasks', tasks),
    link('notifications', '提醒与超时', '/notifications', office),
  ] },
  { id: 'communication', label: '7 客户沟通台', businessOwner: '1.4', children: [
    link('inbox', '会话收件箱', '/whatsapp', office, { businessOwner: '1.4.1' }),
  ] },
  { id: 'master-data', label: '8 主数据与编码', children: [link('numbering', '8.7 统一发号台账', '/master-data/numbering', ['admin']),link('import', '8.8 旧数据导入', '/import', ['admin'])] },
  { id: 'settings-group', label: '9 系统设置', children: [
    link('document-classes', '9.1 单据类码', '/settings/document-classes', ['admin']),
    link('settings', '系统设置', '/settings', office),
    link('channel-account', '我的账号与渠道绑定', '/whatsapp/account', office),
    link('price-policy', '价格政策（引用）', '/quotations/settings?entry=price-policy', ['admin'], { reference: true }),
  ] },
  pending('con', '预留转化部 CON'),
];

export function visibleMenu(role: Role, nodes = MENU): MenuNode[] {
  return nodes.filter(n => !n.hidden && (!n.roles || n.roles.includes(role)))
    .map(n => n.children ? { ...n, children: visibleMenu(role, n.children) } : n);
}
export function menuLinks(nodes: readonly MenuNode[]): MenuNode[] {
  return nodes.flatMap(n => n.href ? [n] : menuLinks(n.children || []));
}
export function activeMenu(nodes: readonly MenuNode[], pathname: string, search: string): MenuNode | undefined {
  const entry = new URLSearchParams(search).get('entry');
  const candidates = menuLinks(nodes).filter(n => {
    const [path, query = ''] = n.href!.split('?');
    return (pathname === path || pathname.startsWith(path + '/')) &&
      (!query || new URLSearchParams(query).get('entry') === entry);
  });
  // Most specific path wins; a matching reference/view wins over its primary entry.
  return candidates.sort((a, b) => b.href!.length - a.href!.length)[0];
}
export function ancestorIds(nodes: readonly MenuNode[], activeId?: string): string[] {
  for (const node of nodes) {
    if (node.id === activeId) return [node.id];
    const descendants = ancestorIds(node.children || [], activeId);
    if (descendants.length) return [node.id, ...descendants];
  }
  return [];
}
