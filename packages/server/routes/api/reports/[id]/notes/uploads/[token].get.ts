import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { defineEventHandler, getRouterParam, getQuery, setHeader, sendStream } from 'h3';
import { getStagedNoteImage } from '../../../../../../services/report-note.service';
import { getRequestUser } from '../../../../../../utils/request-user';
export default defineEventHandler(event => {
  const file = getStagedNoteImage(getRequestUser(event), getRouterParam(event, 'id') || '', getRouterParam(event, 'token') || '', String(getQuery(event).variant || 'preview'));
  setHeader(event, 'content-type', file.mimeType);
  setHeader(event, 'cache-control', 'private, no-store');
  setHeader(event, 'x-content-type-options', 'nosniff');
  return sendStream(event, Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream);
});
