import {createError,defineEventHandler,getQuery} from 'h3';
import {readHealthRecordIndex} from '../../services/health-record-index.service';
import {getRequestUser} from '../../utils/request-user';
import {ok} from '../../utils/api-response';
export default defineEventHandler(event=>{const {memberId,...query}=getQuery(event);if(typeof memberId!=='string'||!memberId)throw createError({statusCode:400,statusMessage:'请选择成员'});return ok(readHealthRecordIndex(getRequestUser(event),memberId,query));});
