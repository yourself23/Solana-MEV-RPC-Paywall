import { NATIVE_MINT, NETWORK } from './_lib/engines';
import { handler } from './_lib/http';
import { HIGH, MICRO } from './_lib/x402';

export default handler('GET', async (_req, res) => {
  const names = ['TREASURY_ADDRESS', 'SOLANA_RPC_URL', 'JUPITER_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
  res.status(200).json({
    configured: names.every(name => Boolean(process.env[name])),
    network: NETWORK, asset: NATIVE_MINT, settlement: 'native SOL',
    treasury: process.env.TREASURY_ADDRESS || null,
    tiers: { micro: { lamports: MICRO, sol: 0.005 }, highThroughput: { lamports: HIGH, sol: 0.05 } },
    endpoints: [
      { method: 'POST', path: '/api/rpc/relay', lamports: MICRO },
      { method: 'GET', path: '/api/arb/spreads', lamports: HIGH },
      { method: 'GET', path: '/api/arb/triangular', lamports: HIGH },
      { method: 'POST', path: '/api/mev/jito-tip', lamports: MICRO },
      { method: 'POST', path: '/api/mev/block-prep', lamports: MICRO },
      { method: 'POST', path: '/api/credits/mint', lamports: HIGH },
      { method: 'POST', path: '/api/mcp', lamports: 'tool-dependent' }
    ]
  });
});
