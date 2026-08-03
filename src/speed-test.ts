// HIGH-RESOLUTION speed measurement. Polls every open order IN PARALLEL every few seconds.
// The instant the contract says an order is grabbable → start a stopwatch (chain time). When the
// on-chain Liquidate event lands → stop it. Result: the TRUE time each order sat grabbable before
// an opponent took it, to within the poll interval. Also counts orders grabbed faster than we can
// see (window < poll interval) — itself the answer if everything is sub-interval.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { JustLendReader, eventAddrToBase58, orderKey } from './justlend.js';
import { sunToTrx } from './tron.js';

const POLL_MS = Number(process.env.GLIDLY_POLL_MS ?? 6000);
const CONC = Number(process.env.GLIDLY_CONC ?? 24);
const MAX_POLLS = Number(process.env.GLIDLY_POLLS ?? 1800); // ~3h at 6s
const LEDGER = path.join(path.resolve(config.dataDir), 'speed-ledger.jsonl');
const reader = new JustLendReader();

interface O { key: string; renter: string; receiver: string; resourceType: number }

function log(m: string): void { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }
function rec(e: Record<string, unknown>): void { fs.appendFileSync(LEDGER, JSON.stringify(e) + '\n'); }

async function pmap<T>(items: T[], conc: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } };
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
}

// Build a FRESH open-order list directly from on-chain events (chunked, no stale file dependency).
async function buildOrders(): Promise<O[]> {
  const DAYS = Number(process.env.GLIDLY_BACKFILL_DAYS ?? 35);
  const CHUNK = 3 * 24 * 3_600_000;
  const now = Date.now();
  const open = new Map<string, O>();
  type E = { kind: 'rent' | 'rm'; ts: number; bn: number; ei: number; r: Record<string, string | undefined> };
  for (let lo = now - DAYS * 24 * 3_600_000; lo < now; lo += CHUNK) {
    const hi = Math.min(lo + CHUNK, now);
    const rents = await reader.fetchRentEvents(lo, hi);
    const returns = await reader.fetchReturnEvents(lo, hi);
    const liqs = await reader.fetchLiquidateEvents(lo, hi);
    const evs: E[] = [];
    for (const e of rents) evs.push({ kind: 'rent', ts: e.block_timestamp, bn: e.block_number, ei: e.event_index, r: e.result });
    for (const e of returns) evs.push({ kind: 'rm', ts: e.block_timestamp, bn: e.block_number, ei: e.event_index, r: e.result });
    for (const e of liqs) evs.push({ kind: 'rm', ts: e.block_timestamp, bn: e.block_number, ei: e.event_index, r: e.result });
    evs.sort((a, b) => a.ts - b.ts || a.bn - b.bn || a.ei - b.ei);
    for (const e of evs) {
      const k = orderKey(e.r.renter ?? '', e.r.receiver ?? '', e.r.resourceType ?? '0');
      if (e.kind === 'rent') { if (e.r.amount) open.set(k, { key: k, renter: e.r.renter as string, receiver: e.r.receiver as string, resourceType: Number(e.r.resourceType) }); }
      else open.delete(k);
    }
    log(`  backfill ${new Date(lo).toISOString().slice(0, 10)} → open=${open.size}`);
  }
  return [...open.values()];
}

