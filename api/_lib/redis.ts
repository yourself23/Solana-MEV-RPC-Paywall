import { createHash, randomBytes } from 'node:crypto';
import { fetchJson, HttpError, object, requiredEnv } from './http.js';

export async function redis(...command: (string | number)[]): Promise<unknown> {
  const url = requiredEnv('UPSTASH_REDIS_REST_URL');
  const token = requiredEnv('UPSTASH_REDIS_REST_TOKEN');
  if (new URL(url).protocol !== 'https:') throw new HttpError(503, 'Redis URL must use HTTPS');
  const result = object(await fetchJson(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command)
  }));
  if (result.error) throw new HttpError(503, 'Redis command failed');
  return result.result;
}

export const get = (key: string) => redis('GET', key);
export const set = (key: string, value: string, options: { ex?: number; nx?: boolean } = {}) =>
  redis('SET', key, value, ...(options.ex ? ['EX', options.ex] : []), ...(options.nx ? ['NX'] : []));
export const incr = (key: string) => redis('INCR', key);

const windowScript = `
local now = redis.call('TIME')
local ms = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ms - tonumber(ARGV[1]))
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ms, ms .. ':' .. ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1`;

export async function rateLimit(ip: string, limit = 60, windowMs = 60000): Promise<void> {
  const key = createHash('sha256').update(ip).digest('hex');
  const result = await redis('EVAL', windowScript, 1, `rate:${key}`, windowMs, limit, randomBytes(12).toString('hex'));
  if (result !== 1) throw new HttpError(429, 'Rate limit exceeded');
}

export async function takeCredit(keyHash: string): Promise<boolean> {
  const script = `local n=tonumber(redis.call('GET',KEYS[1]) or '0')
if n <= 0 then return 0 end
redis.call('DECR',KEYS[1]); return 1`;
  return await redis('EVAL', script, 1, `credit:${keyHash}`) === 1;
}

export async function mintCredit(signature: string, keyHash: string): Promise<number | null> {
  const script = `local old=redis.call('GET',KEYS[1])
if old then if old == ARGV[1] then return tonumber(redis.call('GET',KEYS[2]) or '0') else return -1 end end
redis.call('SET',KEYS[1],ARGV[1]); redis.call('SET',KEYS[2],50); return 50`;
  const remaining = await redis('EVAL', script, 2, `payment:${signature}`, `credit:${keyHash}`, keyHash);
  if (typeof remaining !== 'number' || !Number.isInteger(remaining)) throw new HttpError(503, 'Invalid credit response');
  return remaining < 0 ? null : remaining;
}
