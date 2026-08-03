# Glidly — JustLend Energy-Rental Liquidation Bot

> Successor to **G-1159**. Same market (energy-rental overdue liquidations), fundamentally
> different architecture. G-1159 lost money because it *rented energy per-attempt and reacted
> to the mempool*. Glidly *stakes energy (zero marginal cost) and pre-stages against known
> expiry timestamps.*

---

## 1. The market

When someone rents energy on JustLend and does **not** return it by its expiry, their
**Liquidation Penalty** is forfeited to whoever calls `liquidate()` first.

- **Contract:** `TU2MJ5Veik1LRAgjeSzEdvmDYx7mefJZvd` (JustLend Energy Rental)
- **Function:** `liquidate(address renter, address receiver, uint256 resourceType)` — `resourceType` 1 = energy
- **Reward:** `Liquidation Penalty = Max(EquivalentTRXDelegated × 0.008%, 20 TRX)`
  - Small orders → flat ~20 TRX floor (most frequent: ~15–20/day)
  - Whale orders → hundreds of TRX (rare: ~2/day, fiercely contested)
- **Trigger:** purely `now > expiryTimestamp`. **Deterministic and known in advance.**

### Why this matters
This is NOT a price-driven liquidation (lending markets). It is a **race against a stopwatch
you can already read**. The winning architecture is to *schedule* executions at known expiry
times and *pre-stage* the transaction — not to scan/react.

---

## 2. Why G-1159 failed (post-mortem, ranked)

1. **Paid per-attempt for energy (rented ~250k), then lost races / reverted.** On TRON a
   reverted tx still consumes energy. Renting ~250k energy can cost MORE than the 20 TRX reward
   even on a win. Every lost race = real loss. **This is the bleed.**
2. **No re-check at broadcast time** (`engine.ts:4256-4271`). Simulated once, broadcast
   500–1000ms later without re-confirming liquidatability or energy presence → reverted into
   already-taken positions.
3. **Reactive mempool watching** (`engine.ts:2700+`) detected competitors ~500ms *after* they
   hit the mempool; they'd pre-staged. Lost ~99% of contested races.
4. Stale energy/resource snapshot (refresh 2500ms) vs 500–1000ms build+broadcast window.
5. `feeLimit` was a 25 TRX *ceiling*, not a guarantee — reverts consumed fees with no refund.

---

## 3. The three architectural changes that flip the economics

1. **Stake energy, never rent per-attempt.** `freezeBalanceV2` once → daily regenerating energy
   budget → marginal cost per attempt ≈ 0. Set **`feeLimit = 0`** so any tx that *would* burn
   TRX simply fails to broadcast instead of costing money. **Losing a race now costs nothing.**
2. **Index by expiry, schedule executions.** Live index of all active orders + exact expiry
   timestamps from on-chain events. A *schedule*, not a scanner.
3. **Pre-stage + snipe.** Pre-build & pre-sign `liquidate()` before expiry; fire to multiple
   endpoints at the expiry block; final cheap on-chain re-check aborts if already taken.

---

## 4. The cold-start problem (must be solved explicitly)

- One `liquidate()` ≈ **130k–280k energy** (MEASURE in Phase 0, don't guess).
- At current ratio (~a few energy per staked TRX), 200k energy/day ≈ **tens of thousands of TRX
  staked** — not "a few."
- A 20 TRX win restaked ≈ ~120 energy. **Compounding through energy is weak at the bottom.**

**Three viable cold-start paths (Phase 0 decides which):**
- **(A) Threshold stake** — minimum stake covering ≥1 liq/day at zero marginal cost, then
  compound TRX and re-stake in meaningful chunks.
- **(B) Gated renting (first wins only)** — rent energy ONLY at a confirmed-win moment, enforce
  reward > rent, `feeLimit=0` so lost races can't burn TRX. Thin but non-negative.
- **(C) Hybrid** — small baseline stake + gated rent for overflow.

---

## 5. Phased build

### Phase 0 — Measure reality (READ-ONLY, zero capital) ⬅ START HERE
Replace every guess with a measured number.
- [ ] Index all active rental orders on `TU2MJ5...` via `rentResource` events + on-chain state; extract expiry timestamps.
- [ ] Measure ACTUAL energy cost of `liquidate()` (constant/simulate against a real liquidatable order, and/or decode receipts of past successful liquidations).
- [ ] Measure current energy-per-TRX-staked ratio from chain params.
- [ ] Pull historical liquidations (reuse G-1159 `data/justlend-winners.json`, `justlend-cache.historical.json`): win-timing (ms/blocks after expiry), reward distribution, frequency, top competitor addresses.
- [ ] Compute break-even stake threshold + pick cold-start path A/B/C.
- **Deliverable:** report/dashboard → GO / NO-GO with real numbers.

### Phase 1 — Resource foundation
- [ ] `freezeBalanceV2` staking flow + unstake/withdraw helpers.
- [ ] Live energy-budget tracker (exact available energy right now).
- [ ] `feeLimit=0` guardrail (txs that would burn TRX never broadcast).
- [ ] Minimum-viable-stake decided from Phase 0.

### Phase 2 — Expiry index + scheduler
- [ ] Continuously-updated order index from events.
- [ ] Expiry-sorted execution schedule.
- [ ] Per-order profitability filter (reward vs available energy vs competition tier).

### Phase 3 — Pre-stage + snipe execution
- [ ] Pre-build + pre-sign `liquidate()` for orders approaching expiry.
- [ ] Multi-endpoint parallel broadcast at expiry block.
- [ ] **Final cheap on-chain re-check (constant call) immediately before broadcast — abort if taken / not liquidatable.** (fixes the revert-bleed)
- [ ] Receipt confirmation + P&L accounting per attempt.

### Phase 4 — Compounding loop + ops
- [ ] Auto-restake profit above a working buffer.
- [ ] Win-rate + P&L ledger, alerting.
- [ ] Timing tuning (stage lead time, which endpoints win).

### Phase 5 (optional) — Wrapper contract
- [ ] Solidity wrapper: atomic liquidatability-check + liquidate, cheap revert if taken, energy-optimized. ONLY if Phase 3 shows reverts/energy still losing races.

---

## 6. Stack (fresh codebase, reuse proven G-1159 pieces only)
- TypeScript + Node 20, `tsx` dev runner.
- Reuse from G-1159: TRON client/RPC multiplexing, secp256k1 tx signing, contract ABI decoding — **rewritten clean**, not copied wholesale.
- New: staking module, expiry scheduler, pre-stage engine, P&L ledger.
- Guardrails first: `EXEC_ENABLED=false` default; `feeLimit=0`; observe mode in Phase 0.

## 7. Non-negotiable guardrails (lessons from G-1159)
- `feeLimit=0` on all liquidation txs — never burn TRX involuntarily.
- Always re-check liquidatability on-chain immediately before broadcast.
- Never rent energy except at a gated confirmed-win moment with reward > rent.
- Every attempt logged with full P&L (energy spent, reward, win/loss, latency).
- Default to observe/paper mode; live execution is an explicit opt-in flag.
