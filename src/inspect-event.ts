import { JustLendReader } from './justlend.js';

async function main(): Promise<void> {
  const reader = new JustLendReader();
  const minTs = Date.now() - 6 * 3_600_000;
  const rents = await reader.fetchRentEvents(minTs);
  const liqs = await reader.fetchLiquidateEvents(minTs);
  console.log(`\nRentResource sample (${rents.length} total):`);
  console.log(JSON.stringify(rents.slice(0, 2).map((e) => ({ ts: e.block_timestamp, result: e.result })), null, 2));
  console.log(`\nLiquidate sample (${liqs.length} total):`);
  console.log(JSON.stringify(liqs.slice(0, 2).map((e) => ({ ts: e.block_timestamp, result: e.result })), null, 2));
}
main().catch((e) => console.error('fatal:', e instanceof Error ? e.message : e));
