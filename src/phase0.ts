// Phase 0 — Measure Reality (read-only, zero capital).
// Replaces G-1159's guesses with measured numbers and prints a GO/NO-GO report.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { JustLendReader, eventAddrToBase58, orderKey, type LiquidationSim } from './justlend.js';
import { sunToTrx } from './tron.js';

// Current TRON burn price for energy when you have none staked (~210 sun/energy).
// Used only to show what per-attempt burning/renting cost G-1159 vs the ~20 TRX floor.
const BURN_SUN_PER_ENERGY = 210;
const FLOOR_REWARD_TRX = 20;

interface OpenOrder {
  key: string;
  renter: string;
  receiver: string;
  resourceType: number;
  amountSun: bigint;
  rentedAt: number;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[i];
}
function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: d }) : 'n/a';
}

export async function runPhase0(): Promise<void> {
  const reader = new JustLendReader();
  const nowMs = Date.now();
  const minTs = nowMs - config.lookbackHours * 3_600_000;

  console.log('\n=== GLIDLY · PHASE 0 — MEASURE REALITY ===');
  console.log(`contract   ${config.contract}`);
  console.log(`endpoints  ${reader.tron.endpointLabels().join(', ')}`);
  console.log(`window     last ${config.lookbackHours}h (since ${new Date(minTs).toISOString()})`);
  console.log('Fetching events (RentResource / ReturnResource / Liquidate)…');

  const [rents, returns, liqs] = await Promise.all([
    reader.fetchRentEvents(minTs),
    reader.fetchReturnEvents(minTs),
    reader.fetchLiquidateEvents(minTs),
  ]);
  console.log(`  rents=${rents.length}  returns=${returns.length}  liquidations=${liqs.length}`);

  // ---- Build the set of orders still open at window end ----------------
  const open = new Map<string, OpenOrder>();
  for (const e of rents) {
    const r = e.result;
    const key = orderKey(r.renter, r.receiver, r.resourceType);
    open.set(key, {
      key,
      renter: r.renter,
      receiver: r.receiver,
      resourceType: Number(r.resourceType),
      amountSun: BigInt(r.amount || '0'),
      rentedAt: e.block_timestamp,
    });
  }
  for (const e of returns) open.delete(orderKey(e.result.renter, e.result.receiver, e.result.resourceType));
  for (const e of liqs) open.delete(orderKey(e.result.renter, e.result.receiver, e.result.resourceType));
  console.log(`  open orders (rented in window, not yet returned/liquidated): ${open.size}`);

  // ---- Measure real energy cost + reward on a sample ------------------
  const sample = [...open.values()].slice(0, config.measureSample);
  console.log(`\nMeasuring liquidate() energy + reward on ${sample.length} live orders…`);
  const sims: LiquidationSim[] = [];
  let liquidatableNow = 0;
  for (const o of sample) {
    const sim = await reader.simulateLiquidate(o.renter, o.receiver, o.resourceType);
    sims.push(sim);
    if (sim.ok) liquidatableNow += 1;
  }
  const energies = sims.map((s) => s.energyUsed).filter((e): e is number => typeof e === 'number' && e > 0).sort((a, b) => a - b);
  const okRewards = sims.filter((s) => s.ok).map((s) => s.rewardTrx).sort((a, b) => a - b);
  const medEnergy = pct(energies, 50);
  const p90Energy = pct(energies, 90);

  // ---- Historical liquidation economics (the prize pool) --------------
  const liqFees = liqs.map((e) => sunToTrx(BigInt(e.result.liquidateFee || '0'))).sort((a, b) => a - b);
  const totalRewardTrx = liqFees.reduce((a, b) => a + b, 0);
  const perDay = liqs.length / Math.max(1, config.lookbackHours / 24);
  const floorCount = liqFees.filter((r) => r <= FLOOR_REWARD_TRX + 0.5).length;
  const whaleCount = liqFees.length - floorCount;

  const byLiquidator = new Map<string, { wins: number; rewardTrx: number }>();
  for (const e of liqs) {
    const k = eventAddrToBase58(e.result.liquidator);
    const cur = byLiquidator.get(k) ?? { wins: 0, rewardTrx: 0 };
    cur.wins += 1;
    cur.rewardTrx += sunToTrx(BigInt(e.result.liquidateFee || '0'));
    byLiquidator.set(k, cur);
  }
  const leaderboard = [...byLiquidator.entries()].sort((a, b) => b[1].wins - a[1].wins).slice(0, 8);
  const topWins = leaderboard[0]?.[1].wins ?? 0;
  const topShare = liqs.length > 0 ? (topWins / liqs.length) * 100 : 0;

  // ---- Energy economics → break-even stake ----------------------------
  const eco = await reader.energyPerStakedTrx().catch(() => null);
  const ratio = eco?.ratio ?? 0;
  const energyForCost = medEnergy || p90Energy || 0;
  const stakeForOneSlotTrx = ratio > 0 && energyForCost > 0 ? energyForCost / ratio : 0;
  const burnPerAttemptTrx = (energyForCost * BURN_SUN_PER_ENERGY) / 1_000_000;

  // ---- REPORT ---------------------------------------------------------
  const report = {
    generatedAt: new Date(nowMs).toISOString(),
    windowHours: config.lookbackHours,
    events: { rents: rents.length, returns: returns.length, liquidations: liqs.length },
    openOrders: open.size,
    sampleMeasured: sample.length,
    liquidatableNow,
    energyCost: { samples: energies.length, median: medEnergy, p90: p90Energy, min: energies[0] ?? 0, max: energies[energies.length - 1] ?? 0 },
    rewardTrxFromSim: { samples: okRewards.length, min: okRewards[0] ?? 0, median: pct(okRewards, 50), max: okRewards[okRewards.length - 1] ?? 0 },
    historicalRewards: {
      perDay,
      totalTrxInWindow: totalRewardTrx,
      floorCount,
      whaleCount,
      min: liqFees[0] ?? 0,
      median: pct(liqFees, 50),
      p90: pct(liqFees, 90),
      max: liqFees[liqFees.length - 1] ?? 0,
    },
    competition: { uniqueLiquidators: byLiquidator.size, topLiquidatorWinSharePct: topShare, leaderboard: leaderboard.map(([a, v]) => ({ address: a, wins: v.wins, rewardTrx: v.rewardTrx })) },
    energyEconomics: eco
      ? { energyPerStakedTrx: ratio, totalEnergyLimit: eco.totalEnergyLimit, totalEnergyWeight: eco.totalEnergyWeight, stakeForOneSlotTrx, burnPerAttemptTrx }
      : null,
  };

  // Pretty print
  console.log('\n────────────────────────────────────────────────────────');
  console.log(' MEASURED REALITY');
  console.log('────────────────────────────────────────────────────────');
  console.log(` Liquidations / day (last ${config.lookbackHours}h):  ${fmt(perDay, 1)}`);
  console.log(`   floor (~${FLOOR_REWARD_TRX} TRX): ${floorCount}   whale (>${FLOOR_REWARD_TRX}): ${whaleCount}   total reward in window: ${fmt(totalRewardTrx)} TRX`);
  console.log(`   reward distribution TRX  min ${fmt(report.historicalRewards.min)} / med ${fmt(report.historicalRewards.median)} / p90 ${fmt(report.historicalRewards.p90)} / max ${fmt(report.historicalRewards.max)}`);
  console.log('');
  console.log(` Real liquidate() ENERGY cost (measured):  med ${fmt(medEnergy, 0)}  p90 ${fmt(p90Energy, 0)}  (n=${energies.length})`);
  console.log(`   → G-1159 guessed/rented ~230-250k. Measured median: ${fmt(medEnergy, 0)}.`);
  console.log(` Liquidatable RIGHT NOW in sample: ${liquidatableNow}/${sample.length}`);
  console.log('');
  if (eco) {
    console.log(` Energy per 1 TRX staked (live):  ${fmt(ratio, 2)} energy/TRX`);
    console.log(`   → Stake for one liq "slot" (${fmt(energyForCost, 0)} energy): ~${fmt(stakeForOneSlotTrx, 0)} TRX staked (recoverable)`);
    console.log(`   → If you BURNED instead: ~${fmt(burnPerAttemptTrx)} TRX per attempt vs ${FLOOR_REWARD_TRX} TRX floor reward  ← G-1159's bleed`);
  } else {
    console.log(' Energy/TRX ratio: unavailable (RPC did not return TotalEnergyLimit/Weight).');
  }
  console.log('');
  console.log(` Competition:  ${byLiquidator.size} unique liquidators, top bot won ${fmt(topShare, 0)}% of all liquidations`);
  for (const [addr, v] of leaderboard) {
    console.log(`   ${addr}  wins=${v.wins}  reward=${fmt(v.rewardTrx)} TRX`);
  }

  // ---- GO / NO-GO ------------------------------------------------------
  const realisticDailyWins = perDay * 0.1; // assume newcomer wins ~10% of races
  const realisticDailyTrx = realisticDailyWins * (report.historicalRewards.median || FLOOR_REWARD_TRX);
  const marginalOk = eco ? burnPerAttemptTrx < (report.historicalRewards.median || FLOOR_REWARD_TRX) : false;
  console.log('\n────────────────────────────────────────────────────────');
  console.log(' GO / NO-GO READOUT');
  console.log('────────────────────────────────────────────────────────');
  console.log(` Prize pool exists:        ${perDay >= 3 ? 'YES' : 'THIN'} (${fmt(perDay, 1)} liq/day, ${fmt(totalRewardTrx)} TRX/window)`);
  console.log(` Staking beats burning:    ${marginalOk ? 'YES — must stake, not rent/burn' : 'CHECK (burn ~ reward; staking essential)'}`);
  console.log(` Min viable stake:         ~${fmt(stakeForOneSlotTrx, 0)} TRX (1 slot) — sets the cold-start floor`);
  console.log(` Realistic newcomer take:  ~${fmt(realisticDailyWins, 1)} wins/day → ~${fmt(realisticDailyTrx)} TRX/day at ~10% win-rate`);
  console.log(`   (win-rate is the real unknown — Phase 3 pre-staging must lift it. Top bot share=${fmt(topShare, 0)}%)`);

  // ---- Persist ---------------------------------------------------------
  const dir = path.resolve(config.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `phase0-report-${nowMs}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, 'phase0-report-latest.json'), JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${outPath}`);
  console.log('Next: feed these numbers into the cold-start decision (PLAN.md §4) before staking.\n');
}
