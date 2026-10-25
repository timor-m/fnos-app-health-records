import { defineEventHandler, readBody } from 'h3';
import { createMedicationCourse } from '../../services/medication.service';
import { ok } from '../../utils/api-response';
import { getRequestUser } from '../../utils/request-user';
export default defineEventHandler(async event => ok(createMedicationCourse(getRequestUser(event), await readBody(event) || {})));
