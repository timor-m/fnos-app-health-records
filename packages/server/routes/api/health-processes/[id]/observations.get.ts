import {defineEventHandler,getQuery,getRouterParam} from 'h3';
import {listProcessObservations} from '../../../../services/health-observation.service';
import {getRequestUser} from '../../../../utils/request-user';
import {ok} from '../../../../utils/api-response';
export default defineEventHandler(event=>ok(listProcessObservations(getRequestUser(event),getRouterParam(event,'id')||'',getQuery(event))));
