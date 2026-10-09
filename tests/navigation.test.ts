import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { MENU, visibleMenu, menuLinks, activeMenu, ancestorIds, type MenuNode } from '../src/crm/navigation.ts';
import type { User } from '../shared/contracts.ts';

test('V2.1 roots preserved, 22 original positions plus five later valid entries, one pricing reference', () => {
  const nodes = visibleMenu('admin');
  assert.deepEqual(nodes.map(n => n.id), ['dashboard','governance','ms','tec','scm','adm','it','workflow','communication','master-data','settings-group']);
  const links = menuLinks(nodes);
  assert.equal(links.filter(n => !n.reference).length, 27);
  assert.equal(links.filter(n => n.reference).length, 1);
  assert.equal(new Set(links.map(n => n.id)).size, links.length);
  assert.equal(nodes.find(n => n.id === 'tec')!.children!.length, 2);
  assert.equal(menuLinks(nodes.find(n => n.id === 'it')!.children!).length, 0);
});

test('all six existing role route sets preserved; only universal workbench redirect added', () => {
  const before = execFileSync('git',['show','83173b8:src/crm/CRM.tsx'],{encoding:'utf8'});
  const expression = before.match(/menus = ([\s\S]*?),\r?\n    title =/)![1];
  const legacy = new Function('user','specialist',`return ${expression};`) as (user: {role: string}, specialist: boolean) => string[][];
  for (const role of ['admin','sales','technical','logistics','factory','coordinator'] as User['role'][]) {
    const old = new Set(legacy({role}, ['technical','logistics','factory','coordinator'].includes(role)).map(([href]) => href));
    old.add('/dashboard'); // Existing route still redirects specialists to their original authorized page.
    const links=menuLinks(visibleMenu(role));
    assert.deepEqual([...new Set(links.filter(n=>!['order-chain','numbering','document-classes','backups','tariffs'].includes(n.id)).map(n => n.href!.split('?')[0]))].sort(), [...old].sort(), role);
    assert.equal(links.some(n=>n.id==='tariffs'),['admin','sales','logistics'].includes(role));
    assert.equal(links.some(n=>n.id==='backups'),role==='admin');
    assert.equal(links.some(n=>n.id==='order-chain'),role!=='factory');
    assert.equal(links.some(n=>n.id==='numbering'),role==='admin');
    assert.equal(links.some(n=>n.id==='document-classes'),role==='admin');
  }
});

test('hidden departments retained; no invented route or duplicate data source', () => {
  const flatten = (nodes: readonly MenuNode[]): MenuNode[] => nodes.flatMap(n => [n, ...flatten(n.children || [])]);
  assert.deepEqual(flatten(MENU).filter(n => n.hidden).map(n => n.id).sort(), ['mar','trf','aft','cus','tra','inf','app','con'].sort());
  const links = menuLinks(visibleMenu('admin'));
  assert.equal(links.find(n => n.id === 'quote-settings')!.href, '/quotations/settings');
  assert.equal(links.find(n => n.id === 'price-policy')!.href!.split('?')[0], '/quotations/settings');
  assert.equal(links.find(n => n.id === 'inbox')!.businessOwner, links.find(n => n.id === 'whatsapp-integration')!.businessOwner);
  assert.equal(ancestorIds(MENU,'approvals')[0],'workflow');
  assert.equal(ancestorIds(MENU,'notifications')[0],'workflow');
  assert.equal(ancestorIds(MENU,'technical-tasks')[0],'tec');
});

test('exact active item for nested old URLs and shared-page aliases', () => {
  const nodes = visibleMenu('admin');
  for (const link of menuLinks(nodes)) {
    const [path, search=''] = link.href!.split('?');
    assert.equal(activeMenu(nodes,path,search)?.id, link.id);
  }
  assert.equal(activeMenu(nodes,'/customers/customer-id','')?.id,'customers');
  assert.equal(activeMenu(nodes,'/quotations/quote-id','?v=version')?.id,'quotations');
  assert.equal(activeMenu(nodes,'/quotations/tasks','?entry=unknown')?.id,'approvals');
  assert.equal(activeMenu(nodes,'/whatsapp/account','')?.id,'channel-account');
  assert.equal(activeMenu(nodes,'/supply/factories','')?.id,'factories');
  assert.equal(activeMenu(nodes,'/customers-not-real',''),undefined);
});
