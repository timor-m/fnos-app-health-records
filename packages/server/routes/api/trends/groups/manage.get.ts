import {defineEventHandler} from 'h3';
import {listManagedTrendGroups} from '../../../../services/trend-groups.service';
import {getRequestUser} from '../../../../utils/request-user';
import {ok} from '../../../../utils/api-response';
export default defineEventHandler(event=>ok(listManagedTrendGroups(getRequestUser(event))));
