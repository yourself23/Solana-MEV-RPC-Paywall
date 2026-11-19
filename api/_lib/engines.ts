import { fetchJson, HttpError, object, requiredEnv, text } from './http';

export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
export const NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const url = requiredEnv('SOLANA_RPC_URL');
  if (new URL(url).protocol !== 'https:') throw new HttpError(503, 'Solana RPC URL must use HTTPS');
  const result = object(await fetchJson(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  }));
  if (result.error) throw new HttpError(502, `Solana RPC ${method} failed`);
  if (!('result' in result)) throw new HttpError(502, 'Solana RPC returned an invalid response');
  return result.result;
}

export async function assertMainnet(): Promise<void> {
  if (await rpc('getGenesisHash') !== GENESIS) throw new HttpError(503, 'Solana RPC is not mainnet');
}

const METHODS = new Set([
  'getAccountInfo', 'getBalance', 'getBlock', 'getBlockHeight', 'getBlockTime',
  'getFeeForMessage', 'getHealth', 'getLatestBlockhash', 'getMultipleAccounts',
  'getRecentPrioritizationFees', 'getSignatureStatuses', 'getSlot', 'getTokenAccountBalance',
  'getTransaction', 'isBlockhashValid', 'sendTransaction', 'simulateTransaction'
]);

export function relayArguments(value: unknown): { method: string; params: unknown[]; id: unknown } {
  const body = object(value);
  if (body.jsonrpc !== '2.0' || !('id' in body) || !['string', 'number'].includes(typeof body.id))
    throw new HttpError(400, 'A JSON-RPC 2.0 request with an id is required');
  const method = text(body.method, 'method');
  if (!METHODS.has(method)) throw new HttpError(400, 'RPC method is not allowed');
  if (body.params !== undefined && !Array.isArray(body.params)) throw new HttpError(400, 'params must be an array');
  if (JSON.stringify(body).length > 100000) throw new HttpError(413, 'RPC request too large');
  return { method, params: (body.params ?? []) as unknown[], id: body.id };
}

export async function relay(value: unknown): Promise<unknown> {
  const { method, params, id } = relayArguments(value);
  await assertMainnet();
  return { jsonrpc: '2.0', id, result: await rpc(method, params) };
}

async function priorityFee(): Promise<number> {
  const data = await rpc('getRecentPrioritizationFees');
  if (!Array.isArray(data)) throw new HttpError(502, 'Invalid prioritization fee response');
  const fees = data.map(item => object(item).prioritizationFee)
    .filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
    .sort((a, b) => a - b);
  if (!fees.length) throw new HttpError(502, 'No prioritization fee samples');
  return fees[Math.floor(fees.length / 2)];
}

export async function blockPrep(): Promise<unknown> {
  await assertMainnet();
  const [block, slot, fee] = await Promise.all([
    rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]),
    rpc('getSlot', [{ commitment: 'confirmed' }]), priorityFee()
  ]);
  const value = object(object(block).value);
  return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight, slot, computeUnitPriceMicroLamports: fee };
}

export async function jitoTip(): Promise<unknown> {
  await assertMainnet();
  const [tips, fee] = await Promise.all([
    fetchJson('https://bundles.jito.wtf/api/v1/bundles/tip_floor'),
    priorityFee()
  ]);
  if (!Array.isArray(tips) || !tips.length) throw new HttpError(502, 'Jito returned no tip samples');
  return { tipFloor: object(tips[0]), computeUnitPriceMicroLamports: fee };
}

function mint(value: unknown, name: string): string {
  const result = text(value, name);
  if (!BASE58.test(result) || result === NATIVE_MINT) throw new HttpError(400, `${name} must be a non-WSOL Solana mint`);
  return result;
}

function amount(value: unknown): string {
  const result = value === undefined ? '100000000' : text(value, 'amount');
  if (!/^[1-9]\d{0,14}$/.test(result)) throw new HttpError(400, 'amount must be a positive integer string');
  return result;
}

export function feedArguments(feed: string, input: unknown): { mintA: string; mintB?: string; amount: string } {
  const args = object(input);
  if (feed !== 'spreads' && feed !== 'triangular') throw new HttpError(404, 'Unknown arbitrage feed');
  const mintA = mint(args.mintA, 'mintA');
  const mintB = feed === 'triangular' ? mint(args.mintB, 'mintB') : undefined;
  if (mintA === mintB) throw new HttpError(400, 'Intermediate mints must differ');
  return { mintA, mintB, amount: amount(args.amount) };
}

async function quote(inputMint: string, outputMint: string, inputAmount: string, dex?: string): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({ inputMint, outputMint, amount: inputAmount, swapMode: 'ExactIn' });
  if (dex) query.set('dexes', dex);
  const data = object(await fetchJson(`https://api.jup.ag/swap/v1/quote?${query}`, {
    headers: { 'x-api-key': requiredEnv('JUPITER_API_KEY') }
  }));
  if (typeof data.outAmount !== 'string' || !/^[1-9]\d*$/.test(data.outAmount))
    throw new HttpError(502, 'Jupiter returned an invalid quote');
  return data;
}

export async function arb(feed: string, input: unknown): Promise<unknown> {
  const args = feedArguments(feed, input);
  await assertMainnet();
  if (feed === 'spreads') {
    const dexes = ['Raydium', 'Orca Whirlpool', 'Meteora DLMM'];
    const quotes = await Promise.all(dexes.map(async dex => ({ dex, quote: await quote(NATIVE_MINT, args.mintA, args.amount, dex) })));
    const sorted = [...quotes].sort((a, b) => BigInt(a.quote.outAmount as string) > BigInt(b.quote.outAmount as string) ? 1 : -1);
    const low = BigInt(sorted[0].quote.outAmount as string);
    const high = BigInt(sorted[2].quote.outAmount as string);
    return { inputAmountLamports: args.amount, outputMint: args.mintA, quotes, spreadBps: Number((high - low) * 10000n / low) };
  }
  const first = await quote(NATIVE_MINT, args.mintA, args.amount, 'Raydium');
  const second = await quote(args.mintA, args.mintB!, first.outAmount as string, 'Orca Whirlpool');
  const third = await quote(args.mintB!, NATIVE_MINT, second.outAmount as string, 'Meteora DLMM');
  return { inputAmountLamports: args.amount, outputAmountLamports: third.outAmount,
    grossDifferenceLamports: (BigInt(third.outAmount as string) - BigInt(args.amount)).toString(), quotes: [first, second, third] };
}
