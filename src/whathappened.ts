// What happened to a specific order? Search recent on-chain events by renter prefix.
import { JustLendReader, eventAddrToBase58 } from './justlend.js';
import { sunToTrx } from './tron.js';

const PRE = (process.env.GLIDLY_FIND ?? '0xd13372f015').toLowerCase();
const HOURS = Number(process.env.GLIDLY_FIND_HOURS ?? 168);

async function main(): Promise<void> {
  const reader = new JustLendReader();
  const minTs = Date.now() - HOURS * 3_600_000;
  const [rents, returns, liqs] = await Promise.all([
    reader.fetchRentEvents(minTs),
    reader.fetchReturnEvents(minTs),
    reader.fetchLiquidateEvents(minTs),
  ]);
  const m = (a: string) => a.toLowerCase().startsWith(PRE);
  console.log(`\nSearching last ${HOURS}h for renter ${PRE}…`);
  // Confirm CURRENT on-chain status of the latest matching rent.
  const myRents = rents.filter((e) => m(e.result.renter));
  const last = myRents[myRents.length - 1];
  if (last) {
    const r = last.result;
    const info = await reader.getRentInfo(r.renter, r.receiver, Number(r.resourceType));
    const sim = await reader.simulateLiquidate(r.renter, r.receiver, Number(r.resourceType));
    console.log(`\nLIVE STATUS NOW: ${info ? `OPEN (deposit ${(Number(info.securityDepositSun) / 1e6).toFixed(0)} TRX)` : 'CLOSED / not found'}  liquidatable=${sim.ok}`);
  }
  for (const e of rents.filter((e) => m(e.result.renter)))
    console.log(`  ${new Date(e.block_timestamp).toISOString().slice(11, 19)}  RENT/TOPUP  amount=${sunToTrx(BigInt(e.result.amount || '0')).toFixed(0)} deposit=${sunToTrx(BigInt(e.result.securityDeposit || '0')).toFixed(0)} TRX`);
  for (const e of returns.filter((e) => m(e.result.renter)))
    console.log(`  ${new Date(e.block_timestamp).toISOString().slice(11, 19)}  ↩ RETURNED (renter reclaimed — no liquidation)`);
  for (const e of liqs.filter((e) => m(e.result.renter)))
    console.log(`  ${new Date(e.block_timestamp).toISOString().slice(11, 19)}  🏁 LIQUIDATED by ${eventAddrToBase58(e.result.liquidator).slice(0, 10)} reward ${sunToTrx(BigInt(e.result.liquidateFee || '0')).toFixed(0)} TRX`);
  const total = rents.filter((e) => m(e.result.renter)).length + returns.filter((e) => m(e.result.renter)).length + liqs.filter((e) => m(e.result.renter)).length;
  if (total === 0) console.log('  (no events in last 5h)');
}
main().catch((e) => console.error('fatal:', e instanceof Error ? e.message : e));
