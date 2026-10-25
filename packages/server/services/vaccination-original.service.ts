import { createError } from 'h3';
import { getDatabase } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import type { VaccinationEntry } from '../../shared/health-categories';
import { textInput } from './health-event-input';
import { assertMemberManage } from './member.service';
import { createUploadFromStagedFilesWithCommit, type LocalUploadInputFile } from './upload.service';
import { createVaccination, getVaccination, updateVaccination } from './vaccination.service';
import { retireUnusedVaccinationOriginal } from './records.service';
import { upsertManualReportFieldOverrides } from './report-field-overrides.service';
import { runHealthWorkflowRequest } from './health-workflow-request.service';

export function saveVaccinationWithOriginal(user: RequestUser, input: Record<string,unknown>, files: LocalUploadInputFile[]) {
  const memberId = textInput(input.memberId,'成员',100,true)!;
  const requestKey = textInput(input.requestKey,'保存请求编号',100,true)!;
  const id = textInput(input.id,'接种编号',100);
  assertMemberManage(user,memberId);
  if (id && getVaccination(user,id).memberId !== memberId)
    throw createError({statusCode:403,statusMessage:'接种信息不属于当前成员'});
  let saved: VaccinationEntry | undefined;
  createUploadFromStagedFilesWithCommit(user,memberId,files,requestKey,upload => {
    if (!getDatabase().prepare("SELECT 1 FROM reports WHERE id=? AND member_id=? AND status<>'trashed' AND deleted_at IS NULL").get(upload.reportId,memberId))
      throw createError({statusCode:409,statusMessage:'原件归属或状态已变化，请刷新后重新保存'});
    saved = runHealthWorkflowRequest(user,memberId,'vaccination.original.save',input,() => {
      const previous = id ? getVaccination(user,id) : undefined;
      const db = getDatabase();
      const title = `${textInput(input.vaccineName ?? previous?.vaccineName,'疫苗名称',180,true)} · 原件`;
      // This newly created original inherits its category from the explicit vaccination entry.
      db.prepare("UPDATE reports SET report_type='vaccination',title=?,source_version=source_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(title,upload.reportId);
      upsertManualReportFieldOverrides({reportId:upload.reportId,userId:user.id,fields:[{fieldKey:'reportType',value:'vaccination'},{fieldKey:'title',value:title}]});
      const payload = {...input,requestKey:undefined,sourceReportId:upload.reportId,sourceFactId:null};
      const result = id ? updateVaccination(user,id,payload) : createVaccination(user,payload);
      if (previous?.sourceReportId && previous.sourceReportId !== upload.reportId)
        retireUnusedVaccinationOriginal(previous.sourceReportId,memberId,user.id);
      return result;
    },value => getVaccination(user,value.id));
  });
  return saved!;
}
