import { defineEventHandler, readBody } from 'h3';
import { createVaccination } from '../../services/vaccination.service';
import { getRequestUser } from '../../utils/request-user';
import { ok } from '../../utils/api-response';
export default defineEventHandler(async event=>ok(createVaccination(getRequestUser(event),await readBody(event)||{})));
