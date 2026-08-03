// Proof for the user: (a) the last 4 REAL liquidations — when each became liquidatable
// (contract math) vs when it was actually taken on-chain — and (b) any positions
// liquidatable RIGHT NOW. All on-chain, nothing assumed.
import { JustLendReader, eventAddrToBase58, orderKey, type MarketParams } from './justlend.js';
import { predictLiquidatableAt, type OrderSnapshot } from './predictor.js';
import { sunToTrx } from './tron.js';

const RENT_DAYS = Number(process.env.GLIDLY_PROOF_RENT_DAYS ?? 16);

interface Snap { ts: number; amountSun: bigint; depositSun: bigint; rentIndex: bigint }

function fmt(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}
function dur(ms: number): string {
  const m = Math.round(ms / 60000);
  if (Math.abs(m) < 90) return `${m} min`;
  return `${(m / 60).toFixed(1)} hours`;
}

async function main(): Promise<void> {
  const reader = new JustLendReader();
  const now = Date.now();
  const rentMin = now - RENT_DAYS * 24 * 3_600_000;
  const liqMin = now - 3 * 24 * 3_600_000;
  console.log(`Pulling on-chain events (rents ${RENT_DAYS}d, liqs 3d)…`);
  const [rents, returns, liqs, mp] = await Promise.all([
    reader.fetchRentEvents(rentMin),
    reader.fetchReturnEvents(rentMin),
    reader.fetchLiquidateEvents(liqMin),
    reader.getMarketParams(),
  ]);

  // Index latest rent snapshot per order.
  const byOrder = new Map<string, Snap[]>();
  for (const e of rents) {
    const r = e.result;
    if (!r.securityDeposit || !r.rentIndex || !r.amount) continue;
    const k = orderKey(r.renter, r.receiver, r.resourceType);
    (byOrder.get(k) ?? byOrder.set(k, []).get(k)!).push({ ts: e.block_timestamp, amountSun: BigInt(r.amount), depositSun: BigInt(r.securityDeposit), rentIndex: BigInt(r.rentIndex) });
  }
  for (const list of byOrder.values()) list.sort((a, b) => a.ts - b.ts);

  // (4) Last 4 real liquidations.
  const last4 = [...liqs].sort((a, b) => b.block_timestamp - a.block_timestamp).slice(0, 4);
  console.log(`\n══════════ LAST 4 REAL LIQUIDATIONS ══════════`);
  for (const e of last4) {
    const k = orderKey(e.result.renter, e.result.receiver, e.result.resourceType);
    const struckMs = e.block_timestamp;
    const snap = byOrder.get(k)?.filter((s) => s.ts <= struckMs).at(-1);
    const reward = sunToTrx(BigInt(e.result.liquidateFee || '0'));
    const who = eventAddrToBase58(e.result.liquidator);
    console.log(`\n• order ${k.slice(0, 12)}…  reward ${reward.toFixed(0)} TRX  taken by ${who.slice(0, 10)}`);
    if (!snap) {
      console.log(`    (rented >${RENT_DAYS}d ago — snapshot outside window)`);
      console.log(`    LIQUIDATED at: ${fmt(struckMs)}`);
      continue;
    }
    const mpO: MarketParams = { ...mp, globalRentIndex: snap.rentIndex, globalRentUpdatedAt: Math.floor(snap.ts / 1000) };
    const cttl = predictLiquidatableAt({ amountSun: snap.amountSun, depositSun: snap.depositSun, rentIndex: snap.rentIndex, snapshotAtMs: snap.ts } as OrderSnapshot, mpO, snap.ts);
    if (!cttl) { console.log('    (could not compute)'); continue; }
    const becameMs = cttl.predictedLiquidatableAtMs;
    console.log(`    became liquidatable: ${fmt(becameMs)}`);
    console.log(`    actually liquidated: ${fmt(struckMs)}`);
    console.log(`    → SAT UNTOUCHED FOR: ${dur(struckMs - becameMs)} before anyone took it`);
  }

  // (2) Anything liquidatable RIGHT NOW?
  const open = new Map<string, Snap & { key: string; renter: string; receiver: string; resourceType: number }>();
  for (const e of rents) {
    const r = e.result;
    if (!r.securityDeposit || !r.rentIndex || !r.amount) continue;
    const k = orderKey(r.renter, r.receiver, r.resourceType);
    open.set(k, { key: k, renter: r.renter, receiver: r.receiver, resourceType: Number(r.resourceType), ts: e.block_timestamp, amountSun: BigInt(r.amount), depositSun: BigInt(r.securityDeposit), rentIndex: BigInt(r.rentIndex) });
  }
  for (const e of returns) open.delete(orderKey(e.result.renter, e.result.receiver, e.result.resourceType));
  for (const e of liqs) open.delete(orderKey(e.result.renter, e.result.receiver, e.result.resourceType));

  const ripe = [...open.values()].filter((o) => {
    const mpO: MarketParams = { ...mp, globalRentIndex: o.rentIndex, globalRentUpdatedAt: Math.floor(o.ts / 1000) };
    const c = predictLiquidatableAt({ amountSun: o.amountSun, depositSun: o.depositSun, rentIndex: o.rentIndex, snapshotAtMs: o.ts } as OrderSnapshot, mpO, now);
    return c && c.predictedLiquidatableAtMs <= now;
  });

  console.log(`\n══════════ LIQUIDATABLE RIGHT NOW? ══════════`);
  console.log(`open orders (rented ≤${RENT_DAYS}d): ${open.size}   predicted liquidatable now: ${ripe.length}`);
  for (const o of ripe.slice(0, 8)) {
    const sim = await reader.simulateLiquidate(o.renter, o.receiver, o.resourceType);
    console.log(`  ${o.key.slice(0, 12)}…  on-chain confirms liquidatable=${sim.ok}  reward=${sim.rewardTrx.toFixed(0)} TRX  energy=${sim.energyUsed ?? '?'}`);
  }
  if (ripe.length === 0) console.log('  none sitting open right now (they get swept within hours; watch over time to catch them crossing).');
}

main().catch((e) => console.error('fatal:', e instanceof Error ? e.message : e));
