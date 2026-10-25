import { defineEventHandler,readBody } from 'h3';
import { createPublicSymptom } from '../../services/public-symptom.service';
import { getRequestUser } from '../../utils/request-user';
import { ok } from '../../utils/api-response';
export default defineEventHandler(async event=>ok(createPublicSymptom(getRequestUser(event),await readBody(event)||{})));
