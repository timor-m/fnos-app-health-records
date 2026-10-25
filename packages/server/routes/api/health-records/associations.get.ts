import { defineEventHandler, getQuery } from 'h3';
import { associationRef } from '../../../services/health-record-context.service';
import { getRecordAssociations } from '../../../services/health-record-association.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(event=>{const query=getQuery(event);return ok(getRecordAssociations(getRequestUser(event),associationRef({kind:query.kind,id:query.id})));});
