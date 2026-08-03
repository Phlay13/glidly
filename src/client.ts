// Ported from G-1159 (proven multi-endpoint RPC core), trimmed to Glidly's needs.
// Dropped: reactive mempool polling (the failed approach). Kept: endpoint ranking,
// pacing, cooldowns, constant calls, event fetch, broadcast (for later phases).
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import { config } from './config.js';

export interface TronGridEvent<T = Record<string, string>> {
  block_number: number;
  block_timestamp: number;
  event_index: number;
  event_name: string;
  transaction_id: string;
  result: T;
}

interface TronEndpoint {
  label: string;
  url: string;
  client: AxiosInstance;
  lastCallAt: number;
  failures: number;
  cooldownUntil: number;
  lastOkAt: number;
  avgLatencyMs: number;
  successes: number;
  authBroken: boolean;
}

interface EventPage<T> {
  data: Array<TronGridEvent<T>>;
  meta?: { links?: { next?: string } };
  success?: boolean;
}

export interface TronTxInfo {
  id?: string;
  blockNumber?: number;
  blockTimeStamp?: number;
  fee?: number;
  contractResult?: string[];
  receipt?: {
    result?: string;
    energy_usage_total?: number;
    energy_usage?: number;
    energy_fee?: number;
    net_usage?: number;
  };
}

export interface TronAccountResource {
  freeNetLimit?: number;
  freeNetUsed?: number;
  NetLimit?: number;
  NetUsed?: number;
  EnergyLimit?: number;
  EnergyUsed?: number;
  TotalEnergyLimit?: number;
  TotalEnergyWeight?: number;
}

export interface TronNowBlock {
  blockID?: string;
  block_header?: { raw_data?: { number?: number; timestamp?: number } };
}

export interface TronSignedTransaction {
  txID?: string;
  raw_data?: Record<string, unknown>;
  raw_data_hex?: string;
  signature?: string[];
  [key: string]: unknown;
}

function labelFromUrl(url: string, index: number): string {
  try {
    return new URL(url).hostname.replace(/^api\./, '') || `tron#${index + 1}`;
  } catch {
    return `tron#${index + 1}`;
  }
}

function normalizeProviderBaseUrl(url: string): string {
  return url.trim().replace(/\/+(jsonrpc|walletsolidity|wallet)\/?$/i, '').replace(/\/+$/, '');
}

function authHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.tronGridApiKey && url.includes('trongrid')) headers['TRON-PRO-API-KEY'] = config.tronGridApiKey;
  if (config.tronScanApiKey && url.includes('tronscan')) headers['TRONSCAN-API-KEY'] = config.tronScanApiKey;
  return headers;
}

function mkEndpoint(url: string, index: number): TronEndpoint {
  return {
    label: labelFromUrl(url, index),
    url: normalizeProviderBaseUrl(url),
    client: axios.create({ baseURL: normalizeProviderBaseUrl(url), timeout: config.rpcTimeoutMs, headers: authHeaders(url) }),
    lastCallAt: 0,
    failures: 0,
    cooldownUntil: 0,
    lastOkAt: 0,
    avgLatencyMs: config.rpcTimeoutMs,
    successes: 0,
    authBroken: false,
  };
}

export class TronHttpClient {
  private endpoints: TronEndpoint[];
  private eventEndpoints: TronEndpoint[];

  constructor() {
    this.endpoints = config.httpEndpoints.map(mkEndpoint);
    this.eventEndpoints = config.eventEndpoints.map(mkEndpoint);
  }

  endpointLabels(): string[] {
    return this.endpoints.map((ep) => ep.label);
  }

  private async pace(ep: TronEndpoint): Promise<void> {
    const wait = Math.max(0, config.rpcMinIntervalMs - (Date.now() - ep.lastCallAt));
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    ep.lastCallAt = Date.now();
  }

  private availableEndpoints(endpoints: TronEndpoint[]): TronEndpoint[] {
    const now = Date.now();
    return endpoints.filter((ep) => !ep.authBroken && ep.cooldownUntil <= now);
  }

  private markFailure(ep: TronEndpoint, err: unknown): void {
    ep.failures += 1;
    const msg = errorText(err);
    const authBroken = /401|403|auth token is not set|unauthorized|forbidden/i.test(msg);
    const quota = /403|429|too many|quota|limit|frequency|suspended/i.test(msg);
    ep.authBroken = authBroken;
    ep.cooldownUntil = Date.now() + (authBroken ? 30 * 60_000 : quota ? 60_000 : Math.min(5000 * ep.failures, 30_000));
  }

  private markOk(ep: TronEndpoint, latencyMs?: number): void {
    ep.failures = 0;
    ep.cooldownUntil = 0;
    ep.authBroken = false;
    ep.lastOkAt = Date.now();
    ep.successes += 1;
    if (latencyMs !== undefined) {
      ep.avgLatencyMs = ep.successes <= 1 ? latencyMs : ep.avgLatencyMs * 0.7 + latencyMs * 0.3;
    }
  }

  private endpointScore(ep: TronEndpoint): number {
    const freshness = ep.lastOkAt === 0 ? 0 : Math.min(10_000, Date.now() - ep.lastOkAt);
    return ep.failures * 100 + ep.avgLatencyMs + freshness / 1000;
  }

