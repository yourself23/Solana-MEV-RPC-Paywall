import { arb, blockPrep, feedArguments, jitoTip, relay, relayArguments } from './_lib/engines.js';
import { handler, HttpError, object, text } from './_lib/http.js';
import { authorize, HIGH, MICRO } from './_lib/x402.js';

const tools = [
  { name: 'rpc-relay', description: 'Relay an allowed Solana JSON-RPC call (0.005 SOL)',
    inputSchema: { type: 'object', properties: { request: { type: 'object' } }, required: ['request'] } },
  { name: 'jito-tip-oracle', description: 'Jito tip floor and priority fee (0.005 SOL)',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'cross-dex-arb-scanner', description: 'Jupiter spreads or triangular quotes (0.05 SOL)',
    inputSchema: { type: 'object', properties: {
      feed: { type: 'string', enum: ['spreads', 'triangular'] }, mintA: { type: 'string' },
      mintB: { type: 'string' }, amount: { type: 'string' }
    }, required: ['feed', 'mintA'] } },
  { name: 'block-prep-bundle', description: 'Blockhash, slot and priority fee (0.005 SOL)',
    inputSchema: { type: 'object', properties: {} } }
];

export default handler('POST', async (req, res) => {
  const body = object(req.body);
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string')
    throw new HttpError(400, 'Invalid JSON-RPC request');
  if (body.method === 'notifications/initialized') { res.status(202).end(); return; }
  if (typeof body.id !== 'string' && typeof body.id !== 'number' && body.id !== null)
    throw new HttpError(400, 'A JSON-RPC id is required');
  const reply = (result: unknown) => res.status(200).json({ jsonrpc: '2.0', id: body.id, result });
  if (body.method === 'initialize') {
    reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'solana-paywall', version: '1.0.0' } });
    return;
  }
  if (body.method === 'tools/list') { reply({ tools }); return; }
  if (body.method !== 'tools/call') {
    res.status(200).json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  const params = object(body.params);
  const name = text(params.name, 'tool name');
  const args = params.arguments === undefined ? {} : object(params.arguments);
  let execute: () => Promise<unknown>;
  let price = MICRO;
  switch (name) {
    case 'rpc-relay': relayArguments(args.request); execute = () => relay(args.request); break;
    case 'jito-tip-oracle': execute = jitoTip; break;
    case 'block-prep-bundle': execute = blockPrep; break;
    case 'cross-dex-arb-scanner': {
      const feed = text(args.feed, 'feed');
      feedArguments(feed, args);
      price = HIGH;
      execute = () => arb(feed, args);
      break;
    }
    default: throw new HttpError(404, 'Unknown tool');
  }
  if (!await authorize(req, res, price)) return;
  reply({ content: [{ type: 'text', text: JSON.stringify(await execute()) }] });
});
