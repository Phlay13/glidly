// 30-day JustLend energy-rental liquidation report.
// EXACT (on-chain): total liquidations, leaderboard, TRX earned, per-day, reward distribution.
// ESTIMATE (our model): "became ripe" time → sit-time. Labeled, because the model can run early;
// the live monitor measures the true sit-time going forward.
import axios from 'axios';
import { JustLendReader, eventAddrToBase58, orderKey, type MarketParams } from './justlend.js';
import { predictLiquidatableAt, type OrderSnapshot } from './predictor.js';
import { sunToTrx } from './tron.js';

const DAYS = 30;
const CHUNK = 3 * 24 * 3_600_000;
const FLOOR = 20.5;

async function trxUsd(): Promise<number> {
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=tron&vs_currencies=usd', { timeout: 8000 });
    return r.data?.tron?.usd ?? 0.32;
  } catch {
    return 0.32;
  }
}
function fmt(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}
function sit(ms: number): string {
  const m = ms / 60000;
  return m < 90 ? `${m.toFixed(0)}m` : `${(m / 60).toFixed(1)}h`;
}

async function main(): Promise<void> {
  const reader = new JustLendReader();
  const now = Date.now();
  const liqMin = now - DAYS * 24 * 3_600_000;
  const rentMin = now - (DAYS + 2) * 24 * 3_600_000;

  console.log(`Pulling 30-day data (sequential, rate-limit-safe; may take a few min)…`);
  const price = await trxUsd();
  const liqs = await reader.fetchLiquidateEvents(liqMin);
  const mp = await reader.getMarketParams();

  // Rent snapshots (chunked sequential) for the ripe-time estimate.
  const snaps = new Map<string, { ts: number; amountSun: bigint; depositSun: bigint; rentIndex: bigint }[]>();
  for (let lo = rentMin; lo < now; lo += CHUNK) {
    const hi = Math.min(lo + CHUNK, now);
    const rents = await reader.fetchRentEvents(lo, hi);
    for (const e of rents) {
      const r = e.result;
      if (!r.securityDeposit || !r.rentIndex || !r.amount) continue;
      const k = orderKey(r.renter, r.receiver, r.resourceType);
      (snaps.get(k) ?? snaps.set(k, []).get(k)!).push({ ts: e.block_timestamp, amountSun: BigInt(r.amount), depositSun: BigInt(r.securityDeposit), rentIndex: BigInt(r.rentIndex) });
    }
  }
  for (const l of snaps.values()) l.sort((a, b) => a.ts - b.ts);

  // ---- EXACT aggregates ----
  let totalTrx = 0;
  let floor = 0;
  let whale = 0;
  const fees: number[] = [];
  const perDay = new Map<string, { n: number; trx: number }>();
  const board = new Map<string, { wins: number; trx: number; max: number; floor: number; whale: number }>();
  const detail: { becameMs: number | null; liqMs: number; reward: number; who: string }[] = [];

  for (const e of liqs) {
    const reward = sunToTrx(BigInt(e.result.liquidateFee || '0'));
    totalTrx += reward;
    fees.push(reward);
    const isFloor = reward <= FLOOR;
    isFloor ? floor++ : whale++;
    const day = new Date(e.block_timestamp).toISOString().slice(0, 10);
    const d = perDay.get(day) ?? { n: 0, trx: 0 };
    d.n++; d.trx += reward; perDay.set(day, d);
    const who = eventAddrToBase58(e.result.liquidator);
    const c = board.get(who) ?? { wins: 0, trx: 0, max: 0, floor: 0, whale: 0 };
    c.wins++; c.trx += reward; c.max = Math.max(c.max, reward); isFloor ? c.floor++ : c.whale++; board.set(who, c);

    // ripe-time estimate
    const k = orderKey(e.result.renter, e.result.receiver, e.result.resourceType);
    const snap = snaps.get(k)?.filter((s) => s.ts <= e.block_timestamp).at(-1);
    let becameMs: number | null = null;
    if (snap) {
      const mpO: MarketParams = { ...mp, globalRentIndex: snap.rentIndex, globalRentUpdatedAt: Math.floor(snap.ts / 1000) };
      const c2 = predictLiquidatableAt({ amountSun: snap.amountSun, depositSun: snap.depositSun, rentIndex: snap.rentIndex, snapshotAtMs: snap.ts } as OrderSnapshot, mpO, snap.ts);
      becameMs = c2?.predictedLiquidatableAtMs ?? null;
    }
    detail.push({ becameMs, liqMs: e.block_timestamp, reward, who });
  }
  fees.sort((a, b) => a - b);
  const pc = (p: number) => fees[Math.min(fees.length - 1, Math.floor((p / 100) * fees.length))] ?? 0;
  const sits = detail.filter((d) => d.becameMs !== null && d.liqMs >= (d.becameMs as number)).map((d) => d.liqMs - (d.becameMs as number)).sort((a, b) => a - b);
  const medSit = sits.length ? sits[Math.floor(sits.length / 2)] : null;

  console.log(`\n════════ 30-DAY LIQUIDATION REPORT ════════  (TRX=$${price})`);
  console.log(`\n— EXACT (on-chain) —`);
  console.log(`Total liquidations: ${liqs.length}   (~${(liqs.length / DAYS).toFixed(1)}/day)`);
  console.log(`Total reward earned: ${totalTrx.toFixed(0)} TRX  ≈  $${(totalTrx * price).toFixed(0)}   (~$${((totalTrx * price) / DAYS).toFixed(0)}/day)`);
  console.log(`Floor (≤20 TRX): ${floor}   Whale (>20): ${whale}`);
  console.log(`Reward TRX: min ${fees[0]?.toFixed(0)} / median ${pc(50).toFixed(0)} / p90 ${pc(90).toFixed(0)} / max ${fees[fees.length - 1]?.toFixed(0)}`);

  console.log(`\n— LEADERBOARD (who liquidated most) —`);
  for (const [who, c] of [...board.entries()].sort((a, b) => b[1].trx - a[1].trx)) {
    console.log(`  ${who}\n     wins ${c.wins} (${((c.wins / liqs.length) * 100).toFixed(0)}%)  earned ${c.trx.toFixed(0)} TRX ($${(c.trx * price).toFixed(0)})  floor ${c.floor} whale ${c.whale}  max ${c.max.toFixed(0)} TRX`);
  }

  console.log(`\n— BY DAY —`);
  for (const [d, v] of [...perDay.entries()].sort()) console.log(`  ${d}  liqs ${String(v.n).padStart(3)}  reward ${v.trx.toFixed(0)} TRX`);

  console.log(`\n— SIT-TIME (ESTIMATE — model can run early; live monitor measures true value) —`);
  console.log(`  scored ${sits.length}/${liqs.length}.  median sat ≈ ${medSit !== null ? sit(medSit) : 'n/a'} before being taken`);

  console.log(`\n— SAMPLE: 12 most recent liquidations —`);
  console.log(`  became-ripe(est)   liquidated(exact)   sat(est)   reward   winner`);
  for (const d of detail.sort((a, b) => b.liqMs - a.liqMs).slice(0, 12)) {
    const satStr = d.becameMs !== null && d.liqMs >= d.becameMs ? sit(d.liqMs - d.becameMs) : 'n/a';
    console.log(`  ${d.becameMs ? fmt(d.becameMs) : '   (no snapshot) '}   ${fmt(d.liqMs)}   ${satStr.padStart(6)}   ${d.reward.toFixed(0).padStart(5)} TRX   ${d.who.slice(0, 10)}`);
  }
}
main().catch((e) => console.error('fatal:', e instanceof Error ? e.message : e));
