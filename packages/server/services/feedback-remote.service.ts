import { createError } from 'h3';
import { getAppConfig } from '../utils/runtime-config';
import { getFeedbackInstallation } from './feedback-installation.service';
import { deploymentType, feedbackUserAgent } from '../utils/deployment';
export const feedbackServiceBase = 'https://gateway.lby.link/health/v1';
export async function sendFeedbackRequest(path: string, options: {method?:'GET'|'POST';body?:BodyInit;key?:string;json?:boolean;image?:boolean;signal?:AbortSignal}={}, dependencies={fetch:globalThis.fetch,identity:getFeedbackInstallation}) {
  const config = getAppConfig();
  const headers: Record<string,string>={'x-client-id':dependencies.identity(),'x-version':config.appVersion,'User-Agent':feedbackUserAgent(config.appVersion,deploymentType(config.authMode))};
  if(options.key) headers['Idempotency-Key']=options.key;
  if(options.json) headers['Content-Type']='application/json';
  let response: Response;
  try {response=await dependencies.fetch(feedbackServiceBase+(path === '/upload' ? '/feedback-attachments' : path.startsWith('/attachments/') ? '/feedback-attachments/'+path.slice('/attachments/'.length) : path.replace(/^\/tickets(?=\/|\?|$)/, '/feedbacks')),{method:options.method||'GET',headers,body:options.body,redirect:'error',signal:options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)});}
  catch {throw createError({statusCode:502,statusMessage:'暂时无法连接反馈服务，请稍后重试，填写内容已保留'});}
  if(options.image && response.ok) {
    const type=response.headers.get('content-type')?.split(';')[0];
    if(!type || !['image/jpeg','image/png','image/webp','application/pdf'].includes(type) || Number(response.headers.get('content-length')||0)>10*1024*1024) {await response.body?.cancel();throw createError({statusCode:502,statusMessage:'附件响应异常'});}
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
    if(!reader) throw createError({statusCode:502,statusMessage:'附件响应异常'});
    try {while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>10*1024*1024){await reader.cancel();throw createError({statusCode:502,statusMessage:'附件响应异常'});}chunks.push(value);}}catch{throw createError({statusCode:502,statusMessage:'附件响应异常'});}finally{reader.releaseLock();}
    return {bytes:Buffer.concat(chunks),mimeType:type};
  }
  let payload: {success?:boolean;data?:unknown};
  try {payload=await response.json();} catch {throw createError({statusCode:502,statusMessage:'反馈服务响应异常，请稍后重试'});}
  if(!response.ok || payload.success!==true) {
    if(response.status===404 && (path==='/upload' || /^\/tickets(?:\?|$)/.test(path))) throw createError({statusCode:502,statusMessage:'反馈服务接口尚不可用，请稍后重试'});
    const messages:Record<number,string>={400:'反馈内容不符合要求，请检查填写内容',401:'反馈安装身份无法验证，请联系维护人员',404:'未找到当前安装的反馈',409:'反馈已有变化或请求内容已变更，请刷新后重试',410:'附件已过期，请重新上传',413:'附件或反馈内容超过大小限制',415:'不支持的附件格式',422:'附件无法读取，请检查文件格式或 PDF 密码保护',429:'操作过于频繁，请稍后重试'};
    // Do not expose upstream errors, URLs, credentials or request content to logs/browser.
    throw createError({statusCode:response.status>=500?502:response.status===401?502:response.status,statusMessage:messages[response.status]||'反馈服务暂不可用，请稍后重试'});
  }
  return payload.data;
}
