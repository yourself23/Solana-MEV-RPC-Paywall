# Solana MEV RPC Paywall

A Vite dashboard and Vercel functions for paid Solana mainnet RPC, Jito telemetry and Jupiter quote feeds. Payments are **native SOL**, not USDC. The wrapped SOL mint identifies SOL in Jupiter quotes; payments are system-program lamport transfers, not wrapped token transfers.

> **Protocol compatibility:** This implements a custom `native-sol-finalized-v1` scheme using x402-v2-style HTTP envelopes. It is **not** the standard x402 Solana `exact` scheme: the latter requires a signed SPL-token transaction and a fee sponsor. Standard x402 clients will not pay this service without a custom adapter. The client submits an already-finalized transaction signature; the service never signs or submits payments.

## Discovery

- Production base URL: `https://solana-mev-rpc-paywall.vercel.app`
- Discovery manifest: `GET https://solana-mev-rpc-paywall.vercel.app/api/sales`
- Static discovery: `/.well-known/x402.json`, `/openapi.json`, and `/llms.txt` at the production base URL
- Remote MCP endpoint: `POST https://solana-mev-rpc-paywall.vercel.app/api/mcp`
- Network: Solana mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
- Settlement: native SOL; wrapped SOL mint for quotes: `So11111111111111111111111111111111111111112`

The hostname is the intended deployment address; deployment and endpoint availability must be verified by the operator. Public indexing also requires the repository and endpoints to be accessible to the relevant registry; adding metadata alone does not guarantee inclusion.

## Deployment

1. Import the repository into Vercel using Node.js 22. Set `TREASURY_ADDRESS`, `SOLANA_RPC_URL`, `JUPITER_API_KEY`, `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Vercel production environment settings. The treasury must be a mainnet recipient public key; RPC and Redis URLs must be HTTPS. RPC must support finalized `getTransaction` with `jsonParsed`, transaction version 0, and historical transaction lookup.
2. Set GitHub Actions repository secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`. A push to `main` runs checks and deploys a prebuilt production artifact. Vercel environment values and GitHub Actions secrets are configured separately.
3. Use a dedicated, durable Upstash database with **no key eviction or expiry** for `payment:*` and `credit:*` keys. Replay markers are permanent. Flushing, expiring, restoring an old backup, or evicting them permits previously used payments to be replayed. Plan capacity and backups accordingly.
4. Confirm `/api/sales` reports `configured: true`, then validate actual RPC, Jupiter, Redis, Jito, routing and a small real mainnet payment before exposing the service. Configuration presence is not a health check. Restrict Vercel deployment access until verified.

`npm ci`, `npm run typecheck`, `npm test` and `npm run build` run the local checks. `npm run dev` serves only the dashboard; use the Vercel CLI's `vercel dev` with configured environment variables to run functions locally. Never commit `.env` files.

The required `uuid` 9.x pin has a [moderate advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq) affecting buffer arguments in its v3/v5/v6 APIs. This scaffold does not import or call `uuid`; the pin remains solely for compatibility. Reassess the pin before using the package or changing that constraint.

## Pricing and routes

| Route | Price |
| --- | --- |
| `GET /api/sales` | Free |
| `POST /api/mcp` initialize and tools/list | Free |
| `POST /api/rpc/relay` | 0.005 SOL |
| `POST /api/mev/jito-tip` or `/api/mev/block-prep` | 0.005 SOL |
| `GET /api/arb/spreads?mintA=...` | 0.05 SOL |
| `GET /api/arb/triangular?mintA=...&mintB=...` | 0.05 SOL |
| `POST /api/credits/mint` | 0.05 SOL for 50 calls |
| `POST /api/mcp` tools/call | Corresponding tool price |

The credit bundle costs 0.05 SOL for 50 calls. `tools/list` is free. The server currently exposes four MCP tools:

| Tool | Purpose | Price |
| --- | --- | --- |
| `rpc-relay` | Forward an allowed Solana JSON-RPC request | 0.005 SOL |
| `jito-tip-oracle` | Jito tip floor and recent priority fee estimate | 0.005 SOL |
| `cross-dex-arb-scanner` | Cross-DEX spreads and triangular quotes | 0.05 SOL |
| `block-prep-bundle` | Blockhash, block height, slot and priority fee | 0.005 SOL |

`amount` is an optional positive integer string in lamports (default `100000000`). `mintA` and `mintB` are caller-supplied intermediate SPL token mint public keys and must differ from each other and wrapped SOL. Intermediate tokens are used only for quotes, not settlement. Spreads compare single-DEX SOL-to-token quotes for Raydium, Orca Whirlpool and Meteora DLMM. The triangular feed requests one sequential Raydium → Orca Whirlpool → Meteora DLMM quote path. Quotes are indicative, not executable profit: latency, slippage, liquidity, fees, priority fees and transaction costs are not accounted for. A missing quote from any venue fails the request.

RPC relay accepts a single JSON-RPC 2.0 request and an allowlist of methods in `api/_lib/engines.ts`, including `sendTransaction`; batches and arbitrary methods are rejected. The upstream RPC's genesis hash is checked against mainnet before use. Priority fee is the median of recent samples in micro-lamports per compute unit; Jito tip values are supplied by Jito in SOL.

## Paying

Use HTTPS throughout. The challenge secret is a bearer secret: **never publish it, put it in a URL, or share it**. Each 402 response contains base64 JSON in `PAYMENT-REQUIRED` and the same JSON in the body. `accepts[0].extra.secret` is a random 32-byte hex secret and `extra.memo` is `x402:` followed by the SHA-256 hex digest of that secret. Send **one** system-program SOL transfer of at least the quoted lamports to `payTo` and include the exact memo in the same transaction. The transfer and memo can be top-level or inner instructions. The client pays transaction fees.

