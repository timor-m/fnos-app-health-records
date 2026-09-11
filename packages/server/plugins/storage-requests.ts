import { definePlugin } from 'nitro';
import { trackStorageRequest, finishStorageRequest } from '../utils/storage-migration-state';

export default definePlugin(app => {
  app.hooks.hook('request', event => {
    if (!/\/api\/storage(?:\/|$)/.test(new URL(event.req.url).pathname)) trackStorageRequest(event.req);
  });
  app.hooks.hook('response', (_response, event) => finishStorageRequest(event.req));
});
