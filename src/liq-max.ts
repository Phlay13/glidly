// Fast check: across 35 days of REAL liquidations, what did liquidators actually receive?
// Tests whether codex's "3509 TRX reward" ever materializes as an actual payout.
import { JustLendReader, eventAddrToBase58 } from './justlend.js';
import { sunToTrx } from './tron.js';

async function main(): Promise<void> {
  const reader = new JustLendReader();
  const minTs = Date.now() - 35 * 24 * 3_600_000;
  const liqs = await reader.fetchLiquidateEvents(minTs);
  const rows = liqs
    .map((e) => ({ fee: sunToTrx(BigInt(e.result.liquidateFee || '0')), who: eventAddrToBase58(e.result.liquidator), ts: e.block_timestamp }))
    .sort((a, b) => b.fee - a.fee);
  console.log(`\n35-day actual liquidations: ${rows.length}`);
  console.log('Top 10 REAL liquidator payouts (liquidateFee):');
  for (const r of rows.slice(0, 10)) console.log(`  ${r.fee.toFixed(2)} TRX  ${r.who.slice(0, 10)}  ${new Date(r.ts).toISOString().slice(0, 16)}`);
  const over1000 = rows.filter((r) => r.fee >= 1000).length;
  const over500 = rows.filter((r) => r.fee >= 500).length;
  console.log(`\n  payouts ≥ 3509 TRX (codex row-1 figure): ${rows.filter((r) => r.fee >= 3509).length}`);
  console.log(`  payouts ≥ 1000 TRX: ${over1000}    ≥ 500 TRX: ${over500}    max ever: ${rows[0]?.fee.toFixed(2)} TRX`);
}
main().catch((e) => console.error('fatal:', e instanceof Error ? e.message : e));
