import { describe, expect, it, vi, afterEach } from 'vitest';
import { ApiRequestError, parseApiPayload, request } from '../src/utils/api';

describe('API error compatibility', () => {
  afterEach(() => vi.unstubAllGlobals());
  for (const payload of [{ error: { message: '中文错误' } }, { message: '中文错误' },
    { statusMessage: '中文错误' }, { statusText: '中文错误' }]) {
    it(`preserves old message ${JSON.stringify(payload)}`, () => {
      expect(() => parseApiPayload(400, false, JSON.stringify(payload))).toThrow('中文错误');
    });
  }
  it('keeps status, code, meta, hidden errorId and displays Chinese plus code', () => {
    for (const nested of [false, true]) {
      const fields = { message: '档案数据库当前繁忙，请稍后重试', code: 'DATABASE_UNAVAILABLE', errorId: 'future-id' };
      try {
        parseApiPayload(503, false, JSON.stringify({ ...(nested ? { error: fields } : fields), meta: { retryable: true } }));
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiRequestError);
        expect(error).toMatchObject({ status: 503, code: fields.code, errorId: 'future-id', meta: { retryable: true } });
        expect((error as Error).message).toBe(`${fields.message}\n错误码：DATABASE_UNAVAILABLE`);
        expect((error as Error).message).not.toContain('future-id');
      }
    }
  });
  it('does not guess a domain from status and accepts old success/fail', () => {
    expect(() => parseApiPayload(503, false, '{"message":"原有提示"}')).toThrow(/^原有提示$/);
    expect(() => parseApiPayload(200, true, '{"ok":false,"error":{"message":"业务失败"}}')).toThrow('业务失败');
    expect(parseApiPayload(200, true, '{"ok":true,"data":42}')).toBe(42);
  });
  it('handles HTML, invalid JSON and null without technical details', () => {
    for (const text of ['<html>secret proxy</html>', 'invalid', 'null']) {
      expect(() => parseApiPayload(502, false, text)).toThrow('服务器返回了无法识别的数据，请稍后重试');
    }
  });
  it('network failures do not expose raw exception details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('secret hostname')));
    await expect(request('test')).rejects.toThrow(/^无法连接服务器，请检查网络与应用服务状态后重试$/);
  });
});
