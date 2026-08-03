// Free, zero-capital backtest: replay the last N days and measure whether Glidly's
// liquidation-time prediction would have let us fire BEFORE the actual winner (TEFVYG/TJ6).
//
// Method (precise):
//   1. From each liquidated order's most recent RentResource snapshot (amount, deposit,
//      rentIndex, ts) we predict the exact moment it becomes liquidatable.
//   2. We compare that predicted moment to when the winner ACTUALLY struck (Liquidate ts).
//   3. delta = actualStrikeMs - predictedLiquidatableMs is the reaction window the winner
//      left on the table. If we can fire within `delta`, we beat them.
//
// Correctness note: the global rent-index advances at the same rate for everyone, so for a
// historical order we anchor the global index to THAT order's own (rentIndex, snapshot-time).
// Evaluating at nowMs = snapshot-time then yields accrued = 0 and a clean forward prediction.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { JustLendReader, eventAddrToBase58, orderKey, type MarketParams } from './justlend.js';
import { predictLiquidatableAt, type OrderSnapshot } from './predictor.js';
import { sunToTrx } from './tron.js';

const DAYS = Number(process.env.GLIDLY_BACKTEST_DAYS ?? 7);
const RENT_BUFFER_DAYS = 2; // rents that lead to a liquidation may predate the liq window
const REACTIONS_MS = [0, 3_000, 6_000, 15_000, 30_000, 60_000, 300_000];
const FLOOR = 20.5;

interface RentSnap {
  ts: number;
  amountSun: bigint;
  depositSun: bigint;
  rentIndex: bigint;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (Math.abs(s) < 90) return `${s}s`;
  return `${(s / 60).toFixed(1)}m`;
}

