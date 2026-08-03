// Concrete proof: real liquidations our bot tracked, with clickable Tronscan links to verify.
import { JustLendReader, eventAddrToBase58, orderKey } from './justlend.js';
import { sunToTrx, tronHexToBase58 } from './tron.js';

const reader = new JustLendReader();
const TRACKED = ['69794b829ff5879d7ea9cf49f0cc8c8657e98795', '59e5ecedf669dbc900aa2c8c8c7e7b37b7beba4a'];

function addrLink(hex0x: string): string {
  try {
    const clean = hex0x.replace(/^0x/, '');
    return 'https://tronscan.org/#/address/' + tronHexToBase58('41' + clean);
  } catch {
    return hex0x;
  }
}

const liqs = await reader.fetchLiquidateEvents(Date.now() - 8 * 3_600_000);
console.log(`\nReal JustLend liquidations in the last 8h: ${liqs.length}\n`);
for (const e of liqs.sort((a, b) => a.block_timestamp - b.block_timestamp)) {
  const reward = sunToTrx(BigInt(e.result.liquidateFee || '0'));
  const who = eventAddrToBase58(e.result.liquidator);
  const k = orderKey(e.result.renter, e.result.receiver, e.result.resourceType).split(':')[0];
  const wasTracked = TRACKED.includes(k) ? '   ⬅ OUR BOT WAS TRACKING THIS ORDER' : '';
  console.log(`${new Date(e.block_timestamp).toISOString().slice(11, 19)}  ${reward.toFixed(0)} TRX → ${who.slice(0, 12)}${wasTracked}`);
  console.log(`   TX (verify): https://tronscan.org/#/transaction/${e.transaction_id}`);
  console.log(`   renter:      ${addrLink(e.result.renter)}`);
  console.log('');
}
