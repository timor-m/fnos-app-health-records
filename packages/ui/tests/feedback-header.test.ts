import { it,expect,vi } from 'vitest';
import { requestFeedback } from '../src/utils/feedback-service';
const request=vi.hoisted(()=>vi.fn());
vi.mock('../src/utils/api',()=>({request}));
it('browser uses one local request and cannot supply installation or version headers',async()=>{
 request.mockResolvedValue({success:true});
 await requestFeedback('tickets');
 expect(request).toHaveBeenCalledTimes(1);expect(request.mock.calls[0][0]).toBe('feedback/tickets');
 await requestFeedback('tickets/B0001/messages',{method:'POST',headers:{'Idempotency-Key':'retry-id','x-client-id':'forged','x-device-id':'forged','x-app-id':'forged','x-debug':'1','x-version':'forged'},body:'{}'});
 const options=request.mock.calls[1][1];expect(options.headers['x-client-id']).toBeUndefined();expect(options.headers['x-device-id']).toBeUndefined();expect(options.headers['x-app-id']).toBeUndefined();expect(options.headers['x-debug']).toBeUndefined();expect(options.headers['x-version']).toBeUndefined();expect(options.headers['idempotency-key']).toBe('retry-id');
 expect(request.mock.calls.some(call=>call[0]==='feedback/identity')).toBe(false);
});
