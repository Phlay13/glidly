// Glidly MONITOR — model-free detection. The previous version used a (broken) prediction to
// decide which orders to check, so it missed crossings. This version asks the REAL contract:
// it rotates through every open order and runs the liquidate() simulation (ground truth). The
// instant the contract says an order is grabbable, it starts the clock; when an opponent takes
// it (on-chain Liquidate event), it records the true sit-time. No prediction anywhere.
//
// Order list is still event-driven (chain-time cursor + lag overlap + dedup + chronological +
// chunked backfill). Detection and sit-time are 100% contract-confirmed facts.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { JustLendReader, eventAddrToBase58, orderKey } from './justlend.js';
import { sunToTrx } from './tron.js';

const INTERVAL_MS = Number(process.env.GLIDLY_MONITOR_INTERVAL_MS ?? 90_000);
const MAX_CYCLES = Number(process.env.GLIDLY_MONITOR_CYCLES ?? 0);
const BACKFILL_DAYS = Number(process.env.GLIDLY_BACKFILL_DAYS ?? 35);
const CHUNK_DAYS = Number(process.env.GLIDLY_CHUNK_DAYS ?? 3);
const SIM_BATCH = Number(process.env.GLIDLY_SIM_BATCH ?? 70); // orders sim-checked per cycle (round-robin)
const CONFIRMATION_LAG_MS = 90_000;
const EVENT_OVERLAP_MS = 180_000;
const RENT_TRX_PER_1K = Number(process.env.GLIDLY_RENT_TRX_PER_1K ?? 0.055);
const RENT_MIN_TRX = Number(process.env.GLIDLY_RENT_MIN_TRX ?? 1);
const MIN_NET_TRX = Number(process.env.GLIDLY_MIN_NET_TRX ?? 3);
const SIT_CAP = 300;
const DATA_DIR = path.resolve(config.dataDir);
const LEDGER = path.join(DATA_DIR, 'monitor-ledger.jsonl');
const STATE = path.join(DATA_DIR, 'monitor-state.json');

function rentCostTrx(energy: number | null): number {
  const e = energy && energy > 0 ? energy : 230_000;
  return Math.max(RENT_MIN_TRX, (e / 1000) * RENT_TRX_PER_1K);
}
function log(m: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
}
function ledger(e: Record<string, unknown>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify(e) + '\n');
}
function dur(ms: number): string {
  const m = ms / 60000;
  return Math.abs(m) < 90 ? `${m.toFixed(0)}m` : `${(m / 60).toFixed(1)}h`;
}

interface Order { key: string; renter: string; receiver: string; resourceType: number }
interface Ripe { rewardTrx: number; energy: number | null; firstAt: number }
type EvKind = 'rent' | 'return' | 'liq';
interface Ev { kind: EvKind; ts: number; bn: number; ei: number; id: string; result: Record<string, string | undefined> }

class Monitor {
  private reader = new JustLendReader();
  private orders = new Map<string, Order>();
  private ripeNow = new Map<string, Ripe>(); // contract-confirmed grabbable, with first-seen time
  private seen = new Map<string, number>();
  private sitTimes: number[] = [];
  private cursorChainTs = 0;
  private rotateIdx = 0;
  private replaying = false;

