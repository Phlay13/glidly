// Measure the REAL deposit drain rate from live orders (read deposit twice, ~2 min apart),
// then test whether that rate explains when recent positions were liquidated.
import { JustLendReader, orderKey } from './justlend.js';
import { sunToTrx } from './tron.js';

const reader = new JustLendReader();
const SCALE = 1_000_000_000_000_000_000n;

interface Live { key: string; renter: string; receiver: string; resourceType: number; amountSun: bigint; dep0: number }

console.log('STEP A — measuring live deposit drain rate (read now, wait 120s, read again)…');
const rents = await reader.fetchRentEvents(Date.now() - 2 * 24 * 3_600_000);
const returns = await reader.fetchReturnEvents(Date.now() - 2 * 24 * 3_600_000);
const liqs0 = await reader.fetchLiquidateEvents(Date.now() - 2 * 24 * 3_600_000);
const open = new Map<string, Live>();
for (const e of rents) open.set(orderKey(e.result.renter, e.result.receiver, e.result.resourceType), { key: orderKey(e.result.renter, e.result.receiver, e.result.resourceType), renter: e.result.renter, receiver: e.result.receiver, resourceType: Number(e.result.resourceType), amountSun: BigInt(e.result.amount || '0'), dep0: 0 });
for (const e of returns) open.delete(orderKey(e.result.renter, e.result.receiver, e.result.resourceType));
for (const e of liqs0) open.delete(orderKey(e.result.renter, e.result.receiver, e.result.resourceType));

const sample = [...open.values()].slice(0, 10);
const t0 = Date.now();
for (const o of sample) {
  const info = await reader.getRentInfo(o.renter, o.receiver, o.resourceType);
  o.dep0 = info ? sunToTrx(info.securityDepositSun) : -1;
}
await new Promise((r) => setTimeout(r, 120_000));
const dtSec = (Date.now() - t0) / 1000;

const ks: number[] = []; // drain TRX/sec per (amount in TRX)
console.log(`\n  order            amount(TRX)   dep0     dep1     drain/min   drain÷amount`);
for (const o of sample) {
  const info = await reader.getRentInfo(o.renter, o.receiver, o.resourceType);
  if (!info || o.dep0 < 0) continue;
  const dep1 = sunToTrx(info.securityDepositSun);
  const drainPerSec = (o.dep0 - dep1) / dtSec;
  const amt = sunToTrx(o.amountSun);
  const k = amt > 0 ? drainPerSec / amt : 0;
  if (drainPerSec > 0) ks.push(k);
  console.log(`  ${o.key.slice(0, 8)}…   ${amt.toFixed(0).padStart(10)}   ${o.dep0.toFixed(1).padStart(7)}  ${dep1.toFixed(1).padStart(7)}   ${(drainPerSec * 60).toFixed(2).padStart(8)}   ${k.toExponential(3)}`);
}
const kAvg = ks.length ? ks.sort((a, b) => a - b)[Math.floor(ks.length / 2)] : 0;
console.log(`\n  median drain÷amount k = ${kAvg.toExponential(4)} TRX/sec per TRX-amount  (from ${ks.length} orders)`);

console.log('\nSTEP B — apply measured rate to recent liquidations (does deposit-drain explain the timing?):');
const liqs = [...liqs0].sort((a, b) => b.block_timestamp - a.block_timestamp).slice(0, 6);
const rentsBy = new Map<string, typeof rents>();
for (const e of rents) (rentsBy.get(orderKey(e.result.renter, e.result.receiver, e.result.resourceType)) ?? rentsBy.set(orderKey(e.result.renter, e.result.receiver, e.result.resourceType), []).get(orderKey(e.result.renter, e.result.receiver, e.result.resourceType))!).push(e);
for (const L of liqs) {
  const k = orderKey(L.result.renter, L.result.receiver, L.result.resourceType);
  const rs = (rentsBy.get(k) ?? []).sort((a, b) => a.block_timestamp - b.block_timestamp);
  if (!rs.length) { console.log(`  ${k.slice(0, 8)}…  (opened >2d ago, no snapshot)`); continue; }
  const D0 = sunToTrx(BigInt(rs[0].result.securityDeposit || '0'));
  const amt = sunToTrx(BigInt(rs[0].result.amount || '0'));
  const drainPerSec = kAvg * amt;
  const drainToZeroSec = drainPerSec > 0 ? D0 / drainPerSec : 0;
  const predRipeMs = rs[0].block_timestamp + drainToZeroSec * 1000;
  const lifeMin = (L.block_timestamp - rs[0].block_timestamp) / 60000;
  const sitMin = (L.block_timestamp - predRipeMs) / 60000;
  console.log(`  ${k.slice(0, 8)}…  D0=${D0.toFixed(0)} TRX amt=${amt.toFixed(0)}  lifetime=${(lifeMin / 60).toFixed(1)}h  predicted-drain-to-0=${(drainToZeroSec / 3600).toFixed(1)}h  → impliedSit=${sitMin > -90 && sitMin < 9000 ? sitMin.toFixed(0) + 'm' : (sitMin / 60).toFixed(1) + 'h'}`);
}