async function main(): Promise<void> {
  log('SPEED TEST — building fresh order list from chain…');
  let orders = await buildOrders();
  log(`SPEED TEST — polling ${orders.length} orders every ${POLL_MS / 1000}s (parallel ${CONC}). Measuring true sit-times.`);
  const grabbable = new Map<string, { firstAt: number; reward: number; energy: number | null }>();
  const seenLiq = new Set<string>();
  const sits: { key: string; sitMs: number; reward: number; by: string }[] = [];
  let fastMisses = 0; // grabbed before we ever saw it grabbable (< poll resolution)
  let lastLiqTs = Date.now() - 180_000;

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    let chainNow: number;
    try {
      chainNow = await reader.nowChainMs();
    } catch {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    // 1) detect grabs (Liquidate events) — stop the stopwatch.
    try {
      const liqs = await reader.fetchLiquidateEvents(lastLiqTs - 120_000);
      for (const e of liqs) {
        const id = `${e.transaction_id}:${e.event_index}`;
        if (seenLiq.has(id)) continue;
        seenLiq.add(id);
        const key = orderKey(e.result.renter, e.result.receiver, e.result.resourceType);
        const reward = sunToTrx(BigInt(e.result.liquidateFee || '0'));
        const by = eventAddrToBase58(e.result.liquidator).slice(0, 10);
        const g = grabbable.get(key);
        if (g) {
          const sitMs = e.block_timestamp - g.firstAt;
          sits.push({ key, sitMs, reward, by });
          log(`✅ MEASURED: ${key.slice(0, 8)}… sat grabbable ${(sitMs / 1000).toFixed(0)}s, then ${by} took it (${reward.toFixed(0)} TRX)`);
          rec({ ts: Date.now(), type: 'measured', key, sitSec: sitMs / 1000, reward, by });
          grabbable.delete(key);
        } else {
          fastMisses += 1;
          log(`⚡ ${by} took ${key.slice(0, 8)}… (${reward.toFixed(0)} TRX) — grabbed faster than ${POLL_MS / 1000}s poll could see`);
          rec({ ts: Date.now(), type: 'fast_miss', key, reward, by, pollSec: POLL_MS / 1000 });
        }
      }
      lastLiqTs = chainNow;
    } catch { /* keep going */ }

    // 2) parallel sim sweep — start the stopwatch on anything newly grabbable.
    let grabNow = 0;
    await pmap(orders, CONC, async (o) => {
      const sim = await reader.simulateLiquidate(o.renter, o.receiver, o.resourceType);
      if (sim.ok) {
        grabNow += 1;
        if (!grabbable.has(o.key)) {
          grabbable.set(o.key, { firstAt: chainNow, reward: sim.rewardTrx, energy: sim.energyUsed });
          log(`🟢 GRABBABLE ${o.key.slice(0, 8)}… reward ${sim.rewardTrx.toFixed(0)} TRX — stopwatch started`);
          rec({ ts: Date.now(), type: 'grabbable_start', key: o.key, reward: sim.rewardTrx });
        }
      } else if (sim.reason && /reward|revert|liquidatable/i.test(sim.reason)) {
        grabbable.delete(o.key); // genuinely not grabbable (don't delete on network errors)
      }
    });

    // Add newly-rented orders during the run so we don't miss fresh ones.
    if (poll % 20 === 0) {
      try {
        const fresh = await reader.fetchRentEvents(Date.now() - 45 * 60 * 1000);
        const known = new Set(orders.map((o) => o.key));
        for (const e of fresh) {
          const k = orderKey(e.result.renter, e.result.receiver, e.result.resourceType);
          if (!known.has(k) && e.result.amount) { orders.push({ key: k, renter: e.result.renter, receiver: e.result.receiver, resourceType: Number(e.result.resourceType) }); known.add(k); }
        }
      } catch { /* keep */ }
    }

    const med = sits.length ? [...sits].map((s) => s.sitMs).sort((a, b) => a - b)[Math.floor(sits.length / 2)] / 1000 : null;
    if (poll % 5 === 0 || grabNow > 0) {
      log(`poll#${poll} orders=${orders.length} grabbableNow=${grabNow} | measured=${sits.length}${med !== null ? ` medianSit=${med.toFixed(0)}s` : ''} fastMisses(<${POLL_MS / 1000}s)=${fastMisses}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const arr = sits.map((s) => s.sitMs / 1000).sort((a, b) => a - b);
  log(`\n──── FINAL ──── measured ${arr.length} sit-times, ${fastMisses} too-fast-to-see (<${POLL_MS / 1000}s)`);
  if (arr.length) log(`  sit-times(s): ${arr.map((x) => x.toFixed(0)).join(', ')}  | median ${arr[Math.floor(arr.length / 2)].toFixed(0)}s`);
}
main().catch((e) => console.error('fatal:', e instanceof Error ? e.message : e));
