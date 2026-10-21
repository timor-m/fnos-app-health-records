import { getDatabase } from '../../../database/client';
import { recordFeedbackStates, type FeedbackList, type FeedbackState } from '../../../services/feedback-sync.service';
import { getFeedbackInstallation } from '../../../services/feedback-installation.service';
import { validateFeedbackEnvironment } from '../../../services/feedback-validation';
import { createError, defineEventHandler, getHeader, getQuery, getRouterParam, setHeader } from 'h3';
import { readFile } from 'node:fs/promises';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
import { withMultipartUpload } from '../../../utils/read-multipart-upload';
import { sendFeedbackRequest } from '../../../services/feedback-remote.service';

export default defineEventHandler(async event => {
  if(!getRequestUser(event).authenticated) throw createError({statusCode:401,statusMessage:'请先登录应用'});
  setHeader(event,'Cache-Control','no-store');
  const path='/'+(getRouterParam(event,'path') || '');
  const ticket='/tickets/(?:[BSO]\\d{4,20}|FB-\\d{4}-\\d{6,20})';
  const get=event.req.method==='GET';
  if(get && /^\/attachments\/[1-9]\d{0,15}$/.test(path) && Number.isSafeInteger(Number(path.split('/').at(-1)))) {
    if(Object.keys(getQuery(event)).length) throw createError({statusCode:400,statusMessage:'截图参数无效'});
    const image=await sendFeedbackRequest(path,{image:true}) as {bytes:Buffer;mimeType:string};
    setHeader(event,'Cache-Control','private, no-store');
    return new Response(new Uint8Array(image.bytes),{headers:{'Content-Type':image.mimeType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}});
  }
  if(get && path==='/identity') return ok({clientId:getFeedbackInstallation()});
  if(get && (path==='/tickets' || new RegExp('^'+ticket+'$').test(path))) {
    const query=getQuery(event); const allowed=path==='/tickets'?['page','pageSize','number','q','status','category']:['eventPage','eventPageSize'];
    const params=new URLSearchParams();
    for(const [key,value] of Object.entries(query)) {
      if(!allowed.includes(key) || typeof value!=='string' || value.length>120) throw createError({statusCode:400,statusMessage:'查询参数无效'});
      params.set(key,value);
    }
    const db=getDatabase(),clientId=getFeedbackInstallation(db);
    if(path==='/tickets') {
      const page=Number(params.get('page') || 1),pageSize=Number(params.get('pageSize') || 20);
      if(!Number.isInteger(page) || page<1 || page>10000 || !Number.isInteger(pageSize) || pageSize<1 || pageSize>50) throw createError({statusCode:400,statusMessage:'分页参数无效'});
      params.set('page',String(page));params.set('pageSize',String(pageSize));
    }
    const result=await sendFeedbackRequest(path+(params.size?'?'+params:''));
    if(path==='/tickets') recordFeedbackStates(db,clientId,(result as FeedbackList).items);
    return ok(result);
  }
  if(event.req.method!=='POST' || !(path==='/upload' || path==='/tickets' || new RegExp('^'+ticket+'/(messages|resolution)$').test(path))) throw createError({statusCode:404,statusMessage:'反馈接口不存在'});
  const key=getHeader(event,'idempotency-key') || '';
  if(!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw createError({statusCode:400,statusMessage:'缺少有效请求标识'});
  if(path==='/upload') return withMultipartUpload(event,{requestBytes:10*1024*1024+65536,fileBytes:10*1024*1024,files:1,sizeMessage:'附件不能超过 10 MB'},async ({files})=>{
    const file=files[0];
    const suffix:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'};
    if(!file || file.name!=='file' || !suffix[file.type] || file.size===0) throw createError({statusCode:400,statusMessage:'请选择 JPG、PNG、WebP 图片或 PDF'});
    const body=new FormData();body.set('appKey','health-records');body.set('file',new Blob([new Uint8Array(await readFile(file.path))],{type:file.type}),(file.type==='application/pdf'?'report.':'screenshot.')+suffix[file.type]);
    const result=await sendFeedbackRequest('/upload',{method:'POST',key,body}) as {id:number;url:string};
    return ok({id:result.id,url:result.url});
  });
  if(!getHeader(event,'content-type')?.startsWith('application/json')) throw createError({statusCode:415,statusMessage:'请求格式无效'});
  const reader=event.req.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  if(reader) {try {while(true) {const {value,done}=await reader.read();if(done) break;size+=value.length;if(size>65536) {await reader.cancel();throw createError({statusCode:413,statusMessage:'反馈内容过大'});}chunks.push(value);}}finally{reader.releaseLock();}}
  let body:Record<string,unknown>;
  try {body=JSON.parse(Buffer.concat(chunks).toString());if(!body||Array.isArray(body)||typeof body!=='object') throw Error();}catch {throw createError({statusCode:400,statusMessage:'反馈内容格式无效'});}
  const allowed=path==='/tickets'?['category','title','description','reproductionSteps','attachmentIds','environment']:path.endsWith('/messages')?['content','attachmentIds']:['action','expectedVersion','content'];
  if(Object.keys(body).some(k=>!allowed.includes(k))) throw createError({statusCode:400,statusMessage:'反馈包含不支持的字段'});
  if(path==='/tickets') {validateFeedbackEnvironment(body.environment);body.appKey='health-records';}
  const db=getDatabase(),clientId=getFeedbackInstallation(db);
  const result=await sendFeedbackRequest(path,{method:'POST',key,json:true,body:JSON.stringify(body)});
  if(path==='/tickets' || path.endsWith('/resolution')) recordFeedbackStates(db,clientId,[result as FeedbackState],false);
  return ok(result);
});
