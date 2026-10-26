import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { getDatabase, getDatabasePath, prepareRestoredDatabase, closeDatabaseForTests, runInTransaction } from '../database/client';
import { ensureTrendSnapshotDraft, needsTrendSnapshotDraft } from '../database/trend-snapshot-draft';
import { normalizeReportObservations } from '../services/indicator-normalization.service';
import { listTrendSeries, updateTrendPin } from '../services/records.service';
import { claimTrendSnapshotJob, computeTrendSnapshotInWorker, publishTrendSnapshot, failTrendSnapshot, runTrendSnapshotTasksOnce } from '../services/trend-snapshot-runner.service';
import { H3 } from 'h3';
import overviewHandler from '../routes/api/trends/snapshot.get';
import chartHandler from '../routes/api/trends/snapshot/charts.post';
import { queryTrendSnapshotSeries, readTrendSnapshotParts, readLegacyTrendSnapshot } from '../services/trend-snapshot-query.service';
import { syncBuiltinTrendGroups } from '../services/trend-groups.service';
import { trendSeriesKey } from '../services/trend-snapshot-types';

async function fixture(action: (db: ReturnType<typeof getDatabase>) => Promise<void> | void) {
  const previous = process.env.STORAGE_DIR;
  const directory = mkdtempSync(join(tmpdir(), 'trend-snapshot-test-'));
  process.env.STORAGE_DIR = directory;
  try {
    const db = getDatabase();
    db.exec(`INSERT INTO users(id,display_name) VALUES('owner','Synthetic');
      INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic','owner');
      INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','owner','manager','owner');
      INSERT INTO reports(id,member_id,created_by,report_type,title,status,report_issued_at)
        VALUES('report','member','owner','laboratory','Synthetic','ready','2026-01-01');
      INSERT INTO observations(id,report_id,section_name,item_name,normalized_name,result_text,numeric_value,unit,reference_text)
        VALUES('wbc','report','血常规','白细胞计数','白细胞计数','5',5,'10^9/L','3.5-9.5'),
          ('hb','report','血常规','血红蛋白','血红蛋白','130',130,'g/L','110-150');`);
    normalizeReportObservations('report');
    syncBuiltinTrendGroups(db);
    await action(db);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous;
    rmSync(directory, {recursive: true, force: true});
  }
}

const owner = {id: 'owner', displayName: 'Synthetic', provider: 'development' as const, authenticated: true, isGatewayAdmin: false};
const state = (db: ReturnType<typeof getDatabase>) => db.prepare('SELECT * FROM trend_snapshot_members WHERE member_id=?').get('member')!;

test('snapshot structures are idempotent and invalidation rolls back with the business transaction', () => fixture(db => {
  assert.equal(needsTrendSnapshotDraft(db), false);
  const before = {...state(db)};
  ensureTrendSnapshotDraft(db);
  assert.deepEqual({...state(db)}, before);
  assert.throws(() => runInTransaction(db, () => {
    db.exec("UPDATE observations SET numeric_value=6,result_text='6' WHERE id='wbc'");
    assert.ok(Number(state(db).desired_revision) > Number(before.desired_revision));
    throw new Error('rollback');
  }), /rollback/);
  assert.deepEqual({...state(db)}, before);
}));

