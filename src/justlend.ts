// JustLend Energy-Rental read layer: event discovery, order-state reads, liquidation
// simulation (reward + real energy cost), and the network energy-per-TRX ratio.
import { TronHttpClient, type TronGridEvent } from './client.js';
import { config } from './config.js';
import {
  abiAddressToTronHex,
  decodeAbiRevertReason,
  decodeAbiWords,
  decodeUint256,
  encodeLiquidateParams,
  encodeRentInfoParams,
  encodeUint256Word,
  normalizeTronAddress,
  sunToTrx,
  tronHexToBase58,
} from './tron.js';

export const CONTRACT_SCALE = 1_000_000_000_000_000_000n;
export const SECONDS_PER_DAY = 86_400n;

export interface MarketParams {
  fetchedAt: number;
  minFeeSun: bigint;
  feeRatio: bigint;
  liquidateThreshold: bigint;
  liquidateRate: bigint;
  rentRate: bigint;
  globalRentUpdatedAt: number; // seconds
  globalRentIndex: bigint;
}

export interface RentResult {
  [k: string]: string | undefined;
  renter: `0x${string}`;
  receiver: `0x${string}`;
  resourceType: string;
  amount: string;
  securityDeposit?: string;
  addedSecurityDeposit?: string;
  rentIndex?: string;
}
export interface ReturnResult extends RentResult {
  usageRental: string;
  subedAmount: string;
  subedSecurityDeposit: string;
}
export interface LiquidateResult {
  [k: string]: string | undefined;
  liquidator: `0x${string}`;
  renter: `0x${string}`;
  receiver: `0x${string}`;
  amount: string;
  resourceType: string;
  usageRental: string;
  liquidateFee: string;
  sendBack: string;
}

/** Canonical address form for keying: lowercase 20-byte hex, no 0x/41 prefix. */
function canonAddr(a: string): string {
  let s = a.trim().toLowerCase().replace(/^0x/, '');
  if (s.length === 42 && s.startsWith('41')) s = s.slice(2); // 41-prefixed tron hex → 20-byte
  return s;
}

/** An order is uniquely identified by (renter, receiver, resourceType). Canonicalized so the
 *  same order never produces two different keys (address encoding / number-vs-string drift). */
export function orderKey(renter: string, receiver: string, resourceType: string | number): string {
  return `${canonAddr(renter)}:${canonAddr(receiver)}:${String(Number(resourceType))}`;
}

/** Normalize an address as it appears in a TronGrid event result to base58 (best-effort). */
export function eventAddrToBase58(addr: string | undefined): string {
  if (!addr) return '(none)';
  try {
    if (addr.startsWith('T')) return addr;
    const clean = addr.replace(/^0x/i, '');
    if (/^41[0-9a-fA-F]{40}$/.test(clean)) return tronHexToBase58(clean);
    if (/^[0-9a-fA-F]{40}$/.test(clean)) return tronHexToBase58(abiAddressToTronHex(clean));
    return addr;
  } catch {
    return addr;
  }
}

/** Coerce an event-result address into the 0x-20-byte form viem's encoder wants. */
function toAbiAddress(addr: string): `0x${string}` {
  if (addr.startsWith('T')) return normalizeTronAddress(addr).abi;
  const clean = addr.replace(/^0x/i, '');
  if (/^41[0-9a-fA-F]{40}$/.test(clean)) return `0x${clean.slice(2).toLowerCase()}`;
  return `0x${clean.toLowerCase()}`;
}

export interface RentInfo {
  securityDepositSun: bigint;
  rentIndex: bigint;
  liquidatable?: boolean;
}

export interface LiquidationSim {
  ok: boolean;
  rewardSun: bigint;
  rewardTrx: number;
  energyUsed: number | null;
  reason?: string;
}

export class JustLendReader {
  readonly tron = new TronHttpClient();
  private readonly contractHex = normalizeTronAddress(config.contract).hex;
  private readonly ownerHex = config.ownerAddress
    ? normalizeTronAddress(config.ownerAddress).hex
    : this.contractHex; // any valid address works for read-only constant calls

  // ---- Event discovery -------------------------------------------------

  fetchRentEvents(minTs: number, maxTs?: number): Promise<Array<TronGridEvent<RentResult>>> {
    return this.tron.fetchEvents<RentResult>('RentResource', minTs, { maxPages: config.maxEventPages, order: 'asc', maxTimestamp: maxTs });
  }
  fetchReturnEvents(minTs: number, maxTs?: number): Promise<Array<TronGridEvent<ReturnResult>>> {
    return this.tron.fetchEvents<ReturnResult>('ReturnResource', minTs, { maxPages: config.maxEventPages, order: 'asc', maxTimestamp: maxTs });
  }
  fetchLiquidateEvents(minTs: number, maxTs?: number): Promise<Array<TronGridEvent<LiquidateResult>>> {
    return this.tron.fetchEvents<LiquidateResult>('Liquidate', minTs, { maxPages: config.maxEventPages, order: 'asc', maxTimestamp: maxTs });
  }

  // ---- Order-state reads -----------------------------------------------

  async getRentInfo(renter: string, receiver: string, resourceType: number): Promise<RentInfo | null> {
    const res = await this.tron.triggerConstantContract({
      owner_address: this.ownerHex,
      contract_address: this.contractHex,
      function_selector: 'getRentInfo(address,address,uint256)',
      parameter: encodeRentInfoParams(toAbiAddress(renter), toAbiAddress(receiver), resourceType),
      visible: false,
    });
    if (res.result?.result === false) return null;
    const words = decodeAbiWords(res.constant_result?.[0]);
    if (words.length < 2) return null;
    return {
      securityDepositSun: words[0],
      rentIndex: words[1],
      liquidatable: words[2] === undefined ? undefined : words[2] !== 0n,
    };
  }

