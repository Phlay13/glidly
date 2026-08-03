// 7-day JustLend energy-rental liquidation economics: how many liquidations, who won,
// reward totals, USD value at current TRX price, daily breakdown. Read-only.
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { JustLendReader, eventAddrToBase58 } from './justlend.js';
import { config } from './config.js';
import { sunToTrx } from './tron.js';

const DAYS = 7;
const FLOOR = 20.5;

async function trxUsd(): Promise<number> {
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=tron&vs_currencies=usd', { timeout: 8000 });
    const p = r.data?.tron?.usd;
    if (typeof p === 'number' && p > 0) return p;
  } catch {
    /* fall back */
  }
  return 0.12; // conservative fallback
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const reader = new JustLendReader();
  const minTs = Date.now() - DAYS * 24 * 3_600_000;
  console.log(`\n=== GLIDLY · ${DAYS}-DAY LIQUIDATION ECONOMICS ===`);
  console.log(`since ${new Date(minTs).toISOString()}\nFetching Liquidate events…`);

  const [liqs, price] = await Promise.all([reader.fetchLiquidateEvents(minTs), trxUsd()]);
  console.log(`  liquidations: ${liqs.length}   TRX price: $${price}`);

  const perComp = new Map<string, { wins: number; trx: number; max: number; floor: number; whale: number }>();
  const perDay = new Map<string, { count: number; trx: number }>();
  let totalTrx = 0;
  let floorCount = 0;
  let whaleCount = 0;

  for (const e of liqs) {
    const reward = sunToTrx(BigInt(e.result.liquidateFee || '0'));
    totalTrx += reward;
    const isFloor = reward <= FLOOR;
    if (isFloor) floorCount += 1;
    else whaleCount += 1;

    const who = eventAddrToBase58(e.result.liquidator);
    const c = perComp.get(who) ?? { wins: 0, trx: 0, max: 0, floor: 0, whale: 0 };
    c.wins += 1;
    c.trx += reward;
    c.max = Math.max(c.max, reward);
    if (isFloor) c.floor += 1;
    else c.whale += 1;
    perComp.set(who, c);

    const dk = dayKey(e.block_timestamp);
    const d = perDay.get(dk) ?? { count: 0, trx: 0 };
    d.count += 1;
    d.trx += reward;
    perDay.set(dk, d);
  }

  const board = [...perComp.entries()].sort((a, b) => b[1].trx - a[1].trx);

  console.log('\n──────────── TOTALS (7d) ────────────');
  console.log(`  liquidations: ${liqs.length}   (~${(liqs.length / DAYS).toFixed(1)}/day)`);
  console.log(`  total reward: ${totalTrx.toFixed(2)} TRX  ≈  $${(totalTrx * price).toFixed(2)}   (~$${(totalTrx * price / DAYS).toFixed(2)}/day pool)`);
  console.log(`  floor(≤20): ${floorCount}   whale(>20): ${whaleCount}`);

  console.log('\n──────────── BY COMPETITOR ────────────');
  for (const [who, c] of board) {
    const share = (c.wins / liqs.length) * 100;
    console.log(
      `  ${who}\n    wins=${c.wins} (${share.toFixed(0)}%)  reward=${c.trx.toFixed(2)} TRX ($${(c.trx * price).toFixed(0)})  ` +
        `floor=${c.floor} whale=${c.whale}  max=${c.max.toFixed(2)} TRX`,
    );
  }

  console.log('\n──────────── BY DAY ────────────');
  for (const [d, v] of [...perDay.entries()].sort()) {
    console.log(`  ${d}   liqs=${String(v.count).padStart(3)}   reward=${v.trx.toFixed(0)} TRX  ($${(v.trx * price).toFixed(0)})`);
  }

  // Realistic newcomer scenarios (beating TEFVYG N times/day on floor orders)
  console.log('\n──────────── YOUR TAKE IF YOU WIN N FLOOR ORDERS/DAY ────────────');
  for (const n of [1, 2, 3, 5]) {
    const trxDay = n * 20;
    console.log(`  ${n} win/day → ${trxDay} TRX/day ≈ $${(trxDay * price).toFixed(2)}/day  ($${(trxDay * price * 30).toFixed(0)}/mo)`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    days: DAYS,
    trxUsd: price,
    totals: { liquidations: liqs.length, perDay: liqs.length / DAYS, totalTrx, totalUsd: totalTrx * price, floorCount, whaleCount },
    competitors: board.map(([address, c]) => ({ address, ...c, sharePct: (c.wins / liqs.length) * 100, usd: c.trx * price })),
    daily: [...perDay.entries()].sort().map(([date, v]) => ({ date, ...v })),
  };
  const dir = path.resolve(config.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'weekly-report-latest.json'), JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${path.join(dir, 'weekly-report-latest.json')}\n`);
}

main().catch((e) => {
  console.error('fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
