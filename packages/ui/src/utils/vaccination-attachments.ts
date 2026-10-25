import { maxUploadFileBytes } from '../../../shared/upload-limits';

export function vaccinationAttachmentError(files:File[]):string {
  if (files.some(file=>!file.size || file.size>maxUploadFileBytes)) return '附件不能为空，单文件上限 40 MB';
  if (files.some(file=>!(/\.(heic|heif|jpe?g|png|webp|pdf)$/i.test(file.name) || ['image/heic','image/heif','image/jpeg','image/png','image/webp','application/pdf'].includes(file.type)))) return '请选择图片或 PDF 附件';
  if (files.length>1000 || files.reduce((sum,file)=>sum+file.size,0)>200*1024*1024) return '一次最多选择 1000 个附件，总大小不超过 200 MB';
  return '';
}