test('a read-only worker publishes the same complete results without a user or source writes', () => fixture(async db => {
  const expected = listTrendSeries(owner, 'member');
  assert.equal(expected.length, 2);
  const job = claimTrendSnapshotJob(db)!;
  assert.ok(job.full);
  const sourceBefore = db.prepare('SELECT * FROM reports').all();
  const result = await computeTrendSnapshotInWorker(job);
  assert.deepEqual(db.prepare('SELECT * FROM reports').all(), sourceBefore);
  assert.equal(result.records.length, expected.length);
  for (const item of expected) {
    const record = result.records.find(row => row.key === trendSeriesKey(item.indicatorKey, item.unit))!;
    assert.ok(record);
    const {excludedPointCount, ...summary} = JSON.parse(record.summary);
    assert.deepEqual({...summary, points: JSON.parse(record.chart), ...JSON.parse(record.detail)}, item);
  }
  assert.equal(publishTrendSnapshot(job, result, db), true);
  assert.equal(Number(state(db).invalidated), 0);
  assert.equal(claimTrendSnapshotJob(db), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trend_snapshot_entries').get()!.n, 2);
}));

test('incremental publication removes obsolete keys and keeps unaffected series immutable', () => fixture(async db => {
  const job = claimTrendSnapshotJob(db)!;
  const initial = await computeTrendSnapshotInWorker(job);
  publishTrendSnapshot(job, initial, db);
  const initialKeys = initial.records.map(row => row.key);
  db.exec(`INSERT INTO reports(id,member_id,created_by,report_type,title,status,report_issued_at)
    VALUES('second','member','owner','laboratory','Synthetic','ready','2026-02-01');
    INSERT INTO observations(id,report_id,section_name,item_name,normalized_name,result_text,numeric_value,unit)
    VALUES('second-wbc','second','血常规','白细胞计数','白细胞计数','6',6,'10^9/L');`);
  normalizeReportObservations('second');
  const update = claimTrendSnapshotJob(db)!;
  assert.equal(update.full, false);
  const incremental = await computeTrendSnapshotInWorker(update);
  assert.equal(incremental.records.length, 1, 'only the affected indicator is re-analysed');
  assert.equal(publishTrendSnapshot(update, incremental, db), true);
  const rebuilt = listTrendSeries(owner, 'member');
  for (const item of rebuilt) {
    const key = trendSeriesKey(item.indicatorKey, item.unit);
    const row = db.prepare(`SELECT s.* FROM trend_snapshot_entries e JOIN trend_snapshot_series s USING(member_id,series_key,content_hash)
      WHERE e.member_id='member' AND e.revision=? AND e.series_key=?`).get(update.revision, key)!;
    const {excludedPointCount, ...summary} = JSON.parse(String(row.summary_json));
    assert.deepEqual({...summary, points: JSON.parse(String(row.chart_json)), ...JSON.parse(String(row.detail_json))}, item);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trend_snapshot_series').get()!.n, initialKeys.length);
}));

test('updates during computation cannot publish a stale revision and failed jobs remain retryable', () => fixture(async db => {
  const job = claimTrendSnapshotJob(db)!;
  const result = await computeTrendSnapshotInWorker(job);
  db.exec("UPDATE observations SET numeric_value=6,result_text='6' WHERE id='wbc'");
  assert.equal(publishTrendSnapshot(job, result, db), false);
  assert.equal(Number(state(db).active_revision), 0);
  const next = claimTrendSnapshotJob(db)!;
  assert.ok(next.revision > job.revision);
  failTrendSnapshot(next, db);
  assert.equal(state(db).lease_token, null);
  assert.equal(Number(state(db).attempts), 1);
  assert.equal(claimTrendSnapshotJob(db), null);
  db.exec('UPDATE trend_snapshot_members SET retry_at=0');
  assert.ok(claimTrendSnapshotJob(db));
}));

test('trash and member deletion cannot leave a readable stale snapshot', () => fixture(async db => {
  const job = claimTrendSnapshotJob(db)!;
  publishTrendSnapshot(job, await computeTrendSnapshotInWorker(job), db);
  db.exec("UPDATE reports SET status='trashed' WHERE id='report'");
  assert.equal(Number(state(db).invalidated), 1);
  const trashed = claimTrendSnapshotJob(db)!;
  const empty = await computeTrendSnapshotInWorker(trashed);
  assert.equal(empty.records.length, 0);
  publishTrendSnapshot(trashed, empty, db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trend_snapshot_entries').get()!.n, 0);
  db.exec("DELETE FROM reports WHERE id='report'; DELETE FROM health_members WHERE id='member'");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trend_snapshot_members').get()!.n, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}));

test('moving a report invalidates both members in the same transaction', () => fixture(async db => {
  const job = claimTrendSnapshotJob(db)!;
  publishTrendSnapshot(job, await computeTrendSnapshotInWorker(job), db);
  db.exec("INSERT INTO health_members(id,display_name,created_by) VALUES('destination','Synthetic','owner')");
  db.exec("UPDATE reports SET member_id='destination' WHERE id='report'");
  assert.equal(Number(state(db).invalidated), 1);
  assert.ok(Number(state(db).desired_revision) > job.revision);
  const target = db.prepare("SELECT * FROM trend_snapshot_members WHERE member_id='destination'").get()!;
  assert.equal(Number(target.invalidated), 1);
  assert.ok(db.prepare("SELECT 1 FROM trend_snapshot_dirty_reports WHERE member_id='destination' AND report_id='report'").get());
}));

test('an older database is backed up before idempotent snapshot structure completion', () => fixture(db => {
  const directory = process.env.STORAGE_DIR!;
  const before = db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()!.n;
  const source = db.prepare('SELECT * FROM observations ORDER BY id').all();
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trend_dirty_%'").all()) {
    db.exec(`DROP TRIGGER ${row.name}`);
  }
  for (const name of ['entries','series','contributions','dirty_reports','members']) db.exec(`DROP TABLE trend_snapshot_${name}`);
  closeDatabaseForTests();
  const reopened = getDatabase();
  assert.equal(needsTrendSnapshotDraft(reopened), false);
  assert.equal(reopened.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()!.n, before);
  assert.deepEqual(reopened.prepare('SELECT * FROM observations ORDER BY id').all(), source);
  assert.ok(readdirSync(join(directory, 'backups/db')).some(name => name.endsWith('.sqlite')));
  closeDatabaseForTests();
  assert.equal(needsTrendSnapshotDraft(getDatabase()), false);
}));

test('incompatible snapshot structure fails startup after backup without discarding source data', () => fixture(db => {
  const directory = process.env.STORAGE_DIR!;
  db.exec('ALTER TABLE trend_snapshot_members RENAME COLUMN desired_revision TO incompatible_revision');
  closeDatabaseForTests();
  assert.throws(() => getDatabase());
  const probe = new DatabaseSync(join(directory, 'db/health-records.sqlite'), {readOnly: true});
  try { assert.equal(probe.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n, 2); }
  finally { probe.close(); }
  assert.ok(readdirSync(join(directory, 'backups/db')).some(name => name.endsWith('.sqlite')));
}));

test('production workers run from fnOS and Docker layouts outside the development checkout', () => fixture(async db => {
  execFileSync(process.execPath, ['scripts/build-trend-worker.mjs'], {stdio:'pipe'});
  const cwd=process.cwd(),previous=process.env.NODE_ENV,previousDestination=process.env.TRIM_APPDEST;
  const packageRoot=join(dirname(getDatabasePath()),'packaged-apps');
  const layouts=[{name:'fnos',relative:'server/server',destination:true},{name:'docker',relative:'.server-dist/server',destination:false}];
  const job=claimTrendSnapshotJob(db)!;
  try {
    process.env.NODE_ENV='production';
    let published:Awaited<ReturnType<typeof computeTrendSnapshotInWorker>>|undefined;
    for(const layout of layouts){
      const app=join(packageRoot,layout.name);
      mkdirSync(join(app,layout.relative),{recursive:true});
      copyFileSync(join(cwd,'.server-dist/server/trend-snapshot-worker.mjs'),join(app,layout.relative,'trend-snapshot-worker.mjs'));
      if(layout.destination)process.env.TRIM_APPDEST=app;else delete process.env.TRIM_APPDEST;
      process.chdir(app);
      const result=await computeTrendSnapshotInWorker(job);
      assert.equal(result.records.length,2,layout.name);
      if(published)assert.deepEqual(result,published,'deployment layout must not alter computed histories');
      published=result;
    }
    assert.equal(publishTrendSnapshot(job,published!,db),true);
  } finally {
    process.chdir(cwd);
    if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;
    if(previousDestination===undefined)delete process.env.TRIM_APPDEST;else process.env.TRIM_APPDEST=previousDestination;
  }
}));

test('renaming an observation removes its old series and rebuilds its new identity', () => fixture(async db => {
  const job = claimTrendSnapshotJob(db)!;
  const initial = await computeTrendSnapshotInWorker(job);
  publishTrendSnapshot(job, initial, db);
  const old = initial.records.find(row => row.name === '白细胞计数')!;
  assert.ok(old);
  db.exec(`UPDATE observations SET item_name='肌酐',normalized_name='肌酐',unit='μmol/L',
    numeric_value=80,result_text='80',reference_text='50-100' WHERE id='wbc'`);
  normalizeReportObservations('report');
  const changed = claimTrendSnapshotJob(db)!;
  const next = await computeTrendSnapshotInWorker(changed);
  assert.ok(next.affectedKeys.includes(old.key));
  assert.equal(next.records.some(row => row.key === old.key), false);
  assert.ok(next.records.some(row => row.name === '肌酐'));
  publishTrendSnapshot(changed, next, db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trend_snapshot_series WHERE series_key=?').get(old.key)!.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trend_snapshot_contributions WHERE series_key=?').get(old.key)!.n, 0);
}));

test('snapshot queries search all published indicators, paginate and read chart/detail separately', () => fixture(async db => {
  const building = queryTrendSnapshotSeries(owner, 'member');
  assert.equal(building.status, 'building');assert.equal(building.items.length, 0);
  const job = claimTrendSnapshotJob(db)!;
  publishTrendSnapshot(job, await computeTrendSnapshotInWorker(job), db);
  const first = queryTrendSnapshotSeries(owner, 'member', {limit:1});
  assert.equal(first.total, 2);assert.equal(first.items.length, 1);assert.ok(first.nextCursor);
  const second = queryTrendSnapshotSeries(owner, 'member', {limit:1,cursor:first.nextCursor!});
  assert.equal(second.items.length, 1);assert.equal(second.nextCursor,null);
  assert.notEqual(first.items[0].snapshotKey,second.items[0].snapshotKey);
  assert.equal(queryTrendSnapshotSeries(owner,'member',{query:' 血 红 蛋 白 '}).items[0].name,'血红蛋白');
  assert.equal(queryTrendSnapshotSeries(owner,'member',{query:'不存在'}).total,0);
  assert.equal(queryTrendSnapshotSeries(owner,'member',{group:'unknown'}).total,0);
  const parts=readTrendSnapshotParts(owner,'member',first.version!,[first.items[0].snapshotKey],'chart');
  assert.equal(parts.version,first.version);assert.ok(Array.isArray(parts.items[0].data));
  const details=readTrendSnapshotParts(owner,'member',first.version!,[first.items[0].snapshotKey],'detail');
  assert.ok(Array.isArray(details.items[0].data.excludedPoints));
  assert.throws(()=>queryTrendSnapshotSeries({...owner,id:'unauthorized'},'member'));
  assert.throws(()=>queryTrendSnapshotSeries(owner,'member',{cursor:Buffer.from('null').toString('base64url')}));
  assert.throws(()=>queryTrendSnapshotSeries(owner,'member',{query:'new',cursor:first.nextCursor!}));
  db.exec("UPDATE reports SET status='trashed' WHERE id='report'");
  assert.equal(queryTrendSnapshotSeries(owner,'member').status,'building');
  assert.throws(()=>readTrendSnapshotParts(owner,'member',first.version!,[first.items[0].snapshotKey],'chart'));
}));

test('pin changes invalidate cursors without rebuilding a member snapshot', () => fixture(async db => {
  const job=claimTrendSnapshotJob(db)!;publishTrendSnapshot(job,await computeTrendSnapshotInWorker(job),db);
  const first=queryTrendSnapshotSeries(owner,'member',{limit:1});
  const before=Number(state(db).desired_revision);
  const item=first.items[0];
  db.prepare('INSERT INTO user_trend_pins(user_id,member_id,indicator_key,unit_key) VALUES(?,?,?,?)').run(owner.id,'member',item.indicatorKey,item.unit || '');
  assert.equal(Number(state(db).desired_revision),before);
  assert.throws(()=>queryTrendSnapshotSeries(owner,'member',{cursor:first.nextCursor!}));
  assert.equal(queryTrendSnapshotSeries(owner,'member',{pin:'only'}).total,1);
}));

test('snapshot HTTP overview and batch reads validate versions and preserve permissions', () => fixture(async db => {
  const job = claimTrendSnapshotJob(db)!;
  publishTrendSnapshot(job, await computeTrendSnapshotInWorker(job), db);
  let identity = owner;
  const app = new H3();
  app.use(event => {event.context.requestUser = identity;});
  app.get('/api/trends/snapshot',overviewHandler);
  app.post('/api/trends/snapshot/charts',chartHandler);
  const response = await app.request('http://localhost/api/trends/snapshot?memberId=member');
  assert.equal(response.status,200);
  const overview = (await response.json()).data;
  assert.equal(overview.total,2);assert.ok(overview.firstSection);
  assert.equal(overview.firstSection.items.length,2);
  assert.equal(overview.firstSection.items[0].chartLoaded,false);
  const keys = [overview.firstSection.items[0].snapshotKey];
  const request = (body:unknown) => app.request('http://localhost/api/trends/snapshot/charts',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
  });
  const charts = await request({memberId:'member',version:overview.version,keys});
  assert.equal(charts.status,200);assert.equal((await charts.json()).data.items.length,1);
  assert.equal((await request({memberId:'member',keys})).status,400);
  assert.equal((await request(null)).status,400);
  assert.equal((await request({memberId:'member',version:overview.version,keys:[{}]})).status,400);
  identity = {...owner,id:'unauthorized'};
  assert.equal((await request({memberId:'member',version:overview.version,keys})).status,403);
}));

test('closing storage terminates an old worker and startup recovers its durable lease', () => fixture(async db => {
  const job = claimTrendSnapshotJob(db)!;
  const computation = computeTrendSnapshotInWorker(job);
  const rejected = assert.rejects(computation,/TREND_WORKER/);
  closeDatabaseForTests();
  await rejected;
  const reopened = getDatabase();
  assert.equal(Number(state(reopened).active_revision),0);
  await runTrendSnapshotTasksOnce();
  assert.equal(Number(state(reopened).active_revision),Number(state(reopened).desired_revision));
  assert.equal(state(reopened).lease_token,null);
}));

test('serving a published snapshot never reads clinical source tables or performs writes', () => fixture(async db => {
  const job=claimTrendSnapshotJob(db)!;
  publishTrendSnapshot(job,await computeTrendSnapshotInWorker(job),db);
  const prepare=db.prepare.bind(db);
  db.prepare=((sql:string)=>{
    assert.doesNotMatch(sql,/\b(?:FROM|JOIN)\s+(?:observations|reports|report_pages|ocr_results|observation_normalizations)\b/i);
    assert.doesNotMatch(sql,/^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i);
    return prepare(sql);
  }) as typeof db.prepare;
  try {
    const page=queryTrendSnapshotSeries(owner,'member',{query:'血',limit:1});
    assert.equal(page.items.length,1);
    assert.ok(readTrendSnapshotParts(owner,'member',page.version!,[page.items[0].snapshotKey],'chart').items.length);
    assert.equal(readLegacyTrendSnapshot(owner,'member').series.length,2);
  }finally{db.prepare=prepare;}
}));


test('pin validation reads only the published snapshot and rejects invalidated or inaccessible identities', () => fixture(async db => {
  const job = claimTrendSnapshotJob(db)!;
  publishTrendSnapshot(job, await computeTrendSnapshotInWorker(job), db);
  const series = queryTrendSnapshotSeries(owner, 'member').items[0];
  const input = {memberId:'member', indicatorKey:series.indicatorKey, unit:series.unit};
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    assert.doesNotMatch(sql, /(?:FROM|JOIN)\s+(?:observations|reports|report_pages|observation_normalizations)\b/i);
    return prepare(sql);
  }) as typeof db.prepare;
  try {
    assert.equal(updateTrendPin(owner, input, true).pinned, true);
    assert.throws(() => updateTrendPin(owner, {...input, indicatorKey:'institution:forged'}, true), /指标趋势不存在/);
    assert.throws(() => updateTrendPin({...owner,id:'stranger'}, input, true));
  } finally { db.prepare = prepare; }
  db.exec("UPDATE reports SET status='trashed' WHERE id='report'");
  assert.throws(() => updateTrendPin(owner, input, true), /指标趋势不存在/);
  assert.equal(updateTrendPin(owner, input, false).pinned, false, 'stale pins can always be removed');
}));


test('restoring a backup invalidates derived results and clears backup leases without altering sources', () => fixture(async db => {
  const job=claimTrendSnapshotJob(db)!;
  publishTrendSnapshot(job,await computeTrendSnapshotInWorker(job),db);
  db.exec("UPDATE trend_snapshot_members SET lease_token='backup-lease',attempts=4,error_code='RETRY'");
  const path=join(dirname(getDatabasePath()),'restore-copy.sqlite');
  db.exec("VACUUM INTO '"+path.replaceAll("'","''")+"'");
  const restored=prepareRestoredDatabase(path);
  try{
    const row=restored.prepare("SELECT * FROM trend_snapshot_members WHERE member_id='member'").get()!;
    assert.equal(row.invalidated,1);assert.equal(row.full_rebuild,1);
    assert.ok(Number(row.desired_revision)>Number(row.active_revision));
    assert.equal(row.lease_token,null);assert.equal(row.attempts,0);assert.equal(row.error_code,null);
    assert.deepEqual(restored.prepare('SELECT id,result_text,numeric_value FROM observations ORDER BY id').all(),
      db.prepare('SELECT id,result_text,numeric_value FROM observations ORDER BY id').all());
    assert.equal(state(db).invalidated,0,'preparing restoration never changes the live snapshot');
  }finally{restored.close();}
}));


test('dictionary changes and algorithm revisions rebuild snapshots without a read-time calculation', () => fixture(async db => {
  const initial=claimTrendSnapshotJob(db)!;
  publishTrendSnapshot(initial,await computeTrendSnapshotInWorker(initial),db);
  const before=Number(state(db).active_revision);
  db.exec("UPDATE indicator_catalog SET explanation=COALESCE(explanation,'') || ' ' WHERE canonical_key=(SELECT canonical_key FROM observation_normalizations WHERE observation_id='wbc')");
  assert.ok(Number(state(db).desired_revision)>before);
  assert.equal(state(db).full_rebuild,1);
  const catalogJob=claimTrendSnapshotJob(db)!;assert.equal(catalogJob.full,true);
  publishTrendSnapshot(catalogJob,await computeTrendSnapshotInWorker(catalogJob),db);
  const catalogVersion=Number(state(db).active_revision);
  db.exec("UPDATE trend_snapshot_members SET algorithm_version='previous-algorithm'");
  closeDatabaseForTests();const reopened=getDatabase();
  await runTrendSnapshotTasksOnce();
  assert.ok(Number(state(reopened).active_revision)>catalogVersion);
  assert.equal(Number(state(reopened).active_revision),Number(state(reopened).desired_revision));
  assert.equal(state(reopened).algorithm_version,'trend-analysis-1');
}));
