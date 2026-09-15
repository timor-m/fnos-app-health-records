import type { DatabaseSync } from 'node:sqlite';
import config from '../../../dictionary/groups/builtin.json' with { type: 'json' };
import { getDatabase } from '../database/client';
import { resolveTrendGroupKeys, type TrendGroupNode } from '../../shared/trend-groups';

type CatalogRow = { id: string; key: string; name: string; category: string; domain: string | null; itemOrder: number };
type GroupRow = { id: string; key: string; name: string; parent: string | null };
type AvailableIndicator = { indicatorKey: string; name: string; searchAliases: string[] };
const synced = new WeakMap<DatabaseSync, string>();

// Resolve category keys, never names or OCR text. Re-read the active catalog so remote
// dictionary installation/rollback is reflected without touching observations.
export function syncBuiltinTrendGroups(db: DatabaseSync) {
  const catalog = db.prepare(`SELECT c.id, c.canonical_key AS key, c.display_name AS name,
    c.category_key AS category, t.group_key AS domain, COALESCE(c.item_order, 9999) AS itemOrder
    FROM indicator_catalog c LEFT JOIN indicator_taxonomy_categories t ON t.category_key = c.category_key
    WHERE c.trend_enabled = 1 ORDER BY c.item_order, c.display_name, c.canonical_key`).all() as CatalogRow[];
  const domains = db.prepare(`SELECT group_key AS key, name, item_order AS sortOrder
    FROM indicator_taxonomy_groups ORDER BY item_order, group_key`).all() as { key: string; name: string; sortOrder: number }[];
  const signature = JSON.stringify([catalog, domains]);
  if (synced.get(db) === signature) return;
  const definitions = [
    ...domains.map(d => ({ key: d.key, name: d.name, parent: null as string | null, order: d.sortOrder,
      members: catalog.filter(c => c.domain === d.key) })),
    ...config.groups.filter(g => domains.some(d => d.key === g.parent)).map((g, index) => ({
      key: g.key, name: g.name, parent: g.parent, order: index,
      members: catalog.filter(c => ('keys' in g && g.keys?.includes(c.key)) || ('categories' in g && g.categories?.includes(c.category)))
        .sort((a, b) => (g.keys ? g.keys.indexOf(a.key) - g.keys.indexOf(b.key) : 0) || a.itemOrder - b.itemOrder || a.name.localeCompare(b.name, 'zh-CN'))
    }))
  ];
  db.exec('SAVEPOINT sync_trend_groups');
  try {
    // Relationships explicitly owned by users survive built-in refreshes.
    db.exec("DELETE FROM indicator_group_members WHERE source = 'builtin' AND group_id IN (SELECT id FROM indicator_groups WHERE source = 'builtin' AND created_by IS NULL)");
    db.exec("UPDATE indicator_groups SET enabled = 0 WHERE source = 'builtin' AND created_by IS NULL");
    const upsert = db.prepare(`INSERT INTO indicator_groups(id, group_key, parent_id, display_name, sort_order)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(group_key) DO UPDATE SET parent_id = excluded.parent_id,
      display_name = excluded.display_name, sort_order = excluded.sort_order, enabled = 1, updated_at = CURRENT_TIMESTAMP
      WHERE indicator_groups.source = 'builtin' AND indicator_groups.created_by IS NULL`);
    const member = db.prepare(`INSERT INTO indicator_group_members(group_id, indicator_id, sort_order)
      SELECT id, ?, ? FROM indicator_groups WHERE group_key = ? AND source = 'builtin' AND created_by IS NULL
      ON CONFLICT(group_id, indicator_id) DO NOTHING`);
    for (const group of definitions) {
      const parentId = group.parent ? (db.prepare('SELECT id FROM indicator_groups WHERE group_key = ?').get(group.parent) as {id: string} | undefined)?.id : null;
      upsert.run(`builtin:${group.key}`, group.key, parentId || null, group.name, group.order);
      group.members.forEach((item, index) => member.run(item.id, index, group.key));
    }
    db.exec('RELEASE sync_trend_groups');
    synced.set(db, signature);
  } catch (error) {
    db.exec('ROLLBACK TO sync_trend_groups; RELEASE sync_trend_groups');
    throw error;
  }
}

