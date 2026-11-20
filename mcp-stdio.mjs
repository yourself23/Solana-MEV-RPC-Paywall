import { createInterface } from 'node:readline';
import tools from './api/_lib/mcp-tools.json' with { type: 'json' };

const endpoint = 'https://solana-mev-rpc-paywall.vercel.app/api/mcp';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const toolError = (text) => ({ isError: true, content: [{ type: 'text', text }] });

async function handle(request) {
  const { id, method, params } = request;
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    const supported = ['2025-03-26', '2024-11-05'];
    const protocolVersion = supported.includes(params?.protocolVersion) ? params.protocolVersion : supported[0];
    reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'solana-paywall', version: '1.0.0' } });
  } else if (method === 'tools/list') {
    reply({ tools });
  } else if (method === 'ping') {
    reply({});
  } else if (method === 'tools/call') {
    if (!params || typeof params !== 'object' || !tools.some((tool) => tool.name === params.name)) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } });
      return;
    }
    const credit = process.env.MCP_CREDIT_KEY;
    if (!credit) {
      reply(toolError('Set MCP_CREDIT_KEY to a prepaid credit key. Obtain one via POST /api/credits/mint; see the payment documentation.'));
      return;
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-credit-key': credit },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        reply(toolError(`Remote MCP request failed with HTTP ${response.status}. A credit may have been consumed; check the service before retrying.`));
        return;
      }
      const body = await response.json();
      if (body.jsonrpc !== '2.0' || body.id !== id || !body.result || !Array.isArray(body.result.content)) {
        reply(toolError('Remote MCP server returned an invalid response. A credit may have been consumed; check the service before retrying.'));
        return;
      }
      reply(body.result);
    } catch (error) {
      reply(toolError(`Remote MCP request failed (${error instanceof Error ? error.name : 'unknown error'}). A credit may have been consumed; check the service before retrying.`));
    }
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
}

input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
      ('id' in request && request.id !== null && typeof request.id !== 'string' && typeof request.id !== 'number')) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  if ('id' in request) void handle(request);
});
