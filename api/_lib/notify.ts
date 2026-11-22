export async function notifyPaymentReceived(params: {
  amountLamports: number;
  amountUsdcAtomic: number;
  signature: string;
  route: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return;
  const to = process.env.ALERT_EMAIL?.trim() || 'timothyhuff25@gmail.com';
  const amount = params.amountUsdcAtomic
    ? `${params.amountUsdcAtomic / 1_000_000} USDC`
    : `${params.amountLamports / 1_000_000_000} SOL`;
  const treasury = process.env.TREASURY_ADDRESS?.trim() || 'configured treasury';
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `mev-paywall-alert-${params.signature}`,
      },
      body: JSON.stringify({
        from: 'Solana MEV Paywall Alerts <onboarding@resend.dev>',
        to: [to],
        subject: `[Solana-MEV-RPC-Paywall] +${amount} Received`,
        text: [
          `New Solana Mainnet payment settled on Solana-MEV-RPC-Paywall.`,
          `Amount: ${amount}`,
          `Route: ${params.route}`,
          `Treasury: ${treasury}`,
          `Transaction: https://solscan.io/tx/${params.signature}`,
        ].join('\n'),
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) console.error(`Payment alert failed: HTTP ${response.status}`);
  } catch (error) {
    console.error('Payment alert failed:', error instanceof Error ? error.name : 'unknown error');
  }
}
