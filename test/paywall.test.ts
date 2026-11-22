import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { authorize, challenge, HIGH, MICRO, USDC_MINT, verifyTransaction } from '../api/_lib/x402';
import { feedArguments, NATIVE_MINT, relayArguments } from '../api/_lib/engines';
import { HttpError, type Request, type Response } from '../api/_lib/http';
import mcp from '../api/mcp';
import sales from '../api/sales';

const treasury = '2'.repeat(32);
const signature = '3'.repeat(87);
const secret = 'a'.repeat(64);
const memo = `x402:${createHash('sha256').update(secret).digest('hex')}`;
const transaction = (price = MICRO, marker = memo, err: unknown = null) => ({
  meta: { err, innerInstructions: [], preBalances: [100], postBalances: [100 + price], preTokenBalances: [], postTokenBalances: [] },
  transaction: { message: { accountKeys: [treasury], instructions: [
    { program: 'system', parsed: { type: 'transfer', info: { destination: treasury, lamports: price } } },
    { program: 'spl-memo', parsed: marker }
  ] } }
});

const tokenBalance = (amount: string, owner = treasury, mint = USDC_MINT) =>
  ({ accountIndex: 1, mint, owner, uiTokenAmount: { amount } });

test('USDC verifies received token delta and binds every payment to its secret memo', () => {
  const base = transaction(0);
  const tx = { ...base, meta: { ...base.meta, preTokenBalances: [tokenBalance('10000000')], postTokenBalances: [tokenBalance('10500000')] } };
  assert.equal(verifyTransaction(tx, treasury, MICRO, secret), true);
  assert.equal(verifyTransaction(tx, treasury, HIGH, secret), false);
  assert.equal(verifyTransaction(tx, treasury, MICRO, 'b'.repeat(64)), false);
  tx.meta.postTokenBalances[0] = tokenBalance('15000000');
  assert.equal(verifyTransaction(tx, treasury, HIGH, secret), true);
  tx.meta.postTokenBalances[0] = tokenBalance('10000000');
  assert.equal(verifyTransaction(tx, treasury, MICRO, secret), false);
  tx.meta.postTokenBalances[0] = tokenBalance('20000000', '4'.repeat(32));
  assert.equal(verifyTransaction(tx, treasury, MICRO, secret), false);
  tx.meta.postTokenBalances[0] = tokenBalance('20000000', treasury, 'other');
  assert.equal(verifyTransaction(tx, treasury, MICRO, secret), false);
});

test('requires a successful finalized transaction, matching memo and sufficient native transfer', () => {
  assert.equal(verifyTransaction(transaction(), treasury, MICRO, secret), true);
  assert.equal(verifyTransaction(transaction(MICRO - 1), treasury, MICRO, secret), false);
  assert.equal(verifyTransaction(transaction(MICRO, 'other'), treasury, MICRO, secret), false);
  assert.equal(verifyTransaction(transaction(MICRO, memo, { InstructionError: [0, 'failed'] }), treasury, MICRO, secret), false);
  const noDelta = transaction();
  noDelta.meta.postBalances[0] = noDelta.meta.preBalances[0];
  assert.equal(verifyTransaction(noDelta, treasury, MICRO, secret), false);
  assert.equal(verifyTransaction(transaction(), '4'.repeat(32), MICRO, secret), false);
  assert.equal(verifyTransaction({ meta: null }, treasury, MICRO, secret), false);
  const duplicate = transaction();
  duplicate.transaction.message.instructions.push(duplicate.transaction.message.instructions[0]);
  assert.equal(verifyTransaction(duplicate, treasury, MICRO, secret), false);
});

test('only accepts explicitly allowed single RPC requests and valid feed arguments', () => {
  assert.equal(relayArguments({ jsonrpc: '2.0', id: 1, method: 'getBalance' }).method, 'getBalance');
  assert.throws(() => relayArguments({ jsonrpc: '2.0', id: 1, method: 'requestAirdrop' }), HttpError);
  assert.throws(() => relayArguments([{ jsonrpc: '2.0', id: 1, method: 'getBalance' }]), HttpError);
  assert.throws(() => feedArguments('spreads', { mintA: NATIVE_MINT }), HttpError);
  assert.throws(() => feedArguments('triangular', { mintA: treasury, mintB: treasury }), HttpError);
  assert.equal(feedArguments('spreads', { mintA: treasury }).amount, '100000000');
});

const oldFetch = globalThis.fetch;
const oldEnv = { ...process.env };
after(() => { globalThis.fetch = oldFetch; process.env = oldEnv; });

