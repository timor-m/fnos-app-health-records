import { apiUrl, request } from './api';
import { createUuid } from './uuid';
export const feedbackStatus:Record<string,string>={received:'已收到',needs_info:'待补充',confirmed:'已确认',in_progress:'处理中',fixed_pending_release:'已修复，待发布',released_pending_verification:'已发布，待验证',resolved:'已解决',closed:'已关闭'};
export const feedbackCategory:Record<string,string>={problem:'使用问题',suggestion:'功能建议',other:'其他反馈'};
export type FeedbackDraft = {category:'other';title:string;description:string};
// One navigation handoff, kept in memory rather than URLs or browser storage.
let pendingDraft: FeedbackDraft | null = null;
export function setFeedbackDraft(draft: FeedbackDraft) { pendingDraft = {...draft}; }
export function takeFeedbackDraft() { const draft=pendingDraft;pendingDraft=null;return draft; }
export type FeedbackImage={id:number;url:string;mimeType?:string;size?:number};
export type FeedbackEvent={id:number;type:string;actorType:string;content:string;fromStatus?:string;toStatus?:string;fixedVersion?:string;createdAt:string;attachments:FeedbackImage[]};
export type FeedbackTicket={number:string;title:string;category:string;status:string;fixedVersion:string|null;version:number;createdAt:string;updatedAt:string;description?:string;reproductionSteps?:string;attachments?:FeedbackImage[];events?:FeedbackEvent[];eventTotal?:number;environment?:Record<string,Record<string,unknown>>};
export function feedbackImageUrl(image:FeedbackImage) {
  // Only the attachment ID is used; never navigate to a stored public URL.
  return Number.isSafeInteger(image.id) && image.id>0 ? apiUrl('feedback/attachments/'+image.id) : '';
}
export function createFeedbackOperation() {
  const keys=new Map<string,{signature:string;key:string}>();
  return {key(action:string,signature:string) {const prior=keys.get(action);if(prior?.signature===signature) return prior.key;const key=createUuid();keys.set(action,{signature,key});return key;},clear(action?:string){if(action)keys.delete(action);else keys.clear();}};
}
// Installation identity and version are injected by the local backend.
export function requestFeedback<T>(path:string,init?:RequestInit):Promise<T> {
  const headers=new Headers(init?.headers);
  headers.delete('x-client-id');headers.delete('x-version');
  const safe:Record<string,string>={};headers.forEach((value,key)=>{safe[key.toLowerCase()]=value;});
  return request<T>('feedback/'+path,{...init,headers:safe});
}
export function postFeedback<T>(path:string,body:unknown,key:string) {return requestFeedback<T>(path,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)});}
