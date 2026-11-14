import {defineEventHandler,readBody,setResponseStatus} from 'h3';
import {savePersonalTrendGroup} from '../../../services/trend-groups.service';
import {getRequestUser} from '../../../utils/request-user';
import {ok} from '../../../utils/api-response';
export default defineEventHandler(async event=>{
  const group=savePersonalTrendGroup(getRequestUser(event),await readBody(event));
  setResponseStatus(event,201);return ok(group);
});
