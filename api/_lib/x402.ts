import { createHash, randomBytes } from 'node:crypto';
import { assertMainnet, NETWORK, NATIVE_MINT, rpc } from './engines.js';
import { header, HttpError, object, requiredEnv, text, type Request, type Response } from './http.js';
import { mintCredit, rateLimit, set, takeCredit } from './redis.js';

export const MICRO = 5_000_000;
export const HIGH = 50_000_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const SECRET = /^[a-f0-9]{64}$/;

export function challenge(req: Request, res: Response, price: number): void {
  const secret = randomBytes(32).toString('hex');
  const body = {
    x402Version: 2,
    error: 'Payment required',
    resource: { url: req.url ?? '/', description: 'Native SOL pay-per-call', mimeType: 'application/json' },
    accepts: [{
      scheme: 'native-sol-finalized-v1', network: NETWORK, asset: NATIVE_MINT,
      amount: String(price), payTo: requiredEnv('TREASURY_ADDRESS'), maxTimeoutSeconds: 0,
      extra: { paymentFlow: 'upfront', memo: `x402:${hash(secret)}`, secret }
    }]
  };
  res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(body)).toString('base64'));
  res.status(402).json(body);
}

function payment(req: Request): { signature: string; secret: string } | undefined {
  const raw = header(req, 'payment-signature') ?? header(req, 'x-payment');
  let value: unknown;
  if (raw) {
    try { value = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch { throw new HttpError(400, 'Payment header must be base64-encoded JSON'); }
  } else if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    const body = req.body as Record<string, unknown>;
    value = body.payment ?? (body.signature ? { signature: body.signature, secret: body.paymentSecret } : undefined);
  }
  if (value === undefined) return undefined;
  const data = object(value);
  const payload = data.payload === undefined ? data : object(data.payload);
  const signature = text(payload.signature, 'payment signature');
  const secret = text(payload.secret, 'payment secret');
  if (!SIGNATURE.test(signature) || !SECRET.test(secret)) throw new HttpError(400, 'Invalid payment signature or secret');
  return { signature, secret };
}

export function verifyTransaction(transaction: unknown, treasury: string, price: number, secret: string): boolean {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(transaction) || !record(transaction.meta) || transaction.meta.err !== null ||
      !record(transaction.transaction) || !record(transaction.transaction.message) ||
      !Array.isArray(transaction.transaction.message.instructions)) return false;
  const meta = transaction.meta;
  const inner = Array.isArray(meta.innerInstructions) ? meta.innerInstructions.flatMap(group => {
    if (!record(group)) return [];
    return Array.isArray(group.instructions) ? group.instructions : [];
  }) : [];
  const instructions = [...transaction.transaction.message.instructions, ...inner].filter(record);
  const memo = `x402:${hash(secret)}`;
  const hasMemo = instructions.some(i => i.program === 'spl-memo' && i.parsed === memo);
  const transfers = instructions.filter(i => {
    if (i.program !== 'system' || !record(i.parsed)) return false;
    const parsed = i.parsed;
    if (parsed.type !== 'transfer' || !record(parsed.info)) return false;
    const info = parsed.info;
    return info.destination === treasury && typeof info.lamports === 'number' &&
      Number.isSafeInteger(info.lamports) && info.lamports >= price;
  });
  return hasMemo && transfers.length === 1;
}

async function verify(p: { signature: string; secret: string }, price: number): Promise<void> {
  const treasury = requiredEnv('TREASURY_ADDRESS');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(treasury)) throw new HttpError(503, 'Invalid treasury address');
  await assertMainnet();
  const tx = await rpc('getTransaction', [p.signature, {
    encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0
  }]);
  if (!verifyTransaction(tx, treasury, price, p.secret)) throw new HttpError(422, 'Payment not finalized or invalid');
}

export async function authorize(req: Request, res: Response, price: number, mint = false): Promise<boolean> {
  const ip = header(req, 'x-vercel-forwarded-for')?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  await rateLimit(ip);
  const credit = header(req, 'x-api-credit-key');
  if (credit && !mint) {
    if (!/^[a-f0-9]{64}$/.test(credit) || !await takeCredit(hash(credit))) throw new HttpError(401, 'Invalid or exhausted credit key');
    return true;
  }
  const p = payment(req);
  if (!p) { challenge(req, res, price); return false; }
  await verify(p, price);
  if (mint) {
    const key = hash(`credit-v1:${p.signature}:${p.secret}`);
    const remaining = await mintCredit(p.signature, hash(key));
    if (remaining === null) throw new HttpError(409, 'Payment already redeemed');
    res.status(200).json({ key, calls: remaining });
    return false;
  }
  if (await set(`payment:${p.signature}`, 'used', { nx: true }) !== 'OK')
    throw new HttpError(409, 'Payment already redeemed');
  return true;
}
