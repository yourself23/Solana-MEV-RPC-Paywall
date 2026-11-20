export async function notifyPaymentReceived(params: {
  amountLamports: number;
  signature: string;
  route: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return;
  const to = process.env.ALERT_EMAIL?.trim() || 'timothyhuff25@gmail.com';
  const sol = (params.amountLamports / 1_000_000_000).toFixed(6).replace(/\.?0+$/, '');
  const treasury = process.env.TREASURY_ADDRESS?.trim() || 'configured treasury';
  try {
    await fetch('https://resend.com', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `mev-paywall-alert-${params.signature}`,
      },
      body: JSON.stringify({
        from: 'Solana MEV Paywall Alerts <onboarding@resend.dev>',
        to: [to],
        subject: `[Solana-MEV-RPC-Paywall] +${sol} SOL Received`,
        text: [
          `New Solana Mainnet payment settled on Solana-MEV-RPC-Paywall.`,
          `Amount: ${sol} SOL (${params.amountLamports} lamports)`,
          `Route: ${params.route}`,
          `Treasury: ${treasury}`,
          `Transaction: https://solscan.io{params.signature}`,
        ].join('\n'),
      }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // Non-blocking: never fail a paid API response if email delivery times out
  }
}
