import 'dotenv/config';

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

function csv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function int(name: string, fallback: number): number {
  const v = parseInt(optional(name, String(fallback)), 10);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  // Contract
  contract: optional('JUSTLEND_ENERGY_RENTAL_CONTRACT', 'TU2MJ5Veik1LRAgjeSzEdvmDYx7mefJZvd'),
  resourceType: int('JUSTLEND_RESOURCE_TYPE', 1),
  ownerAddress: optional('TRON_OWNER_ADDRESS', ''),

  // Endpoints
  httpEndpoints: csv('TRON_HTTP_ENDPOINTS').length > 0 ? csv('TRON_HTTP_ENDPOINTS') : ['https://api.trongrid.io'],
  eventEndpoints: csv('TRON_EVENT_ENDPOINTS').length > 0 ? csv('TRON_EVENT_ENDPOINTS') : ['https://api.trongrid.io'],
  tronGridApiKey: optional('TRONGRID_API_KEY', ''),
  tronScanApiKey: optional('TRONSCAN_API_KEY', ''),
  rpcTimeoutMs: int('TRON_RPC_TIMEOUT_MS', 8000),
  rpcMinIntervalMs: int('TRON_RPC_MIN_INTERVAL_MS', 120),
  pendingDetailFanout: int('TRON_PENDING_DETAIL_FANOUT', 2),

  // Phase 0
  lookbackHours: int('GLIDLY_LOOKBACK_HOURS', 24),
  maxEventPages: int('GLIDLY_MAX_EVENT_PAGES', 40),
  measureSample: int('GLIDLY_MEASURE_SAMPLE', 40),
  dataDir: optional('GLIDLY_DATA_DIR', 'data'),
  g1159WinnersPath: optional('GLIDLY_G1159_WINNERS', ''),

  logLevel: optional('LOG_LEVEL', 'info'),
};

// Alias kept so the ported client.ts (which reads `justLendConfig`) works unchanged.
export const justLendConfig = config;