For example, with Solana CLI configured for mainnet and a funded signer, `jq`, `base64`, and `curl`:

```sh
BASE_URL=https://solana-mev-rpc-paywall.vercel.app

# 1. Discover endpoints and current prices.
curl -sS "$BASE_URL/api/sales"

# 2. Request an HTTP 402 challenge. Keep the response secret.
RESULT=$(curl -sS -w '\n%{http_code}' -X POST "$BASE_URL/api/mev/block-prep")
HTTP_STATUS=${RESULT##*$'\n'}
CHALLENGE=${RESULT%$'\n'*}
printf 'HTTP status: %s\n' "$HTTP_STATUS"
if [ "$HTTP_STATUS" != 402 ]; then printf '%s\n' "$CHALLENGE"; exit 1; fi
PAY_TO=$(printf '%s' "$CHALLENGE" | jq -r '.accepts[0].payTo')
MEMO=$(printf '%s' "$CHALLENGE" | jq -r '.accepts[0].extra.memo')
PAYMENT_SECRET=$(printf '%s' "$CHALLENGE" | jq -r '.accepts[0].extra.secret')
printf '%s\n' "$CHALLENGE" | jq '{x402Version, error, accepts: [.accepts[] | {scheme, network, amount, payTo}]}'

# 3. Verify the 0.005 SOL price and recipient, pay, then retry with X-PAYMENT.
TX_SIGNATURE=$(solana transfer "$PAY_TO" 0.005 --with-memo "$MEMO")
solana confirm --commitment finalized "$TX_SIGNATURE"
PAYMENT=$(jq -cn --arg signature "$TX_SIGNATURE" --arg secret "$PAYMENT_SECRET" \
  '{signature:$signature,secret:$secret}' | base64 | tr -d '\n')
curl -sS -X POST "$BASE_URL/api/mev/block-prep" -H "X-PAYMENT: $PAYMENT"
```

The final request retries the original call with the payment proof; it does not permit replaying a redeemed signature.

`X-PAYMENT` is an alias for `PAYMENT-SIGNATURE`. The header is base64-encoded JSON containing `signature` and `secret`; it may alternatively wrap them in `payload`. For POST JSON requests, `{ "payment": { "signature": "...", "secret": "..." } }` or top-level `signature` and `paymentSecret` are accepted. For JSON-RPC requests add `payment` alongside `jsonrpc`, `id`, and `method`. `GET` feeds use headers.

Only successful finalized transactions with exactly one qualifying native transfer and the matching memo are accepted. A payment signature can be redeemed once across all routes, atomically in Redis. A pending or invalid payment returns 422; retry the **same signature and secret** after finalization. A redeemed payment returns 409. Redis or RPC failure fails closed. Payments and credit deductions occur **before** the engine executes; upstream failures or a lost response do not automatically refund calls. Do not retry a consumed payment on a different request.

The mint endpoint returns `{ "key": "...", "calls": 50 }`. Store the bearer key securely and send it in `X-API-CREDIT-KEY` on subsequent paid calls. One credit buys one call at **either** price tier, including the 0.05 SOL feeds; this is a substantial discount and must be acceptable to the operator. Minting does not accept existing credits. Retrying the same mint payment and secret returns the same key and its remaining balance without replenishing it. Credits are charged even if an upstream call later fails. Protect the Redis database and avoid logging bearer credentials.

## MCP

The stateless JSON-RPC endpoint supports `initialize`, `notifications/initialized`, `tools/list` and `tools/call` over POST. Tools are `rpc-relay`, `jito-tip-oracle`, `cross-dex-arb-scanner`, and `block-prep-bundle`. For Claude Desktop, Cursor or Windsurf versions that support remote HTTP MCP servers, add the following to the client's MCP configuration (for example `mcp_config.json`; the path and supported transport vary by client):

```json
{
  "mcpServers": {
    "solana-paywall": {
      "url": "https://solana-mev-rpc-paywall.vercel.app/api/mcp"
    }
  }
}
```

For stdio clients, build `docker build -t solana-mev-mcp .` and run `docker run --rm -i -e MCP_CREDIT_KEY solana-mev-mcp` with a prepaid key in the host environment. Discovery works without a key; tool calls require one and are forwarded to the production MCP endpoint. Each call consumes a credit before execution, and network failures may leave its outcome unknown. The stdio transport does not support direct payment challenges.

Clients must support HTTP 402 and the custom payment adapter, or supply a prepaid `X-API-CREDIT-KEY` header. For example, discovery:

```sh
curl "$BASE_URL/api/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`rpc-relay` accepts `{ "request": { "jsonrpc": "2.0", "id": 1, "method": "getSlot" } }`; the arbitrage tool accepts `{ "feed": "spreads", "mintA": "<mint>" }`. The service provides no SSE stream or session state.

## Operational and security limits

Rate limiting is a Redis-backed sliding window of 60 requests per minute per IP, using Vercel's forwarded IP. Free discovery endpoints are not rate limited. Restrict access or add edge-level protection when abuse or denial-of-service is a concern. Trust only your own HTTPS RPC and Redis providers; the verifier relies on the RPC's finalized transaction data. Never use browser-accessible secrets or a treasury private key on the server. Keep dependencies patched and arrange independent security review, monitoring, incident response, and payment reconciliation before production use; the included tests use mocked providers and do not certify live integrations.
