// Liquidation-time predictor — the "known stopwatch" edge.
// A rental order drains its security deposit at a fixed per-second rent. It becomes
// liquidatable when the remaining deposit falls to the liquidation boundary. Given the
// order's amount + a deposit/rentIndex snapshot + market rates, we compute the exact
// moment it crosses that boundary. Ported from G-1159's calculateCttl (proven).
import { CONTRACT_SCALE, SECONDS_PER_DAY, type MarketParams } from './justlend.js';
import { sunToTrx } from './tron.js';

export interface OrderSnapshot {
  amountSun: bigint;
  depositSun: bigint;
  rentIndex: bigint; // order's rent index at snapshotAtMs
  snapshotAtMs: number; // when deposit/rentIndex were observed (chain ms)
}

export interface Cttl {
  predictedLiquidatableAtMs: number;
  effectiveDepositSun: bigint;
  liquidationBoundarySun: bigint;
  perSecondRentSun: bigint;
  liquidateFeeSun: bigint;
  rewardTrx: number;
}

function ceilDiv(n: bigint, d: bigint): bigint {
  return d <= 0n ? 0n : (n + d - 1n) / d;
}

/** Global rent index extrapolated to `nowMs`. */
function currentGlobalRentIndex(mp: MarketParams, nowMs: number): bigint {
  const stateMs = mp.globalRentUpdatedAt > 10_000_000_000 ? mp.globalRentUpdatedAt : mp.globalRentUpdatedAt * 1000;
  const elapsedSec = nowMs > stateMs ? BigInt(Math.floor((nowMs - stateMs) / 1000)) : 0n;
  return mp.globalRentIndex + mp.rentRate * elapsedSec;
}

/** Rent accrued against the order between its snapshot and nowMs. */
function accruedRentalSun(o: OrderSnapshot, mp: MarketParams, nowMs: number): bigint {
  const globalIndex = currentGlobalRentIndex(mp, nowMs);
  const elapsedSec = nowMs > o.snapshotAtMs ? BigInt(Math.floor((nowMs - o.snapshotAtMs) / 1000)) : 0n;
  const localIndex = o.rentIndex + mp.rentRate * elapsedSec;
  const currentIndex = globalIndex > localIndex ? globalIndex : localIndex;
  const accruedIndex = currentIndex > o.rentIndex ? currentIndex - o.rentIndex : 0n;
  return (o.amountSun * accruedIndex) / CONTRACT_SCALE;
}

export function predictLiquidatableAt(o: OrderSnapshot, mp: MarketParams, nowMs: number): Cttl | null {
  if (o.amountSun <= 0n) return null;

  const feeByRatioSun = (o.amountSun * mp.feeRatio) / CONTRACT_SCALE;
  const liquidateFeeSun = feeByRatioSun > mp.minFeeSun ? feeByRatioSun : mp.minFeeSun;
  // ASSUMPTION (validated for resourceType=1, 2026-06): liquidateRate is non-zero. The rentRate
  // fallback only exists as a guard; if liquidateRate ever legitimately reads 0, this boundary is
  // wrong and must be revisited rather than silently substituted.
  const liquidateRate = mp.liquidateRate > 0n ? mp.liquidateRate : mp.rentRate;

  // ASSUMPTION: liquidateThreshold is in SECONDS (dimensionally consistent with liquidateRate's
  // per-second scaling). Currently reads 0, so this term vanishes; if it ever becomes non-zero,
  // re-verify the unit against the JustLend contract before trusting the prediction.
  const oneDayRentSun = (o.amountSun * liquidateRate * SECONDS_PER_DAY) / CONTRACT_SCALE;
  const thresholdSun = (o.amountSun * liquidateRate * mp.liquidateThreshold) / CONTRACT_SCALE;
  const liquidationBoundarySun = liquidateFeeSun + oneDayRentSun + thresholdSun;

  const perSecondNumerator = o.amountSun * mp.rentRate;
  if (perSecondNumerator <= 0n) return null;
  const perSecondRentSun = perSecondNumerator / CONTRACT_SCALE;

  const accrued = accruedRentalSun(o, mp, nowMs);
  const effectiveDepositSun = o.depositSun > accrued ? o.depositSun - accrued : 0n;

  const predictedLiquidatableAtMs =
    effectiveDepositSun <= liquidationBoundarySun
      ? nowMs
      : nowMs + Number(ceilDiv((effectiveDepositSun - liquidationBoundarySun) * CONTRACT_SCALE, perSecondNumerator)) * 1000;

  return {
    predictedLiquidatableAtMs,
    effectiveDepositSun,
    liquidationBoundarySun,
    perSecondRentSun,
    liquidateFeeSun,
    rewardTrx: sunToTrx(liquidateFeeSun),
  };
}
