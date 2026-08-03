// How many open rental orders actually exist? Chunked 30-day backfill (JustLend max rental = 30d,
// so this captures EVERY currently-open order), with an age breakdown so we can see how much a
// short window was hiding. Events only — no getRentInfo (fast).
import { JustLendReader, orderKey, type LiquidateResult, type RentResult } from './justlend.js';
import { sunToTrx } from './tron.js';

const DAYS = Number(process.env.GLIDLY_COUNT_DAYS ?? 30);
const CHUNK = 3 * 24 * 3_600_000;

async function main(): Promise<void> {
  const reader = new JustLendReader();
  const now = Date.now();
  const minTs = now - DAYS * 24 * 3_600_000;
  console.log(`Counting open orders over ${DAYS} days (chunked)…`);

  type Ev = { kind: 'rent' | 'rm'; ts: number; bn: number; ei: number; r: Record<string, string | undefined> };
  const evs: Ev[] = [];
  for (let lo = minTs; lo < now; lo += CHUNK) {
    const hi = Math.min(lo + CHUNK, now);
    const [rents, returns, liqs] = await Promise.all([reader.fetchRentEvents(lo, hi), reader.fetchReturnEvents(lo, hi), reader.fetchLiquidateEvents(lo, hi)]);
    for (const e of rents) evs.push({ kind: 'rent', ts: e.block_timestamp, bn: e.block_number, ei: e.event_index, r: e.result });
    for (const e of returns) evs.push({ kind: 'rm', ts: e.block_timestamp, bn: e.block_number, ei: e.event_index, r: e.result });
    for (const e of liqs) evs.push({ kind: 'rm', ts: e.block_timestamp, bn: e.block_number, ei: e.event_index, r: e.result });
    console.log(`  ${new Date(lo).toISOString().slice(0, 10)}: rent=${rents.length} ret=${returns.length} liq=${liqs.length}`);
  }
  evs.sort((a, b) => a.ts - b.ts || a.bn - b.bn || a.ei - b.ei);

  const open = new Map<string, { rentedAt: number; amountTrx: number }>();
  for (const e of evs) {
    const k = orderKey(e.r.renter ?? '', e.r.receiver ?? '', e.r.resourceType ?? '0');
    if (e.kind === 'rent') open.set(k, { rentedAt: e.ts, amountTrx: sunToTrx(BigInt((e.r as RentResult).amount || '0')) });
    else open.delete(k);
  }

  const ages = { '0-7d': 0, '7-14d': 0, '14-30d': 0 };
  let aboveFloor = 0;
  for (const o of open.values()) {
    const ageDays = (now - o.rentedAt) / (24 * 3_600_000);
    if (ageDays <= 7) ages['0-7d']++;
    else if (ageDays <= 14) ages['7-14d']++;
    else ages['14-30d']++;
    // Reward = delegated × 0.008%; only orders above ~250k TRX delegated beat the 20 TRX floor.
    if (o.amountTrx * 0.00008 > 20.5) aboveFloor++;
  }

  console.log(`\n════════ TRUE OPEN ORDER COUNT (${DAYS}d) ════════`);
  console.log(`  TOTAL OPEN: ${open.size}`);
  console.log(`  by age rented:  last 7d = ${ages['0-7d']}   7-14d = ${ages['7-14d']}   14-30d = ${ages['14-30d']}`);
  console.log(`  → a 7-day window would have MISSED ${ages['7-14d'] + ages['14-30d']} open orders (${(((ages['7-14d'] + ages['14-30d']) / open.size) * 100).toFixed(0)}%)`);
  console.log(`  above-floor reward orders (>20 TRX, i.e. real whales): ${aboveFloor} of ${open.size}`);
}
main().catch((e) => console.error('fatal:', e instanceof Error ? e.message : e));
