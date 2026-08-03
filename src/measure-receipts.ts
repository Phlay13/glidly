// One-off: measure REAL energy consumed by the last N successful on-chain liquidations,
// straight from their transaction receipts. This is the success-path energy that sizes the stake.
import { JustLendReader, eventAddrToBase58 } from './justlend.js';
import { config } from './config.js';
import { sunToTrx } from './tron.js';

async function main(): Promise<void> {
  const reader = new JustLendReader();
  const minTs = Date.now() - config.lookbackHours * 3_600_000;
  const liqs = await reader.fetchLiquidateEvents(minTs);
  console.log(`\nMeasuring real energy on ${liqs.length} successful liquidations (last ${config.lookbackHours}h)…\n`);

  const energies: number[] = [];
  const feesTrx: number[] = [];
  for (const e of liqs) {
    const info = await reader.tron.getTransactionInfo(e.transaction_id).catch(() => null);
    const energy = info?.receipt?.energy_usage_total ?? info?.receipt?.energy_usage ?? 0;
    const energyFeeSun = info?.receipt?.energy_fee ?? 0; // TRX burned for energy, if any
    const rewardTrx = sunToTrx(BigInt(e.result.liquidateFee || '0'));
    if (energy > 0) energies.push(energy);
    feesTrx.push(rewardTrx);
    console.log(
      `  ${eventAddrToBase58(e.result.liquidator).slice(0, 8)}…  energy=${energy.toLocaleString()}  ` +
        `energyFeeBurn=${sunToTrx(BigInt(energyFeeSun)).toFixed(2)} TRX  reward=${rewardTrx.toFixed(2)} TRX`,
    );
  }
  energies.sort((a, b) => a - b);
  const sum = energies.reduce((a, b) => a + b, 0);
  const med = energies[Math.floor(energies.length / 2)] ?? 0;
  console.log('\n── REAL SUCCESS-PATH ENERGY ──');
  console.log(`  samples=${energies.length}  min=${(energies[0] ?? 0).toLocaleString()}  median=${med.toLocaleString()}  ` +
    `mean=${Math.round(sum / Math.max(1, energies.length)).toLocaleString()}  max=${(energies[energies.length - 1] ?? 0).toLocaleString()}`);

  const eco = await reader.energyPerStakedTrx().catch(() => null);
  if (eco && med > 0) {
    console.log(`\n  energy/TRX staked = ${eco.ratio.toFixed(2)}`);
    console.log(`  → stake for ONE concurrent liq slot (median ${med.toLocaleString()} energy): ~${Math.round(med / eco.ratio).toLocaleString()} TRX`);
    console.log(`  → burn cost if unstaked (~210 sun/energy): ~${((med * 210) / 1e6).toFixed(2)} TRX per attempt`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
