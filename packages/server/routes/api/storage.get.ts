import { defineEventHandler } from 'h3';
import { getArchiveStorageStatus } from '../../services/archive-storage.service';
import { getRequestUser } from '../../utils/request-user';
import { ok } from '../../utils/api-response';

export default defineEventHandler(async event => ok(await getArchiveStorageStatus(getRequestUser(event))));
