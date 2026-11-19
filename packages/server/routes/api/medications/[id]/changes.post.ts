import { defineEventHandler, getRouterParam, readBody } from 'h3';
import { changeMedicationCourse } from '../../../../services/medication.service';
import { ok } from '../../../../utils/api-response';
import { getRequestUser } from '../../../../utils/request-user';
export default defineEventHandler(async event => ok(changeMedicationCourse(getRequestUser(event),getRouterParam(event,'id') || '',await readBody(event) || {})));