  private rankedEndpoints(endpoints: TronEndpoint[]): TronEndpoint[] {
    return this.availableEndpoints(endpoints).slice().sort((a, b) => this.endpointScore(a) - this.endpointScore(b));
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    let lastErr: unknown;
    for (const ep of this.rankedEndpoints(this.endpoints)) {
      try {
        const started = Date.now();
        await this.pace(ep);
        const res = await ep.client.post<T>(path, body);
        this.markOk(ep, Date.now() - started);
        return res.data;
      } catch (err) {
        lastErr = err;
        this.markFailure(ep, err);
      }
    }
    throw new Error(`All TRON RPC endpoints failed: ${errorText(lastErr) || 'all cooling down'}`);
  }

  getAccount(addressHex: string): Promise<{ balance?: number }> {
    return this.post('/wallet/getaccount', { address: addressHex, visible: false });
  }

  getAccountResource(addressHex: string): Promise<TronAccountResource> {
    return this.post('/wallet/getaccountresource', { address: addressHex, visible: false });
  }

  getNowBlock(): Promise<TronNowBlock> {
    return this.post('/wallet/getnowblock', {});
  }

  getChainParameters(): Promise<{ chainParameter?: Array<{ key: string; value?: number }> }> {
    return this.post('/wallet/getchainparameters', {});
  }

  triggerConstantContract(body: Record<string, unknown>): Promise<{
    result?: { result?: boolean; message?: string };
    constant_result?: string[];
    energy_used?: number;
  }> {
    return this.post('/wallet/triggerconstantcontract', body);
  }

  triggerSmartContract(body: Record<string, unknown>): Promise<{
    result?: { result?: boolean; message?: string };
    transaction?: { txID?: string; raw_data_hex?: string; signature?: string[]; [k: string]: unknown };
  }> {
    return this.post('/wallet/triggersmartcontract', body);
  }

  broadcastTransaction(tx: unknown): Promise<{ result?: boolean; txid?: string; code?: string; message?: string }> {
    return this.post('/wallet/broadcasttransaction', tx);
  }

  getTransactionInfo(txId: string): Promise<TronTxInfo> {
    return this.post('/wallet/gettransactioninfobyid', { value: txId });
  }

  async fetchEvents<T>(
    eventName: string,
    minTimestamp: number,
    opts: { maxPages: number; order?: 'asc' | 'desc'; limit?: number; maxTimestamp?: number },
  ): Promise<Array<TronGridEvent<T>>> {
    let lastErr: unknown;
    for (const ep of this.rankedEndpoints(this.eventEndpoints)) {
      try {
        const started = Date.now();
        const events = await this.fetchEventsFromEndpoint<T>(ep, eventName, minTimestamp, opts);
        this.markOk(ep, Date.now() - started);
        return events;
      } catch (err) {
        lastErr = err;
        this.markFailure(ep, err);
      }
    }
    throw new Error(`All TRON event endpoints failed: ${errorText(lastErr) || 'unknown'}`);
  }

  private async fetchEventsFromEndpoint<T>(
    ep: TronEndpoint,
    eventName: string,
    minTimestamp: number,
    opts: { maxPages: number; order?: 'asc' | 'desc'; limit?: number; maxTimestamp?: number },
  ): Promise<Array<TronGridEvent<T>>> {
    const out: Array<TronGridEvent<T>> = [];
    let pages = 0;
    let url: string | null =
      `/v1/contracts/${config.contract}/events?event_name=${encodeURIComponent(eventName)}` +
      `&only_confirmed=true&order_by=block_timestamp,${opts.order ?? 'asc'}` +
      `&limit=${opts.limit ?? 200}&min_block_timestamp=${minTimestamp}` +
      (opts.maxTimestamp ? `&max_block_timestamp=${opts.maxTimestamp}` : '');

    while (url && pages < opts.maxPages) {
      // Retry each page. On a 429 rate-limit, wait out the server's suspension window (TronGrid
      // free keys say "suspended for N s") instead of failing — a transient limit must never
      // crash the run. A single slow page must not discard a long backfill either.
      let res: AxiosResponse<EventPage<T>> | null = null;
      const MAX_ATTEMPTS = 6;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          await this.pace(ep);
          res = await ep.client.get<EventPage<T>>(url);
          break;
        } catch (err) {
          if (attempt === MAX_ATTEMPTS) {
            if (out.length > 0) return out; // partial beats nothing for a long backfill
            throw err;
          }
          const rl = rateLimitWaitMs(err);
          await new Promise((r) => setTimeout(r, rl > 0 ? rl + 1000 : 600 * attempt));
        }
      }
      if (!res) return out;
      out.push(...(res.data.data ?? []));
      url = res.data.meta?.links?.next ?? null;
      pages += 1;
    }
    return out;
  }
}

/** If err is a rate-limit (429), return how long to wait in ms (parses "suspended for N s"). */
function rateLimitWaitMs(err: unknown): number {
  const e = err as { response?: { status?: number; data?: unknown } };
  const status = e?.response?.status;
  const body = typeof e?.response?.data === 'string' ? e.response.data : JSON.stringify(e?.response?.data ?? '');
  if (status === 429 || /frequency limit|suspended|too many/i.test(body)) {
    const m = body.match(/suspended for (\d+)\s*s/i);
    return m ? Number(m[1]) * 1000 : 25_000;
  }
  return 0;
}

function errorText(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const anyErr = err as { message?: string; response?: { status?: number; data?: unknown } };
  const parts = [anyErr.message, anyErr.response?.status?.toString()];
  if (anyErr.response?.data !== undefined) {
    try {
      parts.push(JSON.stringify(anyErr.response.data));
    } catch {
      parts.push(String(anyErr.response.data));
    }
  }
  return parts.filter(Boolean).join(' ');
}