  /**
   * Simulate liquidate() as a read-only constant call. Returns the reward (if liquidatable
   * now) AND the real energy the on-chain call would consume — the number G-1159 guessed.
   */
  async simulateLiquidate(renter: string, receiver: string, resourceType: number): Promise<LiquidationSim> {
    try {
      const res = await this.tron.triggerConstantContract({
        owner_address: this.ownerHex,
        contract_address: this.contractHex,
        function_selector: 'liquidate(address,address,uint256)',
        parameter: encodeLiquidateParams(toAbiAddress(renter), toAbiAddress(receiver), resourceType),
        visible: false,
      });
      const energyUsed = res.energy_used ?? null;
      if (res.result?.result === false) {
        return { ok: false, rewardSun: 0n, rewardTrx: 0, energyUsed, reason: decodeTronMessage(res.result.message) };
      }
      // Success flag but no data returned (some nodes omit it) — ambiguous, NOT a real "0 reward".
      const cr = res.constant_result?.[0];
      if (cr === undefined || cr === '' || cr === '0x') {
        return { ok: false, rewardSun: 0n, rewardTrx: 0, energyUsed, reason: 'empty-result-retry' };
      }
      const revert = decodeAbiRevertReason(res.constant_result?.[0]);
      if (revert) return { ok: false, rewardSun: 0n, rewardTrx: 0, energyUsed, reason: `revert: ${revert}` };
      const rewardSun = decodeUint256(res.constant_result?.[0]);
      if (rewardSun <= 0n) return { ok: false, rewardSun: 0n, rewardTrx: 0, energyUsed, reason: 'zero reward (not liquidatable)' };
      return { ok: true, rewardSun, rewardTrx: sunToTrx(rewardSun), energyUsed };
    } catch (err) {
      return { ok: false, rewardSun: 0n, rewardTrx: 0, energyUsed: null, reason: (err as Error).message };
    }
  }

  // ---- Network resource economics --------------------------------------

  /**
   * Energy minted per 1 TRX staked, right now. From getaccountresource:
   * TotalEnergyLimit (network energy/period) / TotalEnergyWeight (total TRX staked for energy).
   */
  async energyPerStakedTrx(): Promise<{ ratio: number; totalEnergyLimit: number; totalEnergyWeight: number } | null> {
    const r = await this.tron.getAccountResource(this.ownerHex);
    const limit = r.TotalEnergyLimit ?? 0;
    const weight = r.TotalEnergyWeight ?? 0;
    if (!limit || !weight) return null;
    return { ratio: limit / weight, totalEnergyLimit: limit, totalEnergyWeight: weight };
  }

  async nowChainMs(): Promise<number> {
    const b = await this.tron.getNowBlock();
    return b.block_header?.raw_data?.timestamp ?? Date.now();
  }

  // ---- Market parameters (for liquidation-time prediction) -------------

  private async readUint256View(selector: string, parameter: string): Promise<bigint> {
    const res = await this.tron.triggerConstantContract({
      owner_address: this.ownerHex,
      contract_address: this.contractHex,
      function_selector: selector,
      parameter,
      visible: false,
    });
    if (res.result?.result === false) throw new Error(decodeTronMessage(res.result.message) ?? `${selector} failed`);
    return decodeUint256(res.constant_result?.[0]);
  }

  async getMarketParams(): Promise<MarketParams> {
    const rt = encodeUint256Word(BigInt(config.resourceType));
    const [minFeeSun, feeRatio, liquidateThreshold, liquidateRate, rentRate, globalRentState] = await Promise.all([
      this.readUint256View('minFee()', ''),
      this.readUint256View('feeRatio()', ''),
      this.readUint256View('liquidateThreshold()', ''),
      this.readUint256View('_liquidateRate(uint256)', rt),
      this.readUint256View('_rentalRate(uint256,uint256)', `${encodeUint256Word(0n)}${rt}`),
      this.readGlobalRentState(),
    ]);
    return {
      fetchedAt: Date.now(),
      minFeeSun,
      feeRatio,
      liquidateThreshold,
      liquidateRate,
      rentRate,
      globalRentUpdatedAt: globalRentState.updatedAt,
      globalRentIndex: globalRentState.rentIndex,
    };
  }

  private async readGlobalRentState(): Promise<{ updatedAt: number; rentIndex: bigint }> {
    const res = await this.tron.triggerConstantContract({
      owner_address: this.ownerHex,
      contract_address: this.contractHex,
      function_selector: 'globalRentState(uint256)',
      parameter: encodeUint256Word(BigInt(config.resourceType)),
      visible: false,
    });
    if (res.result?.result === false) throw new Error(decodeTronMessage(res.result.message) ?? 'globalRentState failed');
    const words = decodeAbiWords(res.constant_result?.[0]);
    if (words.length < 2) throw new Error('globalRentState returned < 2 words');
    return { updatedAt: Number(words[0]), rentIndex: words[1] };
  }
}

function decodeTronMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  if (/^[0-9a-fA-F]+$/.test(message) && message.length % 2 === 0) {
    try {
      const text = Buffer.from(message, 'hex').toString('utf8');
      if (/[\x20-\x7e]/.test(text)) return text;
    } catch {
      /* fall through */
    }
  }
  return message;
}
