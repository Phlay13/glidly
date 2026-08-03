// Targeted lookup: what really happened to snapshot row 1 (renter 0xd77656…d580 →
// receiver 0xea2748…f2b1, codex "reward" 3509 TRX)? Did it get liquidated or returned,
// and what was the REAL liquidator fee vs codex's number?
import { JustLendReader, type MarketParams } from './justlend.js';
import { predictLiquidatableAt } from './predictor.js';
import { sunToTrx } from './tron.js';

const RENTER_PRE = '0xd77656';
const RENTER_SUF = 'd580';
const RECV_PRE = '0xea2748';
const RECV_SUF = 'f2b1';

function matchRenter(a: string): boolean {
  const s = a.toLowerCase();
  return s.startsWith(RENTER_PRE) && s.endsWith(RENTER_SUF);
}
function matchRecv(a: string): boolean {
  const s = a.toLowerCase();
  return s.startsWith(RECV_PRE) && s.endsWith(RECV_SUF);
}

async function main(): Promise<void> {
  const reader = new JustLendReader();
  const minTs = Date.now() - 72 * 3_600_000;
  console.log('Searching last 72h for row-1 order…');
  const [rents, returns, liqs, mp] = await Promise.all([
    reader.fetchRentEvents(minTs),
    reader.fetchReturnEvents(minTs),
    reader.fetchLiquidateEvents(minTs),
    reader.getMarketParams(),
  ]);

  const myRents = rents.filter((e) => matchRenter(e.result.renter) && matchRecv(e.result.receiver));
  const myRet = returns.filter((e) => matchRenter(e.result.renter) && matchRecv(e.result.receiver));
  const myLiq = liqs.filter((e) => matchRenter(e.result.renter) && matchRecv(e.result.receiver));

  console.log(`\nRENT events: ${myRents.length}`);
  for (const e of myRents) {
    console.log(`  ${new Date(e.block_timestamp).toISOString()}  amount=${sunToTrx(BigInt(e.result.amount || '0')).toFixed(0)} TRX  deposit=${sunToTrx(BigInt(e.result.securityDeposit || '0')).toFixed(0)} TRX`);
  }
  console.log(`\nRETURN events: ${myRet.length}`);
  for (const e of myRet) console.log(`  ${new Date(e.block_timestamp).toISOString()}  ↩ RETURNED by renter (not liquidated)`);
  console.log(`\nLIQUIDATE events: ${myLiq.length}`);
  for (const e of myLiq) console.log(`  ${new Date(e.block_timestamp).toISOString()}  liquidateFee(REAL reward)=${sunToTrx(BigInt(e.result.liquidateFee || '0')).toFixed(2)} TRX`);

  // What does OUR validated formula predict the reward to be?
  if (myRents.length) {
    const last = myRents[myRents.length - 1].result;
    const amountSun = BigInt(last.amount || '0');
    const depositSun = BigInt(last.securityDeposit || '0');
    const rentIndex = BigInt(last.rentIndex || '0');
    const snapTs = myRents[myRents.length - 1].block_timestamp;
    const mpOrder: MarketParams = { ...mp, globalRentIndex: rentIndex, globalRentUpdatedAt: Math.floor(snapTs / 1000) };
    const cttl = predictLiquidatableAt({ amountSun, depositSun, rentIndex, snapshotAtMs: snapTs }, mpOrder, snapTs);
    console.log('\n── GLIDLY vs CODEX ──');
    console.log(`  order amount: ${sunToTrx(amountSun).toFixed(0)} TRX`);
    console.log(`  Glidly predicted liquidator reward: ${cttl ? cttl.rewardTrx.toFixed(2) : '?'} TRX`);
    console.log(`  Codex snapshot "reward": 3509.75 TRX`);
  }

  const resolution = myLiq.length ? 'LIQUIDATED' : myRet.length ? 'RETURNED (renter reclaimed)' : 'still open / not found in 72h';
  console.log(`\nVERDICT for row 1: ${resolution}`);
}

main().catch((e) => console.error('fatal:', e instanceof Error ? e.message : e));
