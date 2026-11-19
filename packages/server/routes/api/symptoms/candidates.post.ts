import {defineEventHandler,readBody} from 'h3';
import {symptomContinuationCandidates} from '../../../services/health-observation.service';
import {getRequestUser} from '../../../utils/request-user';
import {ok} from '../../../utils/api-response';
export default defineEventHandler(async event=>ok(symptomContinuationCandidates(getRequestUser(event),await readBody(event)||{})));
