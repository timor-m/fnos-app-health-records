import {defineEventHandler,getRouterParam} from 'h3';
import {getRecordProcess} from '../../../../services/health-record-process.service';
import {listReminders} from '../../../../services/records.service';
import {getRequestUser} from '../../../../utils/request-user';
import {ok} from '../../../../utils/api-response';
export default defineEventHandler(event=>{const user=getRequestUser(event),process=getRecordProcess(user,getRouterParam(event,'id')||'');return ok(listReminders(user,process.memberId,process));});
