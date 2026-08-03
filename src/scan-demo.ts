// LIVE PROOF that Glidly scans + reads the real JustLend contract correctly, right now.
// Step 1: scan the contract's event log → list of open rentals.
// Step 2: for a sample, ask the REAL contract live: current deposit, grabbable?, reward if grabbed.
// Step 3: Glidly's verdict — verifiable by you on tronscan.org and app.justlend.org.
import { JustLendReader, eventAddrToBase58, orderKey } from './justlend.js';
import { normalizeTronAddress, sunToTrx } from './tron.js';

const reader = new JustLendReader();
const RENT_TRX_PER_1K = 0.055;

function link(addr0x: string): string {
  return 'https://tronscan.org/#/address/' + eventAddrToBase58(addr0x);
}

console.log(`\n══════ GLIDLY LIVE SCAN — ${new Date().toISOString().slice(11, 19)} UTC ══════`);
console.log('STEP 1 — scanning JustLend contract event log for open rentals…');
const minTs = Date.now() - 3 * 24 * 3_600_000;
const rents = await reader.fetchRentEvents(minTs);
const returns = await reader.fetchReturnEvents(minTs);
const liqs = await reader.fetchLiquidateEvents(minTs);
const open = new Map<string, { renter: string; receiver: string; resourceType: number }>();
for (const e of rents) open.set(orderKey(e.result.renter, e.result.receiver, e.result.resourceType), { renter: e.result.renter, receiver: e.result.receiver, resourceType: Number(e.result.resourceType) });
for (const e of returns) open.delete(orderKey(e.result.renter, e.result.receiver, e.result.resourceType));
for (const e of liqs) open.delete(orderKey(e.result.renter, e.result.receiver, e.result.resourceType));
console.log(`   ✓ found ${open.size} OPEN rentals on-chain right now.\n`);

console.log('STEP 2 — asking the REAL contract about 6 of them (live reads):\n');
let grabbableCount = 0;
let checked = 0;
for (const o of [...open.values()]) {
  if (checked >= 6) break;
  const info = await reader.getRentInfo(o.renter, o.receiver, o.resourceType);
  if (!info) continue;
  const sim = await reader.simulateLiquidate(o.renter, o.receiver, o.resourceType);
  checked += 1;
  if (sim.ok) grabbableCount += 1;
  const deposit = sunToTrx(info.securityDepositSun);
  const net = sim.ok ? sim.rewardTrx - Math.max(1, ((sim.energyUsed || 230000) / 1000) * RENT_TRX_PER_1K) : 0;
  console.log(`   rental ${eventAddrToBase58(o.renter).slice(0, 10)}…  (verify: ${link(o.renter)})`);
  console.log(`     Glidly reads from contract → deposit: ${deposit.toFixed(1)} TRX | grabbable now? ${sim.ok ? 'YES' : 'no (still healthy/not overdue)'}${sim.ok ? ` | reward ${sim.rewardTrx.toFixed(0)} TRX, net +${net.toFixed(0)}` : ''}`);
}

console.log(`\nSTEP 3 — Glidly's verdict: ${grabbableCount} of ${checked} grabbable right now.`);
console.log(`   You can cross-check: open app.justlend.org → Liquidation page. It should show the same.`);
console.log(`   (When one DOES become grabbable, the live monitor catches it within ~90s and logs the reward.)\n`);
