// Deep-trace real open→liquidate pairs to derive the TRUE sit-time from on-chain facts (no model).
// For each liquidation: its open (RentResource: amount, deposit, rentIndex, t0), top-ups/returns,
// and the Liquidate event (usageRental, liquidateFee, sendBack). The deposit consumed past expiry
// should encode the overdue (sit) time. Print raw numbers so we can see the real relationship.
import { JustLendReader, orderKey } from './justlend.js';
import { sunToTrx } from './tron.js';

async function main(): Promise<void> {
  const reader = new JustLendReader();
  const now = Date.now();
  const liqs = await reader.fetchLiquidateEvents(now - 36 * 3_600_000);
  const rents = await reader.fetchRentEvents(now - 7 * 24 * 3_600_000);
  const returns = await reader.fetchReturnEvents(now - 7 * 24 * 3_600_000);
  const mp = await reader.getMarketParams();

  const rentsBy = new Map<string, typeof rents>();
  for (const e of rents) {
    const k = orderKey(e.result.renter, e.result.receiver, e.result.resourceType);
    (rentsBy.get(k) ?? rentsBy.set(k, []).get(k)!).push(e);
  }
  const retBy = new Map<string, typeof returns>();
  for (const e of returns) {
    const k = orderKey(e.result.renter, e.result.receiver, e.result.resourceType);
    (retBy.get(k) ?? retBy.set(k, []).get(k)!).push(e);
  }

  const recent = [...liqs].sort((a, b) => b.block_timestamp - a.block_timestamp);
  let shown = 0;
  for (const L of recent) {
    if (shown >= 10) break;
    const k = orderKey(L.result.renter, L.result.receiver, L.result.resourceType);
    const rs = (rentsBy.get(k) ?? []).sort((a, b) => a.block_timestamp - b.block_timestamp);
    if (rs.length === 0) continue;
    shown++;
    const open = rs[0];
    const A = BigInt(open.result.amount || '0');
    const D0 = BigInt(rs[rs.length - 1].result.securityDeposit || '0'); // latest known deposit before liq
    const perSecRent = (A * mp.rentRate) / 1_000_000_000_000_000_000n; // SUN/sec
    const dailyRentTrx = sunToTrx(perSecRent * 86400n);
    const usage = BigInt(L.result.usageRental || '0');
    const fee = BigInt(L.result.liquidateFee || '0');
    const send = BigInt(L.result.sendBack || '0');
    const lifeMin = (L.block_timestamp - open.block_timestamp) / 60000;

    console.log(`\norder ${k.slice(0, 10)}…  rents=${rs.length} returns=${(retBy.get(k) ?? []).length}`);
    console.log(`  opened ${new Date(open.block_timestamp).toISOString().slice(5, 16)} → liquidated ${new Date(L.block_timestamp).toISOString().slice(5, 16)}  (lifetime ${lifeMin < 90 ? lifeMin.toFixed(0) + 'm' : (lifeMin / 60).toFixed(1) + 'h'})`);
    console.log(`  amount=${sunToTrx(A).toFixed(0)} TRX  deposit D0=${sunToTrx(D0).toFixed(1)} TRX  dailyRent=${dailyRentTrx.toFixed(1)} TRX/day  perSecRent=${sunToTrx(perSecRent).toFixed(5)} TRX/s`);
    console.log(`  Liquidate: usageRental=${sunToTrx(usage).toFixed(1)}  liquidateFee=${sunToTrx(fee).toFixed(1)}  sendBack=${sunToTrx(send).toFixed(1)} TRX`);
    // Candidate sit-time signals (which one is sensible?):
    const consumed = D0 > send ? D0 - send : 0n;
    const sitFromConsumed = perSecRent > 0n ? Number(consumed) / Number(perSecRent) / 60 : 0; // min
    const sitFromUsage = perSecRent > 0n ? Number(usage) / Number(perSecRent) / 60 : 0; // min
    console.log(`  ► depositConsumed(D0-sendBack)=${sunToTrx(consumed).toFixed(1)} TRX → sit≈${sitFromConsumed.toFixed(0)} min   |   usage/rate=${sitFromUsage.toFixed(0)} min (total rent-time)`);
  }
}
main().catch((e) => console.error('fatal:', e instanceof Error ? e.message : e));
