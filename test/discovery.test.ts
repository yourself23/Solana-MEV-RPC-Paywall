import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { HIGH, MICRO } from '../api/_lib/x402';
import { NATIVE_MINT, NETWORK } from '../api/_lib/engines';
import tools from '../api/_lib/mcp-tools.json' with { type: 'json' };

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('discovery files match the deployed routes and payment tiers', () => {
  const manifest = readJson('public/.well-known/x402.json');
  const api = readJson('public/openapi.json');
  const llms = readFileSync('public/llms.txt', 'utf8');
  assert.equal(manifest.baseUrl, 'https://solana-mev-rpc-paywall.vercel.app');
  assert.equal(api.servers[0].url, manifest.baseUrl);
  assert.equal(manifest.payment.network, NETWORK);
  assert.equal(manifest.payment.asset, NATIVE_MINT);
  assert.equal(manifest.payment.scheme, 'native-sol-finalized-v1');
  assert.equal(manifest.tiers.micro.lamports, MICRO);
  assert.equal(manifest.tiers.highThroughput.lamports, HIGH);
  for (const resource of manifest.resources) {
    assert.ok(api.paths[resource.path]?.[resource.method.toLowerCase()], resource.path);
  }
  assert.match(llms, /0\.005 SOL/);
  assert.match(llms, /0\.05 SOL/);
  assert.match(llms, /not the standard x402 exact scheme/);
});

function runStdio(requests: unknown[], credit?: string, preload?: string) {
  const args = preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'mcp-stdio.mjs'] : ['mcp-stdio.mjs'];
  const result = spawnSync(process.execPath, args, {
    input: `${requests.map((request) => typeof request === 'string' ? request : JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8',
    env: { ...process.env, MCP_CREDIT_KEY: credit ?? '' }
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line));
}

test('stdio lists the HTTP tools and handles notifications and errors', () => {
  const responses = runStdio([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rpc-relay' } },
    { jsonrpc: '2.0', id: 4, method: 'unknown' },
    'invalid json'
  ]);
  assert.equal(responses.length, 5);
  assert.equal(responses[0].result.protocolVersion, '2024-11-05');
  assert.deepEqual(responses[1].result.tools, tools);
  assert.equal(responses[2].result.isError, true);
  assert.match(responses[2].result.content[0].text, /MCP_CREDIT_KEY/);
  assert.equal(responses[3].error.code, -32601);
  assert.equal(responses[4].error.code, -32700);
});

test('stdio forwards paid calls with the credit key and surfaces upstream errors', () => {
  const preload = `
    globalThis.fetch = async (url, init) => {
      if (url !== 'https://solana-mev-rpc-paywall.vercel.app/api/mcp' ||
          init.headers['x-api-credit-key'] !== 'test-credit') throw new Error('Bad request');
      const request = JSON.parse(init.body);
      if (request.params.name === 'jito-tip-oracle') return new Response('', { status: 503 });
      return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: request.params.name }] } });
    };
  `;
  const responses = runStdio([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'block-prep-bundle', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'jito-tip-oracle', arguments: {} } }
  ], 'test-credit', preload);
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.get(1).result.content[0].text, 'block-prep-bundle');
  assert.equal(byId.get(2).result.isError, true);
  assert.match(byId.get(2).result.content[0].text, /503/);
});
