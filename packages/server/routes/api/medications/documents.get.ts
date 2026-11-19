import { defineEventHandler, getQuery } from 'h3';
import { listMedicationDocuments } from '../../../services/medication.service';
import { ok } from '../../../utils/api-response';
import { getRequestUser } from '../../../utils/request-user';

export default defineEventHandler(event => ok(listMedicationDocuments(getRequestUser(event), getQuery(event))));
