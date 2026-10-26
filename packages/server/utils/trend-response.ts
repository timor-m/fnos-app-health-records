import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { getHeader, setHeader, type H3Event } from 'h3';
import { ok } from './api-response';

const compress = promisify(gzip);

export async function trendResponse(event: H3Event, data: unknown) {
  setHeader(event, 'vary', 'Accept-Encoding');
  setHeader(event, 'cache-control', 'private, no-store');
  const encodings = (getHeader(event, 'accept-encoding') || '').toLowerCase().split(',').map(value => value.trim().split(';').map(part => part.trim()));
  const selected = encodings.find(([name]) => name === 'gzip') || encodings.find(([name]) => name === '*');
  const quality = selected?.slice(1).find(part => part.startsWith('q='));
  if (!selected || quality && !(Number(quality.slice(2)) > 0)) return ok(data);
  const body = Buffer.from(JSON.stringify(ok(data)));
  if (body.length < 16384) return ok(data);
  const compressed = await compress(body, {level: 1});
  return new Response(new Uint8Array(compressed), {headers: {
    'content-type': 'application/json; charset=utf-8',
    'content-encoding': 'gzip', 'vary': 'Accept-Encoding', 'cache-control': 'private, no-store'
  }});
}
