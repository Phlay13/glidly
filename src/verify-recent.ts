import { JustLendReader, eventAddrToBase58 } from './justlend.js';
import { sunToTrx } from './tron.js';

const HOURS = Number(process.env.H ?? 5);
const reader = new JustLendReader();
const since = Date.now() - HOURS * 3_600_000;
const liqs = await reader.fetchLiquidateEvents(since);
console.log(`Actual on-chain liquidations in last ${HOURS}h: ${liqs.length}`);
for (const e of liqs.sort((a, b) => a.block_timestamp - b.block_timestamp))
  console.log(`  ${new Date(e.block_timestamp).toISOString().slice(11, 19)}  ${sunToTrx(BigInt(e.result.liquidateFee || '0')).toFixed(0)} TRX  by ${eventAddrToBase58(e.result.liquidator).slice(0, 8)}`);
const chainNow = await reader.nowChainMs();
console.log(`chainNow=${new Date(chainNow).toISOString().slice(11, 19)}  localNow=${new Date().toISOString().slice(11, 19)}`);
