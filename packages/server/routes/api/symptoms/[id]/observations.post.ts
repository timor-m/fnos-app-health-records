import {defineEventHandler,readBody,getRouterParam} from 'h3';
import {continueSymptomObservation} from '../../../../services/health-observation.service';
import {getRequestUser} from '../../../../utils/request-user';
import {ok} from '../../../../utils/api-response';
export default defineEventHandler(async event=>ok(continueSymptomObservation(getRequestUser(event),getRouterParam(event,'id')||'',await readBody(event)||{})));
