# Glidly — SENDOFF (read this first)

**What:** JustLend energy-rental liquidation bot. Successor to G-1159 (`C:\Users\Administrator\Desktop\G-1159`).

**Core thesis:** energy-rental liquidations trigger at a *known* expiry timestamp → it's a
speed race against a stopwatch you can read. Win by **staking energy (zero marginal cost)** and
**pre-staging** the tx against scheduled expiries — NOT renting per-attempt and reacting to the
mempool (that's what bled G-1159 dry).

**Full plan + post-mortem:** see `PLAN.md`.

## Status
- ✅ Research done (JustLend energy-rental mechanics, reward formula, contract `TU2MJ5Veik1LRAgjeSzEdvmDYx7mefJZvd`).
- ✅ G-1159 audited — root cause: rented energy per-attempt + no broadcast-time re-check + reactive mempool watching.
- ✅ Plan written (6 phases).
- ✅ Phase 0 BUILT + RUN (`src/phase0.ts`, `src/measure-receipts.ts`). Findings below.
- ⬜ Decision pending → then Phase 1.

## Phase 0 measured findings (24h window, run 2026-06-26)
- **Market:** 20 liquidations/day, ~577 TRX/day total pool. 16 floor(~20 TRX) + 4 whales (max 152 TRX).
- **Competition:** only 4 bots, all the SAME as G-1159's winners DB a month ago. TEFVYG takes 50% (372 TRX/day). Entrenched, no churn.
- **Real success-path energy (from 20 winning receipts):** median 96k, bimodal ~90k (optimized wrapper) vs ~230k (naive), max 230k. **All winners burned 0 TRX — they run on staked energy.**
- **Energy/TRX staked:** 9.49. → **Stake floor ~10k TRX** (one 96k slot) to **~24k TRX** (cover 230k worst case).
- **Cold-start dream is dead:** can't bootstrap from "a few TRX." Below ~10k TRX staked you BURN ~20–48 TRX/attempt to win ~20 TRX = structural loss (this is exactly why G-1159 bled).
- **Wrapper is mandatory, not optional:** TJ6's exact 90,530 energy = a wrapper. Without one you pay 96–230k and lose efficiency races. Phase 5 moves up.
- **Passive-yield benchmark:** ~10–24k TRX staked earns rental+voting yield passively; the bot must beat that to justify the effort/risk.

## Cold-start truth (resolved by Phase 0)
- Real liquidate() energy = ~96k median (90k wrapper / 230k naive), NOT the 250k G-1159 rented.
- Renting ~100k energy = only ~2.6 TRX/day (JustLend) or ~$1-2 (TronSave/feee.io markets).
- Per floor win: +20 TRX − ~2.6 TRX rent = ~+17 TRX net. Bootstrap rungs ARE positive.
- 7-day market: $263/day pool, 123 liqs, but DUOPOLY — TEFVYG 59% + TJ6 35% = 94%. ~13 floor/day.
- User has <10 TRX. Realistic seed to go live = ~$50-100 TRX. Unavoidable.

## VALIDATED FINDING (backtest + calibration, zero capital) — REFRAMES PROJECT
**It is NOT a millisecond race. It's a slow sweep.** Proven:
- Predictor timing vs on-chain liquidate() sim: **45/45 agree, 0 false-early** (boundary is exact).
- Backtest fee math: **100/100** match within 10% (reward formula calibrated).
- Backtest timing (100 scored liqs): winners struck a **median ~4 HOURS** after orders became
  liquidatable. 89/100 had a positive reaction window of minutes-to-hours.
- ⇒ Incumbents (TEFVYG/TJ6) are SLOW sweepers, not racers. G-1159's whole race/pre-stage/mempool
  architecture solved a non-problem. The gap: sweep promptly (every few min) and you beat people
  who show up every few hours. You only need 1-2 of ~13 floor orders/day.

## CHOSEN PATH (simpler than a racer — a reliable SWEEPER)
1. (DONE, $0) Proved opportunity real via backtest + calibration (src/backtest.ts, src/calibrate.ts).
2. (optional, $0) Forward paper-sweep for ~1 day to triple-confirm in real time.
3. Build live SWEEPER: loop every few min → predictor finds liquidatable-now orders → cheap
   constant-call re-check → liquidate with RENTED energy → feeLimit=0 guard.
   REAL RENT COST (from user's TronCastle quote 2026-06-26): 250k=13.75 TRX/1h, 20.63 TRX/1d
   = 0.055 TRX/1k energy (1h). So per liq: light 90k≈5.3 TRX, heavy 230k≈12.7 TRX.
   NET per floor win: light ~+15 TRX, heavy ~+6 TRX (thin), whales +30..+140 TRX.
   ⇒ Bot must RANK by net = reward − rentCost(energy); prefer light/high-reward, skip thin heavy-floor.
   Wrapper (230k→90k) is the margin lever. Needs seed ~$50-100 TRX (user has <$3).
   NOTE: earlier "~2.6 TRX / +17 TRX per win" was WRONG (bad web figure); corrected here.
4. Compound rent→stake at ~10k TRX; wrapper only if energy cost matters later. NO racing machinery.

## Remaining real risks (be honest)
- Seed capital (~$50-100) still required to rent energy + send txs.
- Why are incumbents slow? Likely 20 TRX isn't worth optimizing for them / batched cron. If a
  newcomer starts taking orders they MIGHT speed up — but even hourly cadence leaves gaps, and we
  only need 1-2/day.
- Selection bias: backtest only sees orders that WERE liquidated; ~11% were struck fast/contested.
  The ~89% that sit for hours are the target.

## Guardrails (non-negotiable)
- `feeLimit=0` on liq txs (never burn TRX involuntarily).
- Re-check liquidatability on-chain right before broadcast.
- Observe/paper mode default; live exec is explicit opt-in.

## Next action
Build Phase 0: order index + expiry extraction + energy-cost measurement + historical win-timing
analysis (reuse G-1159 `data/*.json`). Output a GO/NO-GO report.
