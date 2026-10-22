import { ObservationEngine } from './lan-engine.js';
import type { SessionOptions } from './lan-engine.js';
import { requireAdmission } from './lan-contract.js';

export {
  DEFAULT_LIMITS,
  LIVE_PRINTER_ID,
  LiveSessionError,
  STAGE_TEXT,
  resolveLimits,
} from './lan-engine.js';
export type {
  ByteChannel,
  ChannelFactory,
  ChannelHandlers,
  LiveFailureStage,
  LiveObservation,
  LiveSession,
  LiveTarget,
  SessionEnd,
  SessionIgnoreReason,
  SessionLimits,
  SessionOptions,
  SessionReport,
  SessionStats,
} from './lan-engine.js';

/**
 * The only public live session type. Construction is refused with `CONTRACT_UNVERIFIED` while any
 * required wire-contract item (report topic, MQTT version, subscription QoS, installed X2D
 * firmware/schema) lacks vendor-verified evidence in `src/lan-contract.ts`. The check precedes
 * every other step, takes no argument and has no override, so a valid configuration, an
 * operator-supplied value or an injected channel factory cannot open it. Today the ledger marks
 * those items as implementation choices or unverified, so no `LanReadOnlySession` can exist and
 * no live connection can be opened through this package's entry points.
 */
export class LanReadOnlySession extends ObservationEngine {
  constructor(options: SessionOptions) {
    requireAdmission();
    super(options);
  }
}