async function main(): Promise<void> {
  const reader = new JustLendReader();
  const nowMs = Date.now();
  const liqMinTs = nowMs - DAYS * 24 * 3_600_000;
  const rentMinTs = nowMs - (DAYS + RENT_BUFFER_DAYS) * 24 * 3_600_000;

  console.log(`\n=== GLIDLY · ${DAYS}-DAY SHADOW BACKTEST (zero capital) ===`);
  console.log('Fetching events + market params…');
  const [rents, liqs, mp] = await Promise.all([
    reader.fetchRentEvents(rentMinTs),
    reader.fetchLiquidateEvents(liqMinTs),
    reader.getMarketParams(),
  ]);
  console.log(`  rentResource=${rents.length}  liquidations=${liqs.length}`);
  console.log(
    `  market: feeRatio=${mp.feeRatio} minFee=${sunToTrx(mp.minFeeSun)}TRX rentRate=${mp.rentRate} liqRate=${mp.liquidateRate} liqThreshold=${mp.liquidateThreshold}`,
  );

  // Index rent snapshots per order, ascending by ts.
  const byOrder = new Map<string, RentSnap[]>();
  for (const e of rents) {
    const r = e.result;
    if (r.securityDeposit === undefined || r.rentIndex === undefined || r.amount === undefined) continue;
    const key = orderKey(r.renter, r.receiver, r.resourceType);
    const list = byOrder.get(key) ?? [];
    list.push({
      ts: e.block_timestamp,
      amountSun: BigInt(r.amount),
      depositSun: BigInt(r.securityDeposit),
      rentIndex: BigInt(r.rentIndex),
    });
    byOrder.set(key, list);
  }
  for (const list of byOrder.values()) list.sort((a, b) => a.ts - b.ts);

  // Score each liquidation.
  interface Row {
    who: string;
    rewardTrxActual: number;
    rewardTrxPredicted: number;
    deltaMs: number; // actualStrike - predictedLiquidatable
    isFloor: boolean;
  }
  const rows: Row[] = [];
  let noSnapshot = 0;
  let feeMismatch = 0;

  for (const e of liqs) {
    const r = e.result;
    const key = orderKey(r.renter, r.receiver, r.resourceType);
    const snaps = byOrder.get(key);
    const strikeMs = e.block_timestamp;
    const snap = snaps?.filter((s) => s.ts <= strikeMs).at(-1);
    if (!snap) {
      noSnapshot += 1;
      continue;
    }
    // Anchor global index to this order's own snapshot (see correctness note).
    const mpOrder: MarketParams = { ...mp, globalRentIndex: snap.rentIndex, globalRentUpdatedAt: Math.floor(snap.ts / 1000) };
    const o: OrderSnapshot = { amountSun: snap.amountSun, depositSun: snap.depositSun, rentIndex: snap.rentIndex, snapshotAtMs: snap.ts };
    const cttl = predictLiquidatableAt(o, mpOrder, snap.ts);
    if (!cttl) continue;

    const rewardTrxActual = sunToTrx(BigInt(r.liquidateFee || '0'));
    const rewardTrxPredicted = cttl.rewardTrx;
    if (Math.abs(rewardTrxPredicted - rewardTrxActual) > Math.max(1, rewardTrxActual * 0.1)) feeMismatch += 1;

    rows.push({
      who: eventAddrToBase58(r.liquidator),
      rewardTrxActual,
      rewardTrxPredicted,
      deltaMs: strikeMs - cttl.predictedLiquidatableAtMs,
      isFloor: rewardTrxActual <= FLOOR,
    });
  }

  const scored = rows.length;
  console.log(`\nScored ${scored}/${liqs.length} liquidations (no rent snapshot for ${noSnapshot}).`);
  console.log(`Fee-math validation: ${scored - feeMismatch}/${scored} predicted rewards matched actual within 10%.`);

  // Timing distribution.
  const deltas = rows.map((r) => r.deltaMs);
  const onTimeOrEarly = deltas.filter((d) => d >= 0).length; // order was liquidatable before/at strike (our math not "late")
  console.log('\n──────────── TIMING: winner struck N after the order became liquidatable ────────────');
  console.log(`  median delta: ${fmtDur(median(deltas))}   (positive = winner left a reaction window)`);
  console.log(`  predictions where order was liquidatable at/before strike: ${onTimeOrEarly}/${scored}`);
  console.log(`  → if delta is consistently negative, competitors predict EARLIER than us (we must improve the model).`);

  console.log('\n──────────── WOULD-WIN RATE vs reaction latency ────────────');
  console.log('  (we win a race if we can fire within `reaction` of the liquidatable moment)');
  for (const react of REACTIONS_MS) {
    const wins = rows.filter((r) => r.deltaMs >= react).length;
    const floorWins = rows.filter((r) => r.isFloor && r.deltaMs >= react).length;
    console.log(
      `  reaction ≤ ${String(fmtDur(react)).padStart(5)}:  ${String(wins).padStart(3)}/${scored} winnable ` +
        `(${((wins / scored) * 100).toFixed(0)}%)   floor: ${floorWins}  → ~${(floorWins / DAYS).toFixed(1)} floor wins/day`,
    );
  }

  // What reaction is realistic? pre-staged (~0-3s, same block), reactive (~6-30s), slow (>60s).
  console.log('\n──────────── READ ────────────');
  const winnable3s = rows.filter((r) => r.isFloor && r.deltaMs >= 3_000).length / DAYS;
  const winnable30s = rows.filter((r) => r.isFloor && r.deltaMs >= 30_000).length / DAYS;
  console.log(`  Pre-staged (≤3s, same block):   ~${winnable3s.toFixed(1)} floor wins/day attainable`);
  console.log(`  Decent reactive (≤30s):         ~${winnable30s.toFixed(1)} floor wins/day attainable`);
  console.log(`  Your goal: 1-2 floor wins/day ($6-13/day). ${winnable3s >= 1 ? 'REACHABLE pre-staged.' : winnable30s >= 1 ? 'Needs tight pre-staging.' : 'HARD — winners strike same-block; infra race.'}`);

  const report = {
    generatedAt: new Date(nowMs).toISOString(),
    days: DAYS,
    scored,
    noSnapshot,
    feeMatchRate: scored > 0 ? (scored - feeMismatch) / scored : 0,
    medianDeltaMs: median(deltas),
    winnableByReaction: Object.fromEntries(
      REACTIONS_MS.map((react) => [
        `${react}ms`,
        { total: rows.filter((r) => r.deltaMs >= react).length, floor: rows.filter((r) => r.isFloor && r.deltaMs >= react).length },
      ]),
    ),
    rows: rows.map((r) => ({ ...r })),
  };
  const dir = path.resolve(config.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'backtest-latest.json'), JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${path.join(dir, 'backtest-latest.json')}\n`);
}

main().catch((e) => {
  console.error('fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
