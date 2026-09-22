import {defineEventHandler,getRouterParam} from 'h3';
import {preflightStoredBackup} from '../../../../services/records.service';
import {getRequestUser} from '../../../../utils/request-user';
import {ok} from '../../../../utils/api-response';
export default defineEventHandler(event=>ok(preflightStoredBackup(getRequestUser(event),getRouterParam(event,'id')||'')));