  async start(): Promise<void> {
    log(`Glidly MONITOR — model-free (rotating sim). interval=${INTERVAL_MS / 1000}s batch=${SIM_BATCH} minNet=${MIN_NET_TRX} TRX`);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.bootstrap();
        break;
      } catch (e) {
        log(`bootstrap attempt ${attempt} failed: ${(e as Error).message} — retrying in 30s`);
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
    let c = 0;
    for (;;) {
      try {
        await this.cycle();
      } catch (e) {
        log(`cycle error: ${(e as Error).message}`);
      }
      if (MAX_CYCLES && ++c >= MAX_CYCLES) break;
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }

  // ---- events ----
  private mergeSorted(rents: { block_number: number; block_timestamp: number; event_index: number; transaction_id: string; result: Record<string, string | undefined> }[], returns: typeof rents, liqs: typeof rents): Ev[] {
    const evs: Ev[] = [];
    const push = (kind: EvKind, arr: typeof rents) => {
      for (const e of arr) evs.push({ kind, ts: e.block_timestamp, bn: e.block_number, ei: e.event_index, id: `${e.transaction_id}:${e.event_index}`, result: e.result });
    };
    push('rent', rents); push('return', returns); push('liq', liqs);
    return evs.sort((a, b) => a.ts - b.ts || a.bn - b.bn || a.ei - b.ei);
  }

  private applyEvent(ev: Ev): void {
    const r = ev.result;
    const key = orderKey(r.renter ?? '', r.receiver ?? '', r.resourceType ?? '0');
    if (ev.kind === 'rent') {
      if (!r.amount) return;
      if (!this.orders.has(key)) this.orders.set(key, { key, renter: r.renter as string, receiver: r.receiver as string, resourceType: Number(r.resourceType) });
    } else if (ev.kind === 'return') {
      this.orders.delete(key);
      this.ripeNow.delete(key);
    } else {
      const reward = sunToTrx(BigInt(r.liquidateFee || '0'));
      const who = eventAddrToBase58(r.liquidator);
      const rp = this.ripeNow.get(key);
      if (rp) {
        const sat = ev.ts - rp.firstAt;
        this.sitTimes.push(sat);
        if (this.sitTimes.length > SIT_CAP) this.sitTimes.shift();
        if (!this.replaying) {
          log(`🏁 TAKEN by ${who.slice(0, 10)} — sat grabbable ≥${dur(sat)} · reward ${reward.toFixed(0)} TRX`);
          ledger({ ts: Date.now(), type: 'taken', key, reward, satMsSinceConfirmed: sat, takenBy: who });
        }
      } else if (!this.replaying) {
        log(`🏁 TAKEN by ${who.slice(0, 10)} · reward ${reward.toFixed(0)} TRX (we hadn't sim-confirmed it grabbable yet)`);
        ledger({ ts: Date.now(), type: 'taken_unconfirmed', key, reward, takenBy: who });
      }
      this.orders.delete(key);
      this.ripeNow.delete(key);
    }
  }

  private ingest(evs: Ev[]): void {
    for (const ev of evs) {
      if (this.seen.has(ev.id)) continue;
      this.seen.set(ev.id, ev.ts);
      this.applyEvent(ev);
    }
  }
  private pruneSeen(before: number): void {
    for (const [id, ts] of this.seen) if (ts < before) this.seen.delete(id);
  }

  private async backfill(minTs: number, maxTs: number): Promise<void> {
    const chunk = CHUNK_DAYS * 24 * 3_600_000;
    for (let lo = minTs; lo < maxTs; lo += chunk) {
      const hi = Math.min(lo + chunk, maxTs);
      const rents = await this.reader.fetchRentEvents(lo, hi);
      const returns = await this.reader.fetchReturnEvents(lo, hi);
      const liqs = await this.reader.fetchLiquidateEvents(lo, hi);
      this.ingest(this.mergeSorted(rents, returns, liqs));
      log(`  chunk ${new Date(lo).toISOString().slice(0, 10)}: rent=${rents.length} ret=${returns.length} liq=${liqs.length} → open=${this.orders.size}`);
    }
  }

  // ---- persistence ----
  private saveState(): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({
      cursorChainTs: this.cursorChainTs,
      rotateIdx: this.rotateIdx,
      sitTimes: this.sitTimes,
      ripeNow: Object.fromEntries(this.ripeNow),
      orders: [...this.orders.values()],
    }));
  }
  private loadState(chainNow: number): boolean {
    if (!fs.existsSync(STATE)) return false;
    try {
      const p = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      if (typeof p.cursorChainTs !== 'number' || chainNow - p.cursorChainTs > 2 * 24 * 3_600_000) return false;
      this.cursorChainTs = p.cursorChainTs;
      this.rotateIdx = p.rotateIdx ?? 0;
      this.sitTimes = p.sitTimes ?? [];
      this.ripeNow = new Map(Object.entries(p.ripeNow ?? {}) as [string, Ripe][]);
      for (const o of p.orders ?? []) this.orders.set(o.key, o);
      return true;
    } catch {
      return false;
    }
  }

  private async bootstrap(): Promise<void> {
    const chainNow = await this.reader.nowChainMs();
    if (this.loadState(chainNow)) {
      log(`resumed: ${this.orders.size} orders, ${this.ripeNow.size} already grabbable (no re-backfill).`);
      return;
    }
    const minTs = chainNow - BACKFILL_DAYS * 24 * 3_600_000;
    log(`fresh start — chunked ${BACKFILL_DAYS}d backfill…`);
    this.replaying = true;
    await this.backfill(minTs, chainNow);
    this.replaying = false;
    this.cursorChainTs = chainNow - CONFIRMATION_LAG_MS;
    this.saveState();
    log(`tracking ${this.orders.size} open orders.`);
  }

  // ---- cycle: events + rotating model-free sim detection ----
  private async cycle(): Promise<void> {
    const chainNow = await this.reader.nowChainMs();
    const since = Math.min(this.cursorChainTs, chainNow - CONFIRMATION_LAG_MS) - EVENT_OVERLAP_MS;
    const rents = await this.reader.fetchRentEvents(since);
    const returns = await this.reader.fetchReturnEvents(since);
    const liqs = await this.reader.fetchLiquidateEvents(since);
    this.ingest(this.mergeSorted(rents, returns, liqs));
    this.cursorChainTs = chainNow - CONFIRMATION_LAG_MS;
    this.pruneSeen(since - 60_000);

    // Rotating sim sweep — ask the contract directly, no prediction.
    const keys = [...this.orders.keys()];
    let sims = 0;
    let errs = 0;
    let newlyRipe = 0;
    const n = Math.min(SIM_BATCH, keys.length);
    for (let i = 0; i < n; i += 1) {
      const o = this.orders.get(keys[(this.rotateIdx + i) % keys.length]);
      if (!o) continue;
      let sim;
      try {
        sim = await this.reader.simulateLiquidate(o.renter, o.receiver, o.resourceType);
      } catch {
        errs += 1;
        continue;
      }
      sims += 1;
      if (sim.reason === 'empty-result-retry') continue; // ambiguous, recheck next sweep
      if (sim.ok) {
        if (!this.ripeNow.has(o.key)) {
          newlyRipe += 1;
          this.ripeNow.set(o.key, { rewardTrx: sim.rewardTrx, energy: sim.energyUsed, firstAt: chainNow });
          const net = sim.rewardTrx - rentCostTrx(sim.energyUsed);
          log(`🟢 GRABBABLE ${o.key.slice(0, 12)}… reward=${sim.rewardTrx.toFixed(0)} energy=${sim.energyUsed ?? '?'} net=${net >= 0 ? '+' : ''}${net.toFixed(1)} TRX ${net >= MIN_NET_TRX ? 'FIRE ✓' : 'skip'}`);
          ledger({ ts: Date.now(), type: 'grabbable', key: o.key, rewardTrx: sim.rewardTrx, energy: sim.energyUsed, netTrx: net, firstAt: chainNow });
        } else {
          const r = this.ripeNow.get(o.key) as Ripe;
          r.rewardTrx = sim.rewardTrx; r.energy = sim.energyUsed;
        }
      } else {
        this.ripeNow.delete(o.key); // no longer grabbable (returned/topped up)
      }
    }
    this.rotateIdx = keys.length ? (this.rotateIdx + n) % keys.length : 0;

    // Report: everything currently grabbable (contract-confirmed) + how long it's sat.
    const grab = [...this.ripeNow.entries()].map(([k, r]) => ({ k, ...r, net: r.rewardTrx - rentCostTrx(r.energy), sat: chainNow - r.firstAt })).sort((a, b) => b.net - a.net);
    log(`──── GRABBABLE NOW (contract-confirmed): ${grab.length} ────`);
    for (const g of grab.slice(0, 12)) log(`   ${g.k.slice(0, 12)}… reward=${g.rewardTrx.toFixed(0)} net=${g.net >= 0 ? '+' : ''}${g.net.toFixed(1)} TRX ${g.net >= MIN_NET_TRX ? 'FIRE✓' : 'skip'} sat≥${dur(g.sat)}`);
    const med = this.sitTimes.length ? [...this.sitTimes].sort((a, b) => a - b)[Math.floor(this.sitTimes.length / 2)] : null;
    log(`open=${this.orders.size} swept=${sims}/${keys.length} (idx${this.rotateIdx}) newGrab=${newlyRipe} errs=${errs} | taken=${this.sitTimes.length} medianSit=${med !== null ? dur(med) : 'n/a'}`);
    this.saveState();
  }
}

new Monitor().start().catch((e) => {
  console.error('fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
