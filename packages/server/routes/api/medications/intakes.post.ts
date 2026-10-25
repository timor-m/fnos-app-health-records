import { defineEventHandler, readBody } from 'h3';
import { createMedicationIntake } from '../../../services/medication.service';
import { ok } from '../../../utils/api-response';
import { getRequestUser } from '../../../utils/request-user';
export default defineEventHandler(async event => ok(createMedicationIntake(getRequestUser(event),await readBody(event) || {})));
