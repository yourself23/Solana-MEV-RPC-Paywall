import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Request, Response as ApiResponse } from '../api/_lib/http';
import { USDC_MINT } from '../api/_lib/x402';
import sales from '../api/sales';
import mcp from '../api/mcp';
import mev from '../api/mev/[action]';
import arb from '../api/arb/[feed]';
import relay from '../api/rpc/relay';
import mint from '../api/credits/mint';

const treasury = '2'.repeat(32);
const secret = 'a'.repeat(64);
const memo = `x402:${createHash('sha256').update(secret).digest('hex')}`;
const signature = '3'.repeat(87);
const mintA = '4'.repeat(32);

function response() {
  const res = {
    code: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.code = code; return this; },
    json(value: unknown) { this.body = value; },
    end() {},
  };
  return res;
}

function request(method: string, query: Record<string, string> = {}, body?: unknown, headers: Record<string, string> = {}) {
  return { method, query, body, headers, url: '/test', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
}

test('all requested routes issue challenges and execute successfully with mocked providers', async () => {
  const oldFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  const redeemed = new Set<string>();
  const methods: string[] = [];
  let tx: unknown;
  Object.assign(process.env, {
    TREASURY_ADDRESS: ` ${treasury} `, SOLANA_RPC_URL: ' https://rpc.example ',
    UPSTASH_REDIS_REST_URL: ' https://redis.example ', UPSTASH_REDIS_REST_TOKEN: ' token ',
    JUPITER_API_KEY: ' jupiter ',
  });
  delete process.env.RESEND_API_KEY;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://redis.example') {
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer token');
      const command = JSON.parse(String(init?.body)) as (string | number)[];
      if (command[0] === 'SET') {
        const key = String(command[1]);
        if (redeemed.has(key)) return Response.json({ result: null });
        redeemed.add(key);
        return Response.json({ result: 'OK' });
      }
      assert.equal(command[0], 'EVAL');
      if (String(command[1]).includes('ZREMRANGEBYSCORE')) return Response.json({ result: 1 });
      if (String(command[1]).includes("redis.call('SET',KEYS[2],50)")) {
        const key = String(command[3]);
        if (redeemed.has(key)) return Response.json({ result: -1 });
        redeemed.add(key);
        return Response.json({ result: 50 });
      }
      throw new Error('Unexpected Redis script');
    }
    if (url === 'https://rpc.example') {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      methods.push(body.method);
      const results: Record<string, unknown> = {
        getGenesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getTransaction: tx, getSlot: 99, getBalance: { value: 10 },
        getRecentPrioritizationFees: [{ prioritizationFee: 5 }],
        getLatestBlockhash: { value: { blockhash: 'abc', lastValidBlockHeight: 100 } },
        sendTransaction: signature,
      };
      if (body.method === 'sendTransaction')
        assert.deepEqual(body.params[1], { encoding: 'base64', skipPreflight: true, preflightCommitment: 'confirmed' });
      assert.ok(body.method in results, body.method);
      return Response.json({ result: results[body.method] });
    }
    if (url.startsWith('https://bundles.jito.wtf/')) return Response.json([{ landed_tips_50th_percentile: 0.001 }]);
    if (url.startsWith('https://api.jup.ag/')) {
      assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'jupiter');
      return Response.json({ outAmount: '1000' });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const rpcBody = { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [treasury] };
  const cases = [
    { handler: mev, req: request('POST', { action: 'jito-tip' }) },
    { handler: mev, req: request('POST', { action: 'block-prep' }) },
    { handler: arb, req: request('GET', { feed: 'spreads', mintA }) },
    { handler: relay, req: request('POST', {}, rpcBody) },
    { handler: mcp, req: request('POST', {}, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jito-tip-oracle' } }) },
    { handler: mint, req: request('POST') },
  ];
  try {
    const free = response();
    await sales(request('GET'), free as unknown as ApiResponse);
    assert.equal(free.code, 200);
    assert.equal((free.body as { treasury: string }).treasury, treasury);
    const discovery = response();
    await mcp(request('POST', {}, { jsonrpc: '2.0', id: 1, method: 'initialize' }), discovery as unknown as ApiResponse);
    assert.equal(discovery.code, 200);
    for (const { handler, req } of cases) {
      const unpaid = response();
      await handler(req, unpaid as unknown as ApiResponse);
      assert.equal(unpaid.code, 402);
      const challenge = unpaid.body as { x402Version: number; accepts: { asset: string; payTo: string }[] };
      assert.equal(challenge.x402Version, 2);
      assert.equal(challenge.accepts.length, 2);
      assert.equal(challenge.accepts[1].asset, USDC_MINT);
      assert.ok((challenge.accepts[0].payTo === '2Z6xwB633pMFj3iMj1pUz2ikGrVGGTun7AY3qZDNZip2' && challenge.accepts[1].payTo === treasury));
      assert.deepEqual(JSON.parse(Buffer.from(unpaid.headers['PAYMENT-REQUIRED'], 'base64').toString()), challenge);
      assert.equal((challenge.accepts[1] as { amount?: string }).amount, handler === arb || handler === mint ? '5000000' : '500000');

      const amount = handler === arb || handler === mint ? 50_000_000 : 5_000_000;
      tx = {
        meta: { err: null, preBalances: [1], postBalances: [amount + 1], preTokenBalances: [], postTokenBalances: [] },
        transaction: { message: { accountKeys: [treasury], instructions: [
          { program: 'system', parsed: { type: 'transfer', info: { destination: treasury, lamports: amount } } },
          { program: 'spl-memo', parsed: memo },
        ] } },
      };
      redeemed.clear();
      req.headers['payment-signature'] = Buffer.from(JSON.stringify({ payload: { signature, secret } })).toString('base64');
      const paid = response();
      await handler(req, paid as unknown as ApiResponse);
      assert.equal(paid.code, 200);
      assert.ok(paid.body);
    }
    assert.ok(methods.includes('getRecentPrioritizationFees'));
  } finally { globalThis.fetch = oldFetch; process.env = oldEnv; }
});

test('encoded USDC transaction is broadcast and verified, with replay rejected', async () => {
  const oldFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  const calls: string[] = [];
  let used = false;
  Object.assign(process.env, { TREASURY_ADDRESS: treasury, SOLANA_RPC_URL: 'https://rpc.example',
    UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'test' });
  delete process.env.RESEND_API_KEY;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input) === 'https://redis.example') {
      if (body[0] === 'EVAL') return Response.json({ result: 1 });
      if (body[0] === 'SET') {
        const result = used ? null : 'OK';
        used = true;
        return Response.json({ result });
      }
      throw new Error('Unexpected Redis command');
    }
    calls.push(body.method);
    if (body.method === 'getGenesisHash') return Response.json({ result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' });
    if (body.method === 'sendTransaction') {
      assert.deepEqual(body.params[1], { encoding: 'base64', skipPreflight: true, preflightCommitment: 'confirmed' });
      return Response.json({ result: signature });
    }
    if (body.method === 'getTransaction') return Response.json({ result: {
      meta: { err: null, preBalances: [1], postBalances: [1],
        preTokenBalances: [{ mint: USDC_MINT, owner: treasury, uiTokenAmount: { amount: '10' } }],
        postTokenBalances: [{ mint: USDC_MINT, owner: treasury, uiTokenAmount: { amount: '500010' } }] },
      transaction: { message: { accountKeys: [treasury], instructions: [{ program: 'spl-memo', parsed: memo }] } },
    } });
    if (body.method === 'getRecentPrioritizationFees') return Response.json({ result: [{ prioritizationFee: 1 }] });
    throw new Error(`Unexpected RPC ${body.method}`);
  };
  const rawTransaction = Buffer.alloc(100, 1).toString('base64');
  const req = request('POST', { action: 'jito-tip' }, undefined, {
    'x-payment': Buffer.from(JSON.stringify({ payload: { transaction: rawTransaction, secret } })).toString('base64'),
  });
  try {
    // Stub Jito separately without changing the Solana or Redis mock.
    const providerFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => String(input).startsWith('https://bundles.jito.wtf/')
      ? Response.json([{ tip: 1 }]) : providerFetch(input, init);
    const result = response();
    await mev(req, result as unknown as ApiResponse);
    assert.equal(result.code, 200);
    assert.ok(calls.indexOf('sendTransaction') > calls.indexOf('getGenesisHash'));
    req.headers['payment-signature'] = req.headers['x-payment'];
    delete req.headers['x-payment'];
    const rebroadcast = response();
    await mev(req, rebroadcast as unknown as ApiResponse);
    assert.equal(rebroadcast.code, 409);
    delete req.headers['payment-signature'];
    req.headers['x-payment'] = Buffer.from(JSON.stringify({ signature, secret })).toString('base64');
    const replay = response();
    await mev(req, replay as unknown as ApiResponse);
    assert.equal(replay.code, 409);

    req.headers['payment-signature'] = Buffer.from(JSON.stringify({ payload: { transaction: rawTransaction } })).toString('base64');
    delete req.headers['x-payment'];
    const invalid = response();
    const broadcasts = calls.filter(method => method === 'sendTransaction').length;
    await mev(req, invalid as unknown as ApiResponse);
    assert.equal(invalid.code, 400);
    assert.equal(calls.filter(method => method === 'sendTransaction').length, broadcasts);
  } finally { globalThis.fetch = oldFetch; process.env = oldEnv; }
});

test('free routes remain available when optional configuration is missing', async () => {
  const oldEnv = { ...process.env };
  try {
    for (const key of ['TREASURY_ADDRESS', 'SOLANA_RPC_URL', 'JUPITER_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'RESEND_API_KEY', 'ALERT_EMAIL']) delete process.env[key];
    const status = response();
    await sales(request('GET'), status as unknown as ApiResponse);
    assert.equal(status.code, 200);
    assert.equal((status.body as { configured: boolean }).configured, false);
    const discovery = response();
    await mcp(request('POST', {}, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), discovery as unknown as ApiResponse);
    assert.equal(discovery.code, 200);
    const gated = response();
    await mev(request('POST', { action: 'jito-tip' }), gated as unknown as ApiResponse);
    assert.equal(gated.code, 503);
  } finally { process.env = oldEnv; }
});
