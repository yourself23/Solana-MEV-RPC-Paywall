import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing app element');
app.innerHTML = `
  <main>
    <header><span class="brand">◈ SOL / RPC PAYWALL</span><span class="badge" id="status">● CHECKING</span></header>
    <section class="hero">
      <p class="eyebrow">MAINNET · NATIVE SOL · SERVERLESS</p>
      <h1>Signal for<br><em>onchain speed.</em></h1>
      <p class="intro">High-frequency RPC relaying, Jito telemetry and cross-DEX quote feeds. Pay per request, no subscription required.</p>
      <div class="meta"><span>NETWORK <strong>solana:5eykt4Us...qKqZKvdp</strong></span><span>SETTLEMENT <strong>Native SOL</strong></span></div>
    </section>
    <section>
      <div class="section-title"><span>01 / ENDPOINTS</span><span>PRICE PER CALL</span></div>
      <div class="table-wrap"><table><thead><tr><th>METHOD</th><th>ENDPOINT</th><th>DESCRIPTION</th><th>PRICE</th></tr></thead><tbody id="endpoints"><tr><td colspan="4">Loading discovery…</td></tr></tbody></table></div>
    </section>
    <section>
      <div class="section-title"><span>02 / QUICK START</span><span>HTTP 402</span></div>
      <p class="copy">Request a challenge, then submit a finalized SOL or USDC transfer with its memo and secret. This is a custom x402-style scheme, not standard x402 Solana <code>exact</code>.</p>
      <pre><code>curl -i -X POST "$BASE_URL/api/mev/block-prep"

# PAYMENT-REQUIRED is base64 JSON. Transfer the stated
# lamports and include extra.memo in the same transaction.
# After finalization, send the signature and extra.secret:
PAYMENT=$(printf '{"signature":"%s","secret":"%s"}' \\
  "$TX_SIGNATURE" "$PAYMENT_SECRET" | base64 | tr -d '\\n')
curl -X POST "$BASE_URL/api/mev/block-prep" \\
  -H "PAYMENT-SIGNATURE: $PAYMENT"</code></pre>
    </section>
    <section>
      <div class="section-title"><span>03 / MODEL CONTEXT PROTOCOL</span><span>JSON-RPC 2.0</span></div>
      <p class="copy">Discover tools for free. Tool calls use the same payment headers; clients must support this custom payment scheme.</p>
      <pre><code>{"mcpServers":{"solana-paywall":{"url":"https://your-deployment.example/api/mcp"}}}</code></pre>
      <pre><code>curl "$BASE_URL/api/mcp" -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</code></pre>
    </section>
    <footer><span>◈ SOL / RPC PAYWALL</span><span id="detail">DISCOVERY UNAVAILABLE</span></footer>
  </main>`;

type Endpoint = { method: string; path: string; lamports: number | string };
const status = document.querySelector<HTMLElement>('#status')!;
const detail = document.querySelector<HTMLElement>('#detail')!;
const tbody = document.querySelector<HTMLTableSectionElement>('#endpoints')!;
fetch('/api/sales', { cache: 'no-store' }).then(async response => {
  if (!response.ok) throw new Error(`Discovery returned ${response.status}`);
  const data: { configured: boolean; endpoints: Endpoint[] } = await response.json();
  if (!Array.isArray(data.endpoints)) throw new Error('Invalid discovery response');
  status.textContent = data.configured ? '● CONFIGURED' : '● NOT CONFIGURED';
  status.classList.toggle('ready', data.configured);
  detail.textContent = data.configured ? 'CONFIGURATION PRESENT · UPSTREAM HEALTH NOT CHECKED' : 'SERVER CONFIGURATION INCOMPLETE';
  tbody.replaceChildren(...data.endpoints.map(endpoint => {
    const row = document.createElement('tr');
    for (const value of [
      endpoint.method, endpoint.path,
      endpoint.path.includes('/arb/') ? 'Cross-DEX quote feed' :
        endpoint.path.includes('/mev/') ? 'MEV telemetry' :
          endpoint.path.includes('/credits/') ? '50 prepaid calls' :
            endpoint.path.includes('/mcp') ? 'Agent tools' : 'Solana JSON-RPC',
      typeof endpoint.lamports === 'number' ? `${endpoint.lamports / 1e9} SOL` : 'Per tool'
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
}).catch(() => {
  status.textContent = '● UNAVAILABLE';
  tbody.replaceChildren();
  const row = tbody.insertRow();
  const cell = row.insertCell();
  cell.colSpan = 4;
  cell.textContent = 'Discovery unavailable. Check your deployment.';
});
