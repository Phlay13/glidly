// Timing calibration: does our predictor's "is it liquidatable NOW?" agree with on-chain
// ground truth (the liquidate() simulation)? This validates the timing boundary the backtest
// depends on. If the predictor fires EARLY (says liquidatable when chain says no), the
// backtest's "4-hour window" is partly illusion and must be corrected.
import { JustLendReader, orderKey, type MarketParams } from './justlend.js';
import { predictLiquidatableAt, type OrderSnapshot } from './predictor.js';
import { sunToTrx } from './tron.js';

const SAMPLE = Number(process.env.GLIDLY_CALIBRATE_SAMPLE ?? 60);

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (Math.abs(s) < 90) return `${s}s`;
  if (Math.abs(s) < 5400) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

async function main(): Promise<void> {
  const reader = new JustLendReader();
  const minTs = Date.now() - 30 * 3_600_000;
  console.log(`\n=== GLIDLY · TIMING CALIBRATION ===`);
  console.log('Fetching open orders + market params…');
  const [rents, returns, liqs, mp, chainNow] = await Promise.all([
    reader.fetchRentEvents(minTs),
    reader.fetchReturnEvents(minTs),
    reader.fetchLiquidateEvents(minTs),
    reader.getMarketParams(),
    reader.nowChainMs(),
  ]);

  const open = new Map<string, { renter: string; receiver: string; resourceType: number; amountSun: bigint }>();
  for (const e of rents) {
    const r = e.result;
    open.set(orderKey(r.renter, r.receiver, r.resourceType), {
      renter: r.renter,
      receiver: r.receiver,
      resourceType: Number(r.resourceType),
      amountSun: BigInt(r.amount || '0'),
    });
  }
  for (const e of returns) open.delete(orderKey(e.result.renter, e.result.receiver, e.result.resourceType));
  for (const e of liqs) open.delete(orderKey(e.result.renter, e.result.receiver, e.result.resourceType));

  const sample = [...open.values()].slice(0, SAMPLE);
  console.log(`open orders=${open.size}, calibrating on ${sample.length}. chainNow=${new Date(chainNow).toISOString()}`);
  console.log(`market: liqThreshold=${mp.liquidateThreshold} (0 ⇒ boundary = liquidateFee + oneDayRent)\n`);

  let agree = 0;
  let predEarly = 0; // predictor says liquidatable now, chain says NO  ← the dangerous error
  let predLate = 0; //  predictor says not yet, chain says YES
  const etaFuture: number[] = [];
  let errorCount = 0;

  for (const o of sample) {
    const info = await reader.getRentInfo(o.renter, o.receiver, o.resourceType);
    const sim = await reader.simulateLiquidate(o.renter, o.receiver, o.resourceType);
    if (!info) {
      errorCount += 1;
      continue;
    }
    const snap: OrderSnapshot = { amountSun: o.amountSun, depositSun: info.securityDepositSun, rentIndex: info.rentIndex, snapshotAtMs: chainNow };
    // Anchor global index to this order's current snapshot, then evaluate at chainNow.
    const mpOrder: MarketParams = { ...mp, globalRentIndex: info.rentIndex, globalRentUpdatedAt: Math.floor(chainNow / 1000) };
    const cttl = predictLiquidatableAt(snap, mpOrder, chainNow);
    if (!cttl) {
      errorCount += 1;
      continue;
    }
    const predictorYes = cttl.predictedLiquidatableAtMs <= chainNow + 1500;
    const chainYes = sim.ok; // reward > 0 ⇒ liquidatable now (ground truth)

    if (predictorYes === chainYes) agree += 1;
    else if (predictorYes && !chainYes) predEarly += 1;
    else predLate += 1;

    if (!predictorYes) etaFuture.push(cttl.predictedLiquidatableAtMs - chainNow);
  }

  const n = agree + predEarly + predLate;
  console.log('──────────── CONFUSION (predictor vs on-chain liquidate sim) ────────────');
  console.log(`  scored=${n}  (rpc/info errors=${errorCount})`);
  console.log(`  AGREE:                 ${agree}/${n}  (${n ? ((agree / n) * 100).toFixed(0) : 0}%)`);
  console.log(`  predictor EARLY (false-yes): ${predEarly}/${n}  ← if high, our boundary is too early; backtest window inflated`);
  console.log(`  predictor LATE  (false-no):  ${predLate}/${n}`);
  if (etaFuture.length) {
    const s = [...etaFuture].sort((a, b) => a - b);
    console.log(`\n  Predicted ETA for not-yet orders: min ${fmtDur(s[0])}  med ${fmtDur(s[Math.floor(s.length / 2)])}  max ${fmtDur(s[s.length - 1])}`);
  }
  console.log('\n──────────── VERDICT ────────────');
  if (predEarly / Math.max(1, n) > 0.15) {
    console.log('  ⚠ Predictor fires EARLY too often. The 4h backtest window is partly our error.');
    console.log('    Fix the boundary before trusting win-rate. (Likely an extra threshold/guard term.)');
  } else {
    console.log('  ✓ Predictor timing agrees with chain. The backtest window is REAL:');
    console.log('    competitors are SLOW sweepers (hours), not millisecond racers. A reliable prompt');
    console.log('    bot with cheap rented energy can plausibly capture floor orders.');
  }
  console.log('');
}

main().catch((e) => {
  console.error('fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
