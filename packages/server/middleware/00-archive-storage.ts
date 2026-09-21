import { classifySystemError } from "../utils/api-error";
import { defineEventHandler, readBody, setResponseHeader, setResponseStatus } from 'h3';
import { gatewayUser } from '../utils/request-user';
import { getAppConfig } from '../utils/runtime-config';
import { isAdministrator, type RequestUser } from '../domain/request-user';
import { fail, ok } from '../utils/api-response';
import { storageMigrationPaused } from '../utils/storage-migration-state';
import { getArchiveStorageStatus } from '../services/archive-storage.service';
import { startStorageMigration, previewStorageMigration, resumeStorageMigration, cancelStorageMigration, previewStorageCleanup, cleanupStorageSource } from '../services/storage-migration.service';

// Runs before database initialization: fnOS gateway identity does not depend on the archive DB.
export default defineEventHandler(async event => {
  const config = getAppConfig();
  if (!['fnos', 'development'].includes(config.authMode)) return;
  const user: RequestUser | null = config.authMode === 'development'
    ? { id: 'local-development-owner', displayName: '开发管理员', provider: 'development', authenticated: true, isAdmin: true, isGatewayAdmin: true }
    : gatewayUser(event);
  const administrator = Boolean(user?.authenticated && isAdministrator(user));
  const path = new URL(event.req.url).pathname;
  const control = path.match(/\/api\/storage(?:\/(preview|migrate|resume|cancel|cleanup-preview|cleanup))?$/);
  if (control) {
    setResponseHeader(event, 'cache-control', 'no-store');
    if (!administrator || !user) { setResponseStatus(event, 403); return fail('仅管理员可操作档案存储', { status: 403 }); }
    try {
      if (!control[1] && event.method === 'GET') return ok(await getArchiveStorageStatus(user));
      // Non-simple header prevents browser form/CSRF requests. No CORS preflight is granted here.
      if (event.method !== 'POST' || event.req.headers.get('x-storage-operation') !== '1'
        || event.req.headers.get('sec-fetch-site') === 'cross-site') {
        setResponseStatus(event, 403); return fail('请从应用存储设置发起操作', { status: 403, code: 'REQUEST_BLOCKED' });
      }
      const action = control[1];
      if (action === 'resume') return ok(resumeStorageMigration());
      if (action === 'cancel') return ok(cancelStorageMigration());
      if (action === 'cleanup-preview' || action === 'cleanup') {
        const body = await readBody<{ migrationId?: unknown; confirmed?: unknown }>(event);
        if (typeof body?.migrationId !== 'string' || (action === 'cleanup' && body.confirmed !== true)) {
          setResponseStatus(event, 400); return fail('请先核对旧副本清理范围并确认删除');
        }
        return ok(action === 'cleanup-preview' ? await previewStorageCleanup(body.migrationId) : await cleanupStorageSource(body.migrationId));
      }
      const body = await readBody<{ rootId?: unknown }>(event);
      if (typeof body?.rootId !== 'string' || body.rootId.length > 128) {
        setResponseStatus(event, 400); return fail('请选择已授权的目标目录');
      }
      if (action === 'preview') return ok(await previewStorageMigration(body.rootId));
      if (action === 'migrate') return ok(await startStorageMigration(body.rootId));
      setResponseStatus(event, 404); return fail('操作不存在', { status: 404 });
    } catch (error) {
      const classified = classifySystemError(error);
      if (classified) {
        setResponseStatus(event, classified.status);
        return fail(classified.message, { status: classified.status, code: classified.code });
      }
      setResponseStatus(event, 409);
      return fail(error instanceof Error && error.name === 'StorageMigrationError' ? error.message : '存储操作未完成，请检查目录授权、剩余空间和迁移状态。', { status: 409, code: 'STORAGE_UNAVAILABLE' });
    }
  }
  if (!(storageMigrationPaused() || config.storageError)) return;
  setResponseHeader(event, 'cache-control', 'no-store');
  if (event.method !== 'GET' || path.includes('/api/')) {
    setResponseStatus(event, 503); return fail('档案维护中，业务访问已暂停', { status: 503, code: 'STORAGE_UNAVAILABLE' });
  }
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8');
  if (!administrator) { setResponseStatus(event, 503); return '<!doctype html><meta charset="utf-8"><p>档案维护中，请稍后再试或联系管理员。</p>'; }
  const api = JSON.stringify(`${config.gatewayPrefix}/api/storage`).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>档案存储维护</title>
<style>body{font:16px/1.7 system-ui;margin:0;padding:24px;background:#f4f7f6;color:#243832}main{max-width:600px;margin:10vh auto;padding:24px;border-radius:16px;background:white}button{font:inherit;border:0;border-radius:10px;padding:10px 18px;margin:8px 8px 0 0;background:#087f70;color:white}button:disabled{opacity:.5}#message{overflow-wrap:anywhere}</style>
<main><h1>档案存储维护</h1><p>迁移期间暂停业务访问，源数据保留。刷新或关闭页面不会取消后台任务。</p><p id="message" role="status">读取中…</p><button id="resume" hidden>继续迁移</button><button id="cancel" hidden>取消迁移</button><button id="back" hidden>返回应用</button></main>
<script>const api=${api};let busy=false;const message=document.getElementById('message');
const labels={waiting:'等待现有任务结束',copying:'正在复制',verifying:'正在校验',switching:'正在切换',completed:'迁移完成',failed:'迁移未完成',cancelled:'已取消'};
async function refresh(){if(busy)return;try{const r=await fetch(api);const b=await r.json();if(!r.ok||!b.ok)throw Error(b.error?.message||'读取失败');const s=b.data,m=s.migration;
message.textContent=(m?(labels[m.phase]||m.phase)+'：'+m.copiedFiles+' / '+m.files+' 个文件。':'')+(m?.error||s.error||'');
document.getElementById('resume').hidden=!(m&&(m.interrupted||m.phase==='failed'));
document.getElementById('cancel').hidden=!(m&&!m.switched&&!['switching','completed','cancelled'].includes(m.phase));
document.getElementById('back').hidden=!!s.paused||s.state!=='ready';}catch(e){message.textContent=e.message;}}
for(const action of ['resume','cancel'])document.getElementById(action).onclick=async()=>{if(busy||!confirm(action==='cancel'?'取消迁移并保留两个目录中的文件？':'确认恢复迁移？'))return;busy=true;try{const r=await fetch(api+'/'+action,{method:'POST',headers:{'x-storage-operation':'1'}});const b=await r.json();if(!r.ok||!b.ok)throw Error(b.error?.message||'操作失败');}catch(e){message.textContent=e.message;}finally{busy=false;}};
document.getElementById('back').onclick=()=>location.reload();refresh();setInterval(refresh,2000);</script></html>`;
});
