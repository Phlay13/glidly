// Ported verbatim from G-1159 (proven). Address codec, ABI encode/decode, tx signing,
// and protobuf-varint surgery for setting tx expiration (used later for pre-staging).
import crypto from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';

export const SUN = 1_000_000n;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((char, index) => [char, BigInt(index)]));

export interface TronAddress {
  base58: string;
  hex: string;
  abi: `0x${string}`;
}

export function sunToTrx(value: bigint): number {
  return Number(value) / Number(SUN);
}

export function trxToSun(value: number): bigint {
  return BigInt(Math.round(value * Number(SUN)));
}

export function normalizePrivateKey(privateKey: string): Hex {
  const clean = privateKey.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error('TRON private key must be 64 hex characters.');
  }
  return `0x${clean.toLowerCase()}`;
}

function bytesToHex(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('hex');
}

function hexToBytes(hex: string): Buffer {
  const clean = hex.replace(/^0x/i, '');
  if (clean.length % 2 !== 0) throw new Error(`Invalid hex length: ${hex}`);
  return Buffer.from(clean, 'hex');
}

function base58Encode(bytes: Uint8Array): string {
  let value = BigInt(`0x${bytesToHex(bytes)}`);
  let out = '';
  while (value > 0n) {
    const mod = value % 58n;
    out = BASE58_ALPHABET[Number(mod)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) out = `1${out}`;
    else break;
  }
  return out;
}

function base58Decode(input: string): Buffer {
  let value = 0n;
  for (const char of input) {
    const digit = BASE58_MAP.get(char);
    if (digit === undefined) throw new Error(`Invalid base58 character: ${char}`);
    value = value * 58n + digit;
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let out = Buffer.from(hex, 'hex');
  let zeros = 0;
  for (const char of input) {
    if (char === '1') zeros += 1;
    else break;
  }
  if (zeros > 0) out = Buffer.concat([Buffer.alloc(zeros), out]);
  return out;
}

function checksum(payload: Buffer): Buffer {
  return crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
}

export function tronHexToBase58(hex: string): string {
  const clean = hex.replace(/^0x/i, '').toLowerCase();
  const payload = Buffer.from(clean, 'hex');
  if (payload.length !== 21 || payload[0] !== 0x41) throw new Error(`Invalid TRON hex address: ${hex}`);
  return base58Encode(Buffer.concat([payload, checksum(payload)]));
}

export function tronBase58ToHex(address: string): string {
  const decoded = base58Decode(address);
  if (decoded.length !== 25) throw new Error(`Invalid TRON base58 address length: ${address}`);
  const payload = decoded.subarray(0, 21);
  const actual = decoded.subarray(21);
  const expected = checksum(payload);
  if (!actual.equals(expected)) throw new Error(`Invalid TRON base58 checksum: ${address}`);
  if (payload[0] !== 0x41) throw new Error(`Invalid TRON address prefix: ${address}`);
  return payload.toString('hex').toUpperCase();
}

export function abiAddressToTronHex(address: string): string {
  const clean = address.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{40}$/.test(clean)) throw new Error(`Invalid 20-byte hex address: ${address}`);
  return `41${clean}`.toUpperCase();
}

export function tronHexToAbiAddress(hex: string): `0x${string}` {
  const clean = hex.replace(/^0x/i, '');
  if (!/^41[0-9a-fA-F]{40}$/.test(clean)) throw new Error(`Invalid TRON hex address: ${hex}`);
  return `0x${clean.slice(2).toLowerCase()}`;
}

export function normalizeTronAddress(address: string): TronAddress {
  const trimmed = address.trim();
  const hex = trimmed.startsWith('T') ? tronBase58ToHex(trimmed) : trimmed.replace(/^0x/i, '').toUpperCase();
  return { hex, base58: tronHexToBase58(hex), abi: tronHexToAbiAddress(hex) };
}

export function privateKeyToTronAddress(privateKey: string): TronAddress {
  const pk = normalizePrivateKey(privateKey);
  const publicKey = secp256k1.getPublicKey(hexToBytes(pk), false).subarray(1);
  const hash = keccak256(`0x${bytesToHex(publicKey)}`);
  const hex = `41${hash.slice(-40)}`.toUpperCase();
  return { hex, base58: tronHexToBase58(hex), abi: tronHexToAbiAddress(hex) };
}

export function encodeLiquidateParams(renter: `0x${string}`, receiver: `0x${string}`, resourceType: number): string {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [renter, receiver, BigInt(resourceType)],
  ).slice(2);
}

export function encodeRentInfoParams(renter: `0x${string}`, receiver: `0x${string}`, resourceType: number): string {
  return encodeLiquidateParams(renter, receiver, resourceType);
}

export function encodeUint256Word(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

export function decodeUint256(hex: string | undefined): bigint {
  const words = decodeAbiWords(hex);
  if (words.length === 0) return 0n;
  return words[0];
}

export function decodeAbiWords(hex: string | undefined): bigint[] {
  if (!hex) return [];
  const clean = hex.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error(`Invalid ABI hex: ${hex}`);
  if (clean.length === 0) return [];
  if (clean.length > 64 && clean.length % 64 !== 0) throw new Error(`Invalid ABI word length: ${clean.length} hex chars.`);
  const padded = clean.length <= 64 ? clean.padStart(64, '0') : clean;
  const words: bigint[] = [];
  for (let i = 0; i < padded.length; i += 64) {
    words.push(BigInt(`0x${padded.slice(i, i + 64)}`));
  }
  return words;
}

export function decodeAbiRevertReason(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const clean = hex.replace(/^0x/i, '');
  if (!clean.startsWith('08c379a0') || clean.length < 8 + 64 * 2) return undefined;
  try {
    const lengthStart = 8 + 64;
    const dataStart = lengthStart + 64;
    const byteLength = Number(BigInt(`0x${clean.slice(lengthStart, lengthStart + 64)}`));
    const dataHex = clean.slice(dataStart, dataStart + byteLength * 2);
    const text = Buffer.from(dataHex, 'hex').toString('utf8');
    return text || 'execution reverted';
  } catch {
    return 'execution reverted';
  }
}

export function signTronTransaction<T extends { txID?: string; raw_data_hex?: string; signature?: string[] }>(
  transaction: T,
  privateKey: string,
): T {
  const pk = hexToBytes(normalizePrivateKey(privateKey));
  const raw = transaction.raw_data_hex;
  if (!raw) throw new Error('Cannot sign TRON transaction without raw_data_hex.');
  const txId = crypto.createHash('sha256').update(hexToBytes(raw)).digest();
  if (transaction.txID && transaction.txID.toLowerCase() !== txId.toString('hex')) {
    throw new Error('TRON transaction txID did not match raw_data_hex hash.');
  }
  const sig = secp256k1.sign(txId, pk);
  const compact = Buffer.from(sig.toCompactRawBytes());
  const recovery = Buffer.from([sig.recovery ?? 0]);
  transaction.signature = [Buffer.concat([compact, recovery]).toString('hex')];
  return transaction;
}