// Call only after listTrendSeries has enforced member access; available contains
// admitted indicators only, not raw observations or another member's counts.
export function buildTrendGroupTree(available: AvailableIndicator[], userId: string, db = getDatabase()): TrendGroupNode[] {
  syncBuiltinTrendGroups(db);
  const groups = db.prepare(`SELECT id, group_key AS key, display_name AS name, parent_id AS parent
    FROM indicator_groups WHERE enabled = 1 AND (created_by IS NULL AND source = 'builtin' OR created_by = ?)
    ORDER BY sort_order, display_name, group_key`).all(userId) as GroupRow[];
  const memberships = db.prepare(`SELECT m.group_id AS groupId, c.canonical_key AS key
    FROM indicator_group_members m JOIN indicator_catalog c ON c.id = m.indicator_id
    WHERE c.trend_enabled = 1 ORDER BY m.sort_order, c.item_order, c.display_name, c.canonical_key`).all() as {groupId: string; key: string}[];
  const byGroup = new Map<string, string[]>();
  for (const m of memberships) byGroup.set(m.groupId, [...(byGroup.get(m.groupId) || []), m.key]);
  const availableByKey = new Map(available.map(item => [item.indicatorKey, item]));
  const build = (g: GroupRow, parents = new Set<string>()): TrendGroupNode => {
    const path = new Set([...parents, g.id]);
    const children = groups.filter(child => child.parent === g.id && !path.has(child.id)).map(child => build(child, path));
    const configured = new Set([...(byGroup.get(g.id) || []), ...children.flatMap(child => configuredByKey.get(child.key) || [])]);
    configuredByKey.set(g.key, [...configured]);
    if (children.length) {
      const covered = new Set(children.flatMap(child => configuredByKey.get(child.key) || []));
      const remainder = [...configured].filter(key => !covered.has(key));
      const remainingAvailable = remainder.filter(key => availableByKey.has(key));
      if (remainder.length) children.push({ key: `${g.key}:other`, name: '其他指标', children: [],
        indicatorKeys: remainingAvailable, indicatorCount: remainingAvailable.length, configuredIndicatorCount: remainder.length,
        searchText: [g.name, '其他指标', ...remainingAvailable.flatMap(key => { const item = availableByKey.get(key)!; return [item.name, ...item.searchAliases]; })].join(' ').toLocaleLowerCase() });
    }
    const indicatorKeys = [...configured].filter(key => availableByKey.has(key));
    return { key: g.key, name: g.name, children, indicatorKeys, indicatorCount: indicatorKeys.length,
      configuredIndicatorCount: configured.size,
      searchText: [g.name, ...indicatorKeys.flatMap(key => { const item = availableByKey.get(key)!; return [item.name, ...item.searchAliases]; })].join(' ').toLocaleLowerCase()
    };
  };
  const configuredByKey = new Map<string, string[]>();
  const tree = groups.filter(g => !g.parent).map(g => build(g));
  const grouped = new Set(tree.flatMap(g => g.indicatorKeys));
  const ungrouped = [...availableByKey.keys()].filter(key => !grouped.has(key));
  if (ungrouped.length) tree.push({ key: 'ungrouped', name: '未分组指标', indicatorKeys: ungrouped,
    indicatorCount: ungrouped.length, configuredIndicatorCount: ungrouped.length, children: [],
    searchText: ['未分组指标', ...ungrouped.flatMap(key => { const item = availableByKey.get(key)!; return [item.name, ...item.searchAliases]; })].join(' ').toLocaleLowerCase() });
  return tree;
}

export function filterTrendGroups<T extends AvailableIndicator>(series: T[], tree: TrendGroupNode[], groupKeys: string[] = [], indicatorKeys: string[] = []) {
  const grouped = groupKeys.length ? resolveTrendGroupKeys(tree, groupKeys) : null;
  const individual = indicatorKeys.length ? new Set(indicatorKeys) : null;
  // Groups are a union; an explicit indicator selection refines that union.
  const rank = grouped ? new Map([...grouped].map((key, index) => [key, index])) : null;
  return series.filter(item => (!grouped || grouped.has(item.indicatorKey)) && (!individual || individual.has(item.indicatorKey)))
    .sort((a, b) => rank ? (rank.get(a.indicatorKey) ?? 9999) - (rank.get(b.indicatorKey) ?? 9999) : 0);
}