test('discovery and free MCP listing report the expected endpoints and tools', async () => {
  let result: Record<string, unknown> = {};
  const res = {
    setHeader() {},
    status(code: number) { assert.equal(code, 200); return this; },
    json(value: unknown) { result = value as Record<string, unknown>; }
  } as unknown as Response;
  await sales({ method: 'GET' } as Request, res);
  assert.equal(result.network, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.equal((result.tiers as { micro: { lamports: number } }).micro.lamports, MICRO);
  assert.equal((result.tiers as { highThroughput: { lamports: number } }).highThroughput.lamports, HIGH);
  await mcp({ method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } } as Request, res);
  const tools = (result.result as { tools: { name: string }[] }).tools.map(tool => tool.name);
  assert.deepEqual(tools, ['rpc-relay', 'jito-tip-oracle', 'cross-dex-arb-scanner', 'block-prep-bundle']);
});

test('challenge carries a secret-bound memo in both header and body', () => {
  process.env.TREASURY_ADDRESS = treasury;
  let encoded = '';
  let payload: Record<string, unknown> = {};
  const res = {
    setHeader(name: string, value: string) { assert.equal(name, 'PAYMENT-REQUIRED'); encoded = value; },
    status(code: number) { assert.equal(code, 402); return this; },
    json(value: unknown) { payload = value as Record<string, unknown>; }
  } as unknown as Response;
  challenge({ url: '/api/mev/block-prep' } as Request, res, MICRO);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString()), payload);
  const requirement = (payload.accepts as { amount: string; extra: { memo: string; secret: string } }[])[0];
  const accepts = payload.accepts as { asset: string; payTo: string; extra: { secret: string; memo: string } }[];
  assert.deepEqual(accepts.map(a => a.asset), [NATIVE_MINT, USDC_MINT]);
  assert.ok(accepts.every(a => a.payTo === treasury && a.extra.secret === requirement.extra.secret && a.extra.memo === requirement.extra.memo));
  assert.equal(requirement.amount, String(MICRO));
  assert.equal(requirement.extra.memo, `x402:${createHash('sha256').update(requirement.extra.secret).digest('hex')}`);
});

test('payment redemption and prepaid credits are atomic and cannot be reset by a retry', async () => {
  Object.assign(process.env, {
    TREASURY_ADDRESS: treasury, SOLANA_RPC_URL: 'https://rpc.example',
    UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'test'
  });
  const state = new Map<string, string>();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://rpc.example') {
      const request = JSON.parse(String(init?.body)) as { method: string };
      return Response.json({ result: request.method === 'getGenesisHash'
        ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' : transaction(HIGH) });
    }
    assert.equal(url, 'https://redis.example');
    const command = JSON.parse(String(init?.body)) as (string | number)[];
    let result: unknown;
    if (command[0] === 'SET') {
      const key = String(command[1]);
      if (state.has(key)) result = null;
      else { state.set(key, String(command[2])); result = 'OK'; }
    } else {
      assert.equal(command[0], 'EVAL');
      const script = String(command[1]);
      const key = String(command[3]);
      if (script.includes("ZREMRANGEBYSCORE")) result = 1;
      else if (script.includes("redis.call('DECR'")) {
        const n = Number(state.get(key) ?? 0);
        result = n > 0 ? 1 : 0;
        if (n > 0) state.set(key, String(n - 1));
      } else {
        const creditKey = String(command[4]);
        const value = String(command[5]);
        if (state.has(key)) result = state.get(key) === value ? Number(state.get(creditKey) ?? 0) : -1;
        else { state.set(key, value); state.set(creditKey, '50'); result = 50; }
      }
    }
    return Response.json({ result });
  };
  const request = (sig: string, credit?: string) => ({
    headers: credit ? { 'x-api-credit-key': credit } : {
      'payment-signature': Buffer.from(JSON.stringify({ signature: sig, secret })).toString('base64')
    }, socket: { remoteAddress: '127.0.0.1' }, query: {}
  }) as unknown as Request;
  let output: { key: string; calls: number } | undefined;
  const response = {
    status() { return this; },
    json(value: unknown) { output = value as { key: string; calls: number }; }
  } as unknown as Response;
  const req = request(signature);
  assert.equal(await authorize(req, response, HIGH, true), false);
  assert.equal(output?.calls, 50);
  const key = output!.key;
  assert.equal(await authorize(request('', key), response, MICRO), true);
  assert.equal(await authorize(req, response, HIGH, true), false);
  assert.equal(output?.calls, 49);
  assert.equal(state.get(`credit:${createHash('sha256').update(key).digest('hex')}`), '49');
  await assert.rejects(() => authorize(req, response, HIGH), (e: unknown) => e instanceof HttpError && e.status === 409);

  const newSignature = '4'.repeat(87);
  const results = await Promise.allSettled([
    authorize(request(newSignature), response, MICRO),
    authorize(request(newSignature), response, MICRO)
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});
