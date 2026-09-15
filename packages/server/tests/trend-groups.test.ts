import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import config from '../../../dictionary/groups/builtin.json' with { type: 'json' };
import core from '../../../dictionary/core/indicators.json' with { type: 'json' };
import remote from '../../../dictionary/remote/indicators.json' with { type: 'json' };
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { ensureBuiltinIndicatorCatalog, normalizeReportObservations } from '../services/indicator-normalization.service';
import { buildTrendGroupTree, filterTrendGroups, syncBuiltinTrendGroups } from '../services/trend-groups.service';
import { flattenTrendGroups, resolveTrendGroupKeys } from '../../shared/trend-groups';
import { listTrendSeries } from '../services/records.service';
import { trendFilterKeys } from '../utils/trend-filter-query';
import type { RequestUser } from '../domain/request-user';

const user: RequestUser = { id: 'group-owner', displayName: 'fixture', authenticated: true, provider: 'fnos_gateway', isGatewayAdmin: false };
function fixture(run: (db: DatabaseSync, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'trend-groups-'));
  const old = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = root;
  try {
    const db = getDatabase();
    ensureBuiltinIndicatorCatalog();
    db.exec(`INSERT INTO users(id, display_name) VALUES ('group-owner', 'fixture'), ('other-user', 'fixture');
      INSERT INTO health_members(id, display_name, created_by) VALUES ('member', 'fixture', 'group-owner'), ('empty-member', 'fixture', 'group-owner');
      INSERT INTO member_permissions(member_id, user_id, permission, granted_by) VALUES ('member', 'group-owner', 'manager', 'group-owner'), ('empty-member', 'group-owner', 'manager', 'group-owner');`);
    run(db, root);
  } finally {
    closeDatabaseForTests();
    if (old === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
}
const available = ['thyroid_tsh','thyroid_ft3','thyroid_ft4','thyroid_t3_total','thyroid_t4_total'].map(indicatorKey => ({ indicatorKey, name: indicatorKey, searchAliases: [indicatorKey.replace('thyroid_', '')] }));

test('group config references existing canonical identities, with no invented catalog', () => {
  const indicators = [...core.indicators, ...remote.indicators];
  for (const g of config.groups) {
    for (const key of g.keys || []) assert.ok(indicators.some(i => i.canonicalKey === key), key);
    for (const category of g.categories || []) assert.ok(indicators.some(i => i.categoryKey === category), category);
  }
  assert.equal(new Set(config.groups.map(g => g.key)).size, config.groups.length);
});

test('thyroid overlap resolves five unique identities while keeping unit series and point data intact', () => fixture(db => {
  const tree = buildTrendGroupTree(available, user.id, db);
  const flat = flattenTrendGroups(tree);
  assert.equal(flat.find(g => g.key === 'thyroid_3')?.indicatorCount, 3);
  assert.equal(flat.find(g => g.key === 'thyroid_5')?.indicatorCount, 5);
  assert.equal(flat.find(g => g.key === 'lipid_panel')?.configuredIndicatorCount, 4);
  assert.equal(resolveTrendGroupKeys(tree, ['thyroid_3','thyroid_5']).size, 5);
  assert.equal(resolveTrendGroupKeys(tree, ['laboratory']).size, 5);
  const series = [...available, { ...available[0], unit: 'different' }];
  const filtered = filterTrendGroups(series, tree, ['thyroid_3','thyroid_5']);
  assert.equal(filtered.length, series.length);
  assert.ok(series.every(item => filtered.includes(item)));
  assert.deepEqual([...new Set(filtered.map(item => item.indicatorKey))], available.map(item => item.indicatorKey));
  assert.equal(filterTrendGroups(series, tree, ['thyroid_5'], ['thyroid_ft3']).length, 1);
  assert.equal(filterTrendGroups(series, tree, ['unknown']).length, 0);
  assert.deepEqual(filterTrendGroups(series, tree), series);
}));

test('counts use available identities; missing histories are not fabricated and nonstandard indicators survive', () => fixture(db => {
  const series = [...available.slice(0, 2), { indicatorKey: 'institution:fixture', name: 'fixture', searchAliases: [] }];
  const tree = buildTrendGroupTree(series, user.id, db);
  const thyroid = flattenTrendGroups(tree).find(g => g.key === 'thyroid_5')!;
  assert.equal(thyroid.indicatorCount, 2);
  assert.equal(thyroid.configuredIndicatorCount, 5);
  assert.match(thyroid.searchText, /tsh/);
  assert.equal(filterTrendGroups(series, tree, ['ungrouped'])[0].indicatorKey, 'institution:fixture');
  const empty = buildTrendGroupTree([], user.id, db);
  assert.ok(flattenTrendGroups(empty).every(g => g.indicatorCount === 0));
}));

test('dictionary refresh updates built-in memberships, preserving user-owned groups and relationships', () => fixture(db => {
  syncBuiltinTrendGroups(db);
  const indicator = db.prepare("SELECT id FROM indicator_catalog WHERE canonical_key = 'thyroid_tsh'").get() as {id: string};
  db.prepare("INSERT INTO indicator_groups(id,group_key,display_name,source,created_by) VALUES ('custom','custom','fixture','user',?)").run(user.id);
  db.prepare("INSERT INTO indicator_group_members(group_id,indicator_id,source) VALUES ('custom',?,'user')").run(indicator.id);
  db.prepare("INSERT INTO indicator_group_members(group_id,indicator_id,source) VALUES ('builtin:cbc',?,'user')").run(indicator.id);
  db.exec("UPDATE indicator_catalog SET display_name = display_name || ' ' WHERE canonical_key = 'thyroid_tsh'");
  syncBuiltinTrendGroups(db);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM indicator_group_members WHERE source = 'user'").get() as {n:number}).n, 2);
  assert.ok(flattenTrendGroups(buildTrendGroupTree(available, user.id, db)).some(g => g.key === 'custom'));
  assert.ok(!flattenTrendGroups(buildTrendGroupTree(available, 'other-user', db)).some(g => g.key === 'custom'));
  db.exec("UPDATE indicator_catalog SET trend_enabled = 0 WHERE canonical_key = 'thyroid_ft3'");
  syncBuiltinTrendGroups(db);
  assert.equal(flattenTrendGroups(buildTrendGroupTree(available, user.id, db)).find(g => g.key === 'thyroid_3')!.configuredIndicatorCount, 2);
  assert.throws(() => db.prepare("INSERT INTO indicator_group_members(group_id,indicator_id) VALUES ('custom',?)").run(indicator.id), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO indicator_group_members(group_id,indicator_id) VALUES ('custom','missing')"), /FOREIGN KEY/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}));

test('real admitted histories and member permissions remain unchanged by group operations', () => fixture(db => {
  db.exec(`INSERT INTO reports(id,member_id,created_by,report_type,title,status,report_issued_at) VALUES ('report','member','group-owner','laboratory','fixture','ready','2026-01-01');
    INSERT INTO observations(id,report_id,item_name,normalized_name,result_text,numeric_value,unit) VALUES ('o','report','促甲状腺激素','促甲状腺激素','2','2','mIU/L');`);
  normalizeReportObservations('report');
  const original = listTrendSeries(user, 'member');
  assert.equal(original.length, 1);
  const before = db.prepare('SELECT * FROM observation_normalizations').all();
  const tree = buildTrendGroupTree(original, user.id, db);
  assert.deepEqual(filterTrendGroups(original, tree, ['thyroid_5']), original);
  assert.deepEqual(listTrendSeries(user, 'member'), original);
  assert.deepEqual(db.prepare('SELECT * FROM observation_normalizations').all(), before);
  assert.throws(() => listTrendSeries({ ...user, id: 'other-user', isGatewayAdmin: true }, 'member'), (e: any) => e.statusCode === 403);
  assert.deepEqual(listTrendSeries(user, 'empty-member'), []);
}));

test('older v17 database gets an additive draft and backup without schema renumbering', () => fixture((db, root) => {
  const version = db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get();
  db.exec('DROP TABLE indicator_group_members; DROP TABLE indicator_groups');
  closeDatabaseForTests();
  const reopened = getDatabase();
  assert.ok(reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'indicator_groups'").get());
  assert.deepEqual(reopened.prepare('SELECT MAX(version) AS n FROM schema_migrations').get(), version);
  assert.ok(readdirSync(join(root, 'backups', 'db')).some(file => file.endsWith('.sqlite')));
}));

test('query parser accepts repeated array keys, deduplicates and rejects malformed/oversized input', () => {
  assert.deepEqual(trendFilterKeys({'groupKeys[]':['thyroid_3','thyroid_3','thyroid_5']}, 'groupKeys'), ['thyroid_3','thyroid_5']);
  assert.deepEqual(trendFilterKeys({indicatorKeys:'thyroid_tsh'}, 'indicatorKeys'), ['thyroid_tsh']);
  assert.throws(() => trendFilterKeys({groupKeys: {}}, 'groupKeys'));
  assert.throws(() => trendFilterKeys({groupKeys: Array(201).fill('x')}, 'groupKeys'));
});
