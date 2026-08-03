import { runPhase0 } from './phase0.js';

runPhase0().catch((err) => {
  console.error('\n[Glidly Phase 0] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
