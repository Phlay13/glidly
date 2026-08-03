// Glidly SWEEPER — the real bot loop. Default PAPER mode (no broadcast): it does exactly what
// the live bot will do (index orders → predict liquidatable time → confirm liquidatable-now →
// "fire"), but writes intentions to a ledger instead of sending a transaction. Flip EXEC_ENABLED
// to go live later (broadcast path is stubbed until seed capital + key are in place).
//
// Strategy (validated): not a race, a sweep. Catch orders promptly as they cross the
// liquidation boundary and beat the slow incumbents (who show up hours later).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { JustLendReader, eventAddrToBase58, orderKey, type MarketParams } from './justlend.js';
import { predictLiquidatableAt, type OrderSnapshot } from './predictor.js';
import { sunToTrx } from './tron.js';

const EXEC_ENABLED = (process.env.EXEC_ENABLED ?? 'false').toLowerCase() === 'true';
const INTERVAL_MS = Number(process.env.GLIDLY_SWEEP_INTERVAL_MS ?? 60_000);
const MAX_CYCLES = Number(process.env.GLIDLY_SWEEP_CYCLES ?? 0); // 0 = run forever
const CONFIRM_BUDGET = Number(process.env.GLIDLY_CONFIRM_BUDGET ?? 12); // sims per cycle (RPC budget)
// JustLend caps rentals at 30 days, so ~35 days of backfill captures EVERY currently-open order.
const BACKFILL_DAYS = Number(process.env.GLIDLY_BACKFILL_DAYS ?? 35);
// Real energy-rent rate from TronCastle quote (2026-06-26): 250k=13.75 TRX/1h ⇒ 0.055 TRX per 1k energy.
const RENT_TRX_PER_1K = Number(process.env.GLIDLY_RENT_TRX_PER_1K ?? 0.055);
const RENT_MIN_TRX = Number(process.env.GLIDLY_RENT_MIN_TRX ?? 1);
const MIN_NET_TRX = Number(process.env.GLIDLY_MIN_NET_TRX ?? 3);
const WHALE_LOG_TRX = Number(process.env.GLIDLY_WHALE_LOG_TRX ?? 100); // log return/liq of orders >= this reward
// Highlight specific orders by address prefix (e.g. GLIDLY_WATCH=0xd77656,0xea2748 for snapshot row 1).
const WATCH = (process.env.GLIDLY_WATCH ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const LEDGER = path.join(path.resolve(config.dataDir), 'sweeper-ledger.jsonl');

/** Cost to rent the energy a single liquidation needs (null energy ⇒ assume worst-case 230k). */
function rentCostTrx(energyUsed: number | null): number {
  const energy = energyUsed && energyUsed > 0 ? energyUsed : 230_000;
  return Math.max(RENT_MIN_TRX, (energy / 1000) * RENT_TRX_PER_1K);
}

interface Order {
  key: string;
  renter: string;
  receiver: string;
  resourceType: number;
  amountSun: bigint;
  depositSun: bigint;
  rentIndex: bigint;
  snapshotAtMs: number;
  predictedAtMs: number | null;
  rewardTrx: number;
  watched: boolean;
  fired: boolean;
  firedAtMs?: number;
  snoozeUntilMs?: number; // thin-net orders get re-checked later (reward grows over time)
}

function isWatched(renter: string, receiver: string): boolean {
  if (WATCH.length === 0) return false;
  const r = renter.toLowerCase();
  const c = receiver.toLowerCase();
  return WATCH.some((p) => r.startsWith(p) || c.startsWith(p));
}
function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
function appendLedger(entry: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify(entry) + '\n');
}
function fmtEta(ms: number): string {
  const m = ms / 60000;
  if (m < 90) return `${m.toFixed(0)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

class Sweeper {
  private reader = new JustLendReader();
  private orders = new Map<string, Order>();
  private mp: MarketParams | null = null;
  private mpAt = 0;
  private cursorTs = 0;
  private paperFires = 0;
  private wouldWin = 0;
  private lost = 0;
  private liqSeen = 0; // every liquidation we observe on-chain
  private liqUnseen = 0; // liquidations of orders we never indexed (coverage gaps)

  async start(): Promise<void> {
    log(`Glidly sweeper — mode=${EXEC_ENABLED ? 'LIVE' : 'PAPER'} interval=${INTERVAL_MS / 1000}s backfill=${BACKFILL_DAYS}d watch=[${WATCH.join(',') || 'none'}]`);
    if (EXEC_ENABLED) log('LIVE requested but broadcast path not enabled yet (needs seed + key). Staying safe.');
    // Free RPCs (TronGrid) rate-limit and time out sporadically — never die on bootstrap, retry.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.bootstrap();
        break;
      } catch (e) {
        const wait = Math.min(attempt * 30, 300);
        log(`bootstrap failed (attempt ${attempt}): ${(e as Error).message} — retrying in ${wait}s`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
    let cycle = 0;
    for (;;) {
      try {
        await this.cycle();
      } catch (e) {
        log(`cycle error: ${(e as Error).message}`);
      }
      cycle += 1;
      if (MAX_CYCLES && cycle >= MAX_CYCLES) break;
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
    log(`done. paperFires=${this.paperFires} wouldWin=${this.wouldWin} lost=${this.lost} liqSeen=${this.liqSeen} liqUnseen=${this.liqUnseen}`);
  }

  private async marketParams(): Promise<MarketParams> {
    if (!this.mp || Date.now() - this.mpAt > 60_000) {
      this.mp = await this.reader.getMarketParams();
      this.mpAt = Date.now();
    }
    return this.mp;
  }

  private predict(o: Order, mp: MarketParams, nowMs: number): void {
    const mpOrder: MarketParams = { ...mp, globalRentIndex: o.rentIndex, globalRentUpdatedAt: Math.floor(o.snapshotAtMs / 1000) };
    const snap: OrderSnapshot = { amountSun: o.amountSun, depositSun: o.depositSun, rentIndex: o.rentIndex, snapshotAtMs: o.snapshotAtMs };
    const cttl = predictLiquidatableAt(snap, mpOrder, nowMs);
    o.predictedAtMs = cttl?.predictedLiquidatableAtMs ?? null;
    o.rewardTrx = cttl?.rewardTrx ?? 0;
  }

  private async bootstrap(): Promise<void> {
    const mp = await this.marketParams();
    const minTs = Date.now() - BACKFILL_DAYS * 24 * 3_600_000;
    log(`backfilling ${BACKFILL_DAYS} days of events…`);
    const [rents, returns, liqs] = await Promise.all([
      this.reader.fetchRentEvents(minTs),
      this.reader.fetchReturnEvents(minTs),
      this.reader.fetchLiquidateEvents(minTs),
    ]);
    log(`  fetched rent=${rents.length} return=${returns.length} liq=${liqs.length}`);
    const { firedKeys, scoredKeys } = this.rehydrateFromLedger();
    for (const e of rents) this.upsert(e.result, e.block_timestamp);
    for (const e of returns) this.orders.delete(orderKey(e.result.renter, e.result.receiver, e.result.resourceType));
    for (const e of liqs) {
      const key = orderKey(e.result.renter, e.result.receiver, e.result.resourceType);
      // Score liquidations of orders we fired at in a PREVIOUS run (offline would-wins).
      if (firedKeys.has(key) && !scoredKeys.has(key)) {
        const rewardTrx = sunToTrx(BigInt(e.result.liquidateFee || '0'));
        const who = eventAddrToBase58(e.result.liquidator);
        this.wouldWin += 1;
        this.liqSeen += 1;
        log(`✓ WOULD-WIN (offline): fired ${key.slice(0, 10)}… earlier run, taken by ${who.slice(0, 8)} while we were down (reward ${rewardTrx.toFixed(0)} TRX)`);
        appendLedger({ ts: Date.now(), type: 'would_win', key, rewardTrx, firedAtMs: firedKeys.get(key), takenAtMs: e.block_timestamp, takenBy: who, offline: true });
      }
      this.orders.delete(key);
    }
    // Restore fired flags on orders still open from previous runs.
    for (const [key, firedAtMs] of firedKeys) {
      const o = this.orders.get(key);
      if (o) { o.fired = true; o.firedAtMs = firedAtMs; }
    }
    const now = Date.now();
    for (const o of this.orders.values()) this.predict(o, mp, now);
    this.cursorTs = now;
    log(`bootstrap: tracking ${this.orders.size} open orders`);
    this.printUpcoming(now, 10);
  }

  /** Restore fired flags + score counters from the ledger so restarts (e.g. GitHub Actions runs)
   *  never double-fire an order or lose the running paper score. */
  private rehydrateFromLedger(): { firedKeys: Map<string, number>; scoredKeys: Set<string> } {
    const firedKeys = new Map<string, number>();
    const scoredKeys = new Set<string>();
    if (!fs.existsSync(LEDGER)) return { firedKeys, scoredKeys };
    const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let e: Record<string, unknown>;
      try { e = JSON.parse(line); } catch { continue; }
      const type = e.type as string;
      const key = e.key as string;
      if (type === 'paper_fire' || type === 'live_fire') {
        this.paperFires += 1;
        firedKeys.set(key, (e.ts as number) ?? 0);
      } else if (type === 'would_win') { this.wouldWin += 1; scoredKeys.add(key); }
      else if (type === 'missed') { this.lost += 1; scoredKeys.add(key); }
      else if (type === 'unseen_liq') { this.liqUnseen += 1; scoredKeys.add(key); }
    }
    this.liqSeen = this.wouldWin + this.lost + this.liqUnseen;
    log(`ledger rehydrate: ${lines.length} entries → fires=${this.paperFires} win=${this.wouldWin} lost=${this.lost} unseen=${this.liqUnseen}`);
    return { firedKeys, scoredKeys };
  }

  private upsert(r: { renter: string; receiver: string; resourceType: string; amount?: string; securityDeposit?: string; rentIndex?: string }, ts: number): void {
    if (r.securityDeposit === undefined || r.rentIndex === undefined || r.amount === undefined) return;
    const key = orderKey(r.renter, r.receiver, r.resourceType);
    this.orders.set(key, {
      key,
      renter: r.renter,
      receiver: r.receiver,
      resourceType: Number(r.resourceType),
      amountSun: BigInt(r.amount),
      depositSun: BigInt(r.securityDeposit),
      rentIndex: BigInt(r.rentIndex),
      snapshotAtMs: ts,
      predictedAtMs: null,
      rewardTrx: 0,
      watched: isWatched(r.renter, r.receiver),
      fired: false,
    });
  }

  private async cycle(): Promise<void> {
    const mp = await this.marketParams();
    const since = this.cursorTs - 5_000;
    const [rents, returns, liqs] = await Promise.all([
      this.reader.fetchRentEvents(since),
      this.reader.fetchReturnEvents(since),
      this.reader.fetchLiquidateEvents(since),
    ]);
    for (const e of rents) this.upsert(e.result, e.block_timestamp);

    // Liquidations — score tracked ones, and NEVER stay blind to untracked ones.
    for (const e of liqs) {
      this.liqSeen += 1;
      const key = orderKey(e.result.renter, e.result.receiver, e.result.resourceType);
      const rewardTrx = sunToTrx(BigInt(e.result.liquidateFee || '0'));
      const who = eventAddrToBase58(e.result.liquidator);
      const o = this.orders.get(key);
      if (o) {
        if (o.fired) {
          this.wouldWin += 1;
          log(`✓ WOULD-WIN: fired ${key.slice(0, 10)}… ${((e.block_timestamp - (o.firedAtMs ?? 0)) / 1000).toFixed(0)}s before ${who.slice(0, 8)} (reward ${rewardTrx.toFixed(0)} TRX)`);
          appendLedger({ ts: Date.now(), type: 'would_win', key, rewardTrx, firedAtMs: o.firedAtMs, takenAtMs: e.block_timestamp, takenBy: who });
        } else {
          this.lost += 1;
          log(`✗ MISSED: ${who.slice(0, 8)} took ${key.slice(0, 10)}… (reward ${rewardTrx.toFixed(0)} TRX, we hadn't fired)`);
          appendLedger({ ts: Date.now(), type: 'missed', key, rewardTrx, takenAtMs: e.block_timestamp, takenBy: who, watched: o.watched });
        }
        this.orders.delete(key);
      } else {
        // Liquidation of an order we never indexed — log it so we're never backfill-blind.
        this.liqUnseen += 1;
        log(`👁 UNSEEN LIQ: ${who.slice(0, 8)} took ${key.slice(0, 10)}… reward ${rewardTrx.toFixed(0)} TRX (not in our index)`);
        appendLedger({ ts: Date.now(), type: 'unseen_liq', key, rewardTrx, takenAtMs: e.block_timestamp, takenBy: who });
      }
    }

    // Returns — observe whale/ watched orders being returned (the "they return, not liquidate" test).
    for (const e of returns) {
      const key = orderKey(e.result.renter, e.result.receiver, e.result.resourceType);
      const o = this.orders.get(key);
      if (o && (o.watched || o.rewardTrx >= WHALE_LOG_TRX)) {
        log(`↩ RETURNED${o.watched ? ' [WATCHED]' : ''}: ${key.slice(0, 10)}… (would-be reward ${o.rewardTrx.toFixed(0)} TRX) — renter reclaimed, NOT liquidated`);
        appendLedger({ ts: Date.now(), type: 'returned', key, wouldBeRewardTrx: o.rewardTrx, watched: o.watched });
      }
      if (o) this.orders.delete(key);
    }

    const now = Date.now();
    for (const o of this.orders.values()) if (!o.fired) this.predict(o, mp, now);

    // Confirm + fire on liquidatable-now orders (highest reward first), within RPC budget.
    const ripe = [...this.orders.values()]
      .filter((o) => !o.fired && o.predictedAtMs !== null && o.predictedAtMs <= now + 1500 && (!o.snoozeUntilMs || o.snoozeUntilMs <= now))
      .sort((a, b) => b.rewardTrx - a.rewardTrx)
      .slice(0, CONFIRM_BUDGET);

    for (const o of ripe) {
      const sim = await this.reader.simulateLiquidate(o.renter, o.receiver, o.resourceType);
      if (!sim.ok) continue;
      const rent = rentCostTrx(sim.energyUsed);
      const net = sim.rewardTrx - rent;
      if (net < MIN_NET_TRX) {
        // Don't bury it forever — the reward grows as the deposit keeps draining. Re-check in 1h.
        o.snoozeUntilMs = now + 3_600_000;
        log(`⏭  snooze 1h ${o.key.slice(0, 10)}… reward=${sim.rewardTrx.toFixed(0)} energy=${sim.energyUsed ?? '?'} rent≈${rent.toFixed(1)} net≈${net.toFixed(1)} (<${MIN_NET_TRX})`);
        continue;
      }
      o.fired = true;
      o.firedAtMs = now;
      this.paperFires += 1;
      log(`${EXEC_ENABLED ? '🔫 LIVE-FIRE' : '📝 PAPER-FIRE'}${o.watched ? ' [WATCHED]' : ''} ${o.key.slice(0, 10)}… reward=${sim.rewardTrx.toFixed(0)} energy=${sim.energyUsed ?? '?'} rent≈${rent.toFixed(1)} net≈${net.toFixed(1)} TRX`);
      appendLedger({ ts: now, type: EXEC_ENABLED ? 'live_fire' : 'paper_fire', key: o.key, rewardTrx: sim.rewardTrx, energyUsed: sim.energyUsed, rentTrx: rent, netTrx: net, watched: o.watched });
    }

    this.cursorTs = now;
    this.heartbeat(now);
  }

  private printUpcoming(now: number, n: number): void {
    const up = [...this.orders.values()]
      .filter((o) => o.predictedAtMs !== null && (o.predictedAtMs as number) > now)
      .sort((a, b) => (a.predictedAtMs as number) - (b.predictedAtMs as number))
      .slice(0, n);
    log(`Top ${up.length} upcoming liquidations (predicted):`);
    for (const o of up) {
      const eta = fmtEta((o.predictedAtMs as number) - now);
      const net = o.rewardTrx - rentCostTrx(null);
      log(`   ETA ${eta.padStart(6)}  ${o.renter.slice(0, 8)}…→${o.receiver.slice(0, 8)}…  reward ${o.rewardTrx.toFixed(0)} TRX  net~${net.toFixed(0)}${o.watched ? '  [WATCHED]' : ''}`);
    }
  }

  private heartbeat(now: number): void {
    const upcoming = [...this.orders.values()].filter((o) => o.predictedAtMs !== null).sort((a, b) => (a.predictedAtMs as number) - (b.predictedAtMs as number));
    const soon = upcoming.filter((o) => (o.predictedAtMs as number) - now < 3_600_000).length;
    const next = upcoming.find((o) => (o.predictedAtMs as number) > now);
    const nextEta = next ? `${fmtEta((next.predictedAtMs as number) - now)} (${next.rewardTrx.toFixed(0)} TRX)` : 'none';
    log(`watch=${this.orders.size} ripe<1h=${soon} next=${nextEta} | fires=${this.paperFires} win=${this.wouldWin} lost=${this.lost} liqSeen=${this.liqSeen} unseen=${this.liqUnseen}`);
  }
}

new Sweeper().start().catch((e) => {
  console.error('fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
