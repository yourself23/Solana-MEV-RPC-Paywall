import { createHash, randomBytes } from 'node:crypto';
import { assertMainnet, NETWORK, NATIVE_MINT, rpc } from './engines.js';
import { header, HttpError, object, requiredEnv, text, type Request, type Response } from './http.js';
import { mintCredit, rateLimit, set, takeCredit } from './redis.js';
import { notifyPaymentReceived } from './notify.js';

export const MICRO = 5_000_000;
export const HIGH = 50_000_000;
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const SECRET = /^[a-f0-9]{64}$/;

export function challenge(req: Request, res: Response, price: number): void {
  const secret = randomBytes(32).toString('hex');
  const body = {
    x402Version: 2,
    error: 'Payment required',
    resource: { url: req.url ?? '/', description: 'SOL or USDC pay-per-call', mimeType: 'application/json' },
    accepts: [{
      scheme: 'native-sol-finalized-v1', network: NETWORK, asset: NATIVE_MINT,
      amount: String(price), payTo: requiredEnv('TREASURY_ADDRESS'), maxTimeoutSeconds: 0,
      extra: { paymentFlow: 'upfront', memo: `x402:${hash(secret)}`, secret } },
      { scheme: 'usdc-finalized-v1', network: NETWORK, asset: USDC_MINT,
        amount: price >= HIGH ? '5000000' : '500000', payTo: requiredEnv('TREASURY_ADDRESS'), maxTimeoutSeconds: 0,
        extra: { paymentFlow: 'upfront', memo: `x402:${hash(secret)}`, secret } }]
  };
  res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(body)).toString('base64'));
  res.status(402).json(body);
}

async function payment(req: Request): Promise<{ signature: string; secret: string } | undefined> {
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
  const secret = text(payload.secret, 'payment secret');
  if (!SECRET.test(secret)) throw new HttpError(400, 'Invalid payment secret');
  if (payload.transaction !== undefined) {
    const tx = text(payload.transaction, 'payment transaction');
    const bytes = Buffer.from(tx, 'base64');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(tx) || !bytes.length || bytes.length > 1232 || bytes.toString('base64') !== tx)
      throw new HttpError(400, 'Invalid base64 payment transaction');
    await assertMainnet();
    const signature = await rpc('sendTransaction', [tx, { encoding: 'base64', skipPreflight: true, preflightCommitment: 'confirmed' }]);
    if (typeof signature !== 'string' || !SIGNATURE.test(signature)) throw new HttpError(502, 'Solana RPC returned an invalid transaction signature');
    return { signature, secret };
  }
  const signature = text(payload.signature, 'payment signature');
  if (!SIGNATURE.test(signature)) throw new HttpError(400, 'Invalid payment signature');
  return { signature, secret };
}

type Settlement = { amountLamports: number; amountUsdcAtomic: number };

function settlement(transaction: unknown, treasury: string, price: number, secret: string): Settlement | undefined {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(transaction) || !record(transaction.meta) || transaction.meta.err !== null ||
      !record(transaction.transaction) || !record(transaction.transaction.message) ||
      !Array.isArray(transaction.transaction.message.instructions)) return undefined;
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
  if (!hasMemo) return undefined;
  const keys = transaction.transaction.message.accountKeys;
  if (Array.isArray(keys) && Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) {
    const index = keys.findIndex(key => key === treasury || (record(key) && key.pubkey === treasury));
    if (index >= 0) {
      const pre = meta.preBalances[index], post = meta.postBalances[index];
      if (typeof pre === 'number' && typeof post === 'number' && Number.isSafeInteger(pre) && Number.isSafeInteger(post) &&
          post - pre >= price && transfers.length === 1) return { amountLamports: post - pre, amountUsdcAtomic: 0 };
    }
  }
  function tokenTotal(value: unknown): bigint | undefined {
    if (!Array.isArray(value)) return undefined;
    let total = 0n;
    for (const balance of value) {
      if (!record(balance) || balance.mint !== USDC_MINT) continue;
      if (typeof balance.owner !== 'string') return undefined;
      if (balance.owner !== treasury) continue;
      if (!record(balance.uiTokenAmount) || typeof balance.uiTokenAmount.amount !== 'string' || !/^\d+$/.test(balance.uiTokenAmount.amount)) return undefined;
      total += BigInt(balance.uiTokenAmount.amount);
    }
    return total;
  }
  const before = tokenTotal(meta.preTokenBalances), after = tokenTotal(meta.postTokenBalances);
  if (before === undefined || after === undefined || after - before < BigInt(price >= HIGH ? 5_000_000 : 500_000)) return undefined;
  const received = after - before;
  if (received > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return { amountLamports: 0, amountUsdcAtomic: Number(received) };
}

export function verifyTransaction(transaction: unknown, treasury: string, price: number, secret: string): boolean {
  return settlement(transaction, treasury, price, secret) !== undefined;
}

async function verify(p: { signature: string; secret: string }, price: number): Promise<Settlement> {
  const treasury = requiredEnv('TREASURY_ADDRESS');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(treasury)) throw new HttpError(503, 'Invalid treasury address');
  await assertMainnet();
  const tx = await rpc('getTransaction', [p.signature, {
    encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0
  }]);
  const received = settlement(tx, treasury, price, p.secret);
  if (!received) throw new HttpError(422, `Payment not finalized or invalid; retry signature ${p.signature} with the same secret`);
  return received;
}

export async function authorize(req: Request, res: Response, price: number, mint = false): Promise<boolean> {
  const ip = header(req, 'x-vercel-forwarded-for')?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  await rateLimit(ip);
  const credit = header(req, 'x-api-credit-key');
  if (credit && !mint) {
    if (!/^[a-f0-9]{64}$/.test(credit) || !await takeCredit(hash(credit))) throw new HttpError(401, 'Invalid or exhausted credit key');
    return true;
  }
  const p = await payment(req);
  if (!p) { challenge(req, res, price); return false; }
  const received = await verify(p, price);
  if (mint) {
    const key = hash(`credit-v1:${p.signature}:${p.secret}`);
    const remaining = await mintCredit(p.signature, hash(key));
    if (remaining === null) throw new HttpError(409, 'Payment already redeemed');
    await notifyPaymentReceived({ ...received, signature: p.signature, route: '/api/credits/mint (50-call bundle)' });
    res.status(200).json({ key, calls: remaining });
    return false;
  }
  if (await set(`payment:${p.signature}`, 'used', { nx: true }) !== 'OK')
    throw new HttpError(409, 'Payment already redeemed');
  await notifyPaymentReceived({ ...received, signature: p.signature, route: req.url ?? '/api/mcp' });
  return true;
}
