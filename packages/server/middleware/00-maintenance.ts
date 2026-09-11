import { defineEventHandler, setResponseHeader, setResponseStatus } from "h3";
import { getDatabase, getUnreleasedSchemaMaintenance } from "../database/client";
import { fail } from "../utils/api-response";
import { getAppConfig } from "../utils/runtime-config";
import { storageMigrationPaused } from "../utils/storage-migration-state";

function maintenancePage(apiBase: string, databaseVersion: number, supportedVersion: number) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>数据库需要修复 · 健康档案</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(160deg, #0f1b33 0%, #16294d 55%, #1d3a6b 100%);
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2329;
    padding: 24px; }
  .card { background: #fff; border-radius: 16px; box-shadow: 0 24px 64px rgba(2,10,30,.45);
    padding: 40px 36px 32px; max-width: 480px; width: 100%;
    animation: rise .5s cubic-bezier(.2,.8,.3,1) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
  .icon { width: 56px; height: 56px; border-radius: 16px; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #e8f0ff, #d4e3ff); margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0 0 8px; letter-spacing: .2px; }
  .sub { font-size: 14px; line-height: 1.75; margin: 0 0 20px; color: #5b6472; }
  .versions { display: flex; align-items: center; gap: 12px; margin: 0 0 20px; }
  .ver { flex: 1; border-radius: 12px; padding: 14px 16px; text-align: center; }
  .ver .label { font-size: 12px; color: #86909c; margin-bottom: 4px; }
  .ver .value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ver.old { background: #fff4ec; border: 1px solid #ffd8bd; }
  .ver.old .value { color: #d46b08; }
  .ver.new { background: #eef7ef; border: 1px solid #bfe6c4; }
  .ver.new .value { color: #1f9d55; }
  .arrow { color: #a3aec2; flex: 0 0 auto; }
  .steps { margin: 0 0 24px; padding: 0; list-style: none; }
  .steps li { display: flex; gap: 10px; font-size: 13px; color: #5b6472; line-height: 1.6; margin: 8px 0; align-items: flex-start; }
  .steps .n { flex: 0 0 20px; height: 20px; border-radius: 50%; background: #eef2ff; color: #3370ff;
    font-size: 12px; font-weight: 600; display: flex; align-items: center; justify-content: center; margin-top: 1px; }
  button { width: 100%; border: 0; border-radius: 10px; padding: 13px; font-size: 15px; font-weight: 600;
    cursor: pointer; background: linear-gradient(135deg, #3370ff, #2b5fd9); color: #fff;
    transition: transform .12s ease, box-shadow .12s ease; box-shadow: 0 6px 16px rgba(51,112,255,.28); }
  button:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 20px rgba(51,112,255,.34); }
  button:disabled { background: #a8c3ff; box-shadow: none; cursor: not-allowed; }
  #result { font-size: 13px; margin-top: 14px; min-height: 20px; text-align: center; }
  #result.ok { color: #1f9d55; font-weight: 600; }
  #result.err { color: #e5484d; }
  .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid #fff; border-top-color: transparent;
    border-radius: 50%; vertical-align: -2px; margin-right: 8px; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3370ff" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round">
        <ellipse cx="12" cy="5" rx="8" ry="3"/>
        <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/>
        <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>
        <path d="M16.5 16.5l1.8 1.8 3.2-3.6" stroke="#1f9d55"/>
      </svg>
    </div>
    <h1>数据库结构需要适配</h1>
    <p class="sub">本地数据库记录的是应用正式发布前开发阶段的结构版本。你的报告与指标数据完整无损，执行一次适配即可继续。</p>
    <div class="versions">
      <div class="ver old">
        <div class="label">当前数据库</div>
        <div class="value">v${databaseVersion}</div>
      </div>
      <svg class="arrow" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>
      </svg>
      <div class="ver new">
        <div class="label">适配目标</div>
        <div class="value">v${supportedVersion}</div>
      </div>
    </div>
    <ul class="steps">
      <li><span class="n">1</span>自动备份完整数据库文件到本机备份目录</li>
      <li><span class="n">2</span>移除未发布的结构版本记录（v17 – v19）</li>
      <li><span class="n">3</span>按当前应用版本补齐正式结构，无需重启</li>
    </ul>
    <button id="repair">备份并完成适配</button>
    <div id="result"></div>
  </div>
<script>
  var btn = document.getElementById('repair');
  var result = document.getElementById('result');
  btn.addEventListener('click', async function () {
    btn.disabled = true;
    result.className = ''; result.innerHTML = '<span class="spin" style="border-color:#3370ff;border-top-color:transparent"></span>正在备份并适配…';
    try {
      var resp = await fetch('${apiBase}/maintenance/repair-unreleased-schema', { method: 'POST' });
      var body = await resp.json();
      if (!resp.ok || !body.ok) throw new Error((body.error && body.error.message) || '修复失败');
      result.className = 'ok';
      result.textContent = '适配完成，正在进入应用…';
      setTimeout(function () { location.reload(); }, 1000);
    } catch (error) {
      btn.disabled = false;
      result.className = 'err';
      result.textContent = '适配失败：' + (error && error.message ? error.message : error) + '。数据库备份已保留，可重试。';
    }
  });
</script>
</body>
</html>`;
}

export default defineEventHandler((event) => {
  if (storageMigrationPaused()) {
    setResponseStatus(event, 503);
    setResponseHeader(event, 'retry-after', '5');
    return fail('档案迁移维护中，业务访问已暂停。请等待迁移完成或由管理员恢复迁移。');
  }
  const storageError = getAppConfig().storageError;
  if (storageError) {
    setResponseStatus(event, 503);
    return fail(storageError);
  }
  getDatabase();
  const maintenance = getUnreleasedSchemaMaintenance();
  if (!maintenance) return;

  const path = event.path || "";
  const apiBase = `${getAppConfig().gatewayPrefix}/api`;
  if (path.endsWith("/api/maintenance/repair-unreleased-schema") || path.endsWith("/healthz")) return;

  if (path.includes("/api/")) {
    setResponseStatus(event, 503);
    return fail("数据库需要修复未发布的结构版本后才能使用", { maintenance });
  }
  if (event.method === "GET") {
    setResponseHeader(event, "content-type", "text/html; charset=utf-8");
    setResponseStatus(event, 503);
    return maintenancePage(apiBase, maintenance.databaseVersion, maintenance.supportedVersion);
  }
});
