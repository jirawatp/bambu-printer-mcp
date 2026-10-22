import { randomUUID } from 'node:crypto';
import { FAMILY_PROFILES, adaptSnapshot, firmwareSupported } from './adapters.js';
import {
  ServiceError,
  isAction,
  isMockArtifactId,
  isSafeIdentifier,
  mockProvenance,
} from './domain.js';
import { LIVE_PRINTER_ID } from './lan-session.js';
import type { LiveSession } from './lan-session.js';
import type {
  ActionPlan,
  Capability,
  ExecuteActionInput,
  LiveProvenance,
  MockCameraFrame,
  PrepareActionInput,
  PrinterCapabilities,
  PrinterDescriptor,
  PrinterStatus,
  ServicePolicy,
  TransportSnapshot,
} from './domain.js';
import { MockTransport, createDefaultMockFleet } from './mock-transport.js';

// Convenience export for transport-independent MCP error handling.
export { ServiceError } from './domain.js';

/** All the service may use of a live session: read its descriptor and current observation. */
type LiveSource = Pick<LiveSession, 'descriptor' | 'observation'>;

const MAX_PENDING_PLANS = 1_000;
const LIVE_CONTROL_REASON = 'The live X2D path is subscribe-only telemetry observation; pause, cancel, print and every other control are not implemented.';
const LIVE_CAMERA_REASON = 'Camera access is not implemented for the live X2D path.';
const NOZZLE_WARNING = 'Nozzle temperatures are unavailable: the extruder-to-nozzle mapping is unverified.';

function capability(supported: boolean, enabled: string, disabled: string): Capability {
  return { supported, reason: supported ? enabled : disabled };
}

/**
 * Shared printer interface backed exclusively by in-memory mock transports.
 * Defaults are read-only. Programmatic policy can enable simulated controls and
 * the static camera fixture; no policy enables physical device access.
 */
export class PrinterService {
  readonly #transports = new Map<string, MockTransport>();
  readonly #plans = new Map<string, Readonly<ActionPlan>>();
  readonly #enableMockControls: boolean;
  readonly #enableMockCamera: boolean;
  readonly #planTtlMs: number;
  readonly #now: () => number;
  readonly #live: LiveSource | null;

  /**
   * `live` is an optional, operator-started, subscribe-only X2D observation. It can only be read:
   * no action, plan or camera path reaches it.
   */
  constructor(transports: MockTransport[] = createDefaultMockFleet(), policy: ServicePolicy = {}, live?: LiveSource) {
    if (!Array.isArray(transports) || transports.some((transport) => !(transport instanceof MockTransport))) {
      throw new ServiceError('INVALID_ARGUMENT', 'Only local MockTransport instances are accepted.');
    }
    if (live !== undefined && (live === null || typeof live.descriptor !== 'function' || typeof live.observation !== 'function')) {
      throw new ServiceError('INVALID_ARGUMENT', 'Only a live session may be attached as the live printer.');
    }
    if (live !== undefined && transports.some((transport) => transport.id === LIVE_PRINTER_ID)) {
      throw new ServiceError('INVALID_ARGUMENT', 'Duplicate printer identifier.');
    }
    this.#live = live ?? null;
    for (const transport of transports) {
      if (this.#transports.has(transport.id)) throw new ServiceError('INVALID_ARGUMENT', 'Duplicate printer identifier.');
      this.#transports.set(transport.id, transport);
    }
    if ((policy.enableMockControls !== undefined && typeof policy.enableMockControls !== 'boolean') ||
      (policy.enableMockCamera !== undefined && typeof policy.enableMockCamera !== 'boolean')) {
      throw new ServiceError('INVALID_ARGUMENT', 'Mock policy flags must be booleans.');
    }
    const ttl = policy.planTtlMs ?? 30_000;
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 300_000) throw new ServiceError('INVALID_ARGUMENT', 'Plan lifetime must be 1 to 300000 milliseconds.');
    if (policy.now !== undefined && typeof policy.now !== 'function') throw new ServiceError('INVALID_ARGUMENT', 'Clock must be a function.');
    this.#enableMockControls = policy.enableMockControls === true;
    this.#enableMockCamera = policy.enableMockCamera === true;
    this.#planTtlMs = ttl;
    this.#now = policy.now ?? Date.now;
  }

  listPrinters(): PrinterDescriptor[] {
    const printers = [...this.#transports.values()].map((transport) => transport.descriptor());
    return this.#live === null ? printers : [...printers, this.#live.descriptor()];
  }

  #liveFor(printerId: unknown): LiveSource | null {
    return printerId === LIVE_PRINTER_ID ? this.#live : null;
  }

  #liveProvenance(freshness: LiveProvenance['freshness'], ageMs: number | null): LiveProvenance {
    return {
      transport: 'lan-readonly',
      protocol: 'bambu-lan-mqtt-observation',
      hardwareValidated: false,
      compatibility: 'operator-observation-unverified-contract',
      contractVerified: false,
      firmwareVerified: false,
      schemaVerified: false,
      nozzleMapping: 'unknown',
      freshness,
      ageMs,
    };
  }

  #liveCapabilities(live: LiveSource): PrinterCapabilities {
    const observation = live.observation();
    const fresh = observation.phase === 'observing' && observation.freshness === 'fresh';
    const reason = observation.phase === 'unavailable'
      ? observation.reason
      : observation.freshness === 'none' ? 'No telemetry frame has been accepted yet.' : 'Telemetry is stale; values are withheld.';
    const freshness = observation.phase === 'observing' ? observation.freshness : 'none';
    return {
      ...live.descriptor(),
      firmwareSupported: false,
      // Not a fixture: the live nozzle channel count is unknown and never inferred; 0 means "none reported", not "no nozzles".
      fixtureNozzleCount: 0,
      status: capability(fresh, 'Fresh read-only telemetry observation is available; the MQTT contract and X2D firmware/schema are unverified.', reason),
      pause: capability(false, '', LIVE_CONTROL_REASON),
      cancel: capability(false, '', LIVE_CONTROL_REASON),
      print: capability(false, '', LIVE_CONTROL_REASON),
      camera: capability(false, '', LIVE_CAMERA_REASON),
      provenance: this.#liveProvenance(freshness, observation.phase === 'observing' ? observation.ageMs : null),
    };
  }

  #liveStatus(live: LiveSource): PrinterStatus {
    const observation = live.observation();
    if (observation.phase === 'unavailable') throw new ServiceError('LIVE_UNAVAILABLE', observation.reason);
    if (observation.fields === null) throw new ServiceError('LIVE_UNAVAILABLE', 'No telemetry frame has been accepted yet.');
    const stale = observation.freshness === 'stale';
    const { fields } = observation;
    return {
      ...live.descriptor(),
      revision: observation.acceptedFrames,
      state: stale ? null : fields.state,
      jobId: null,
      progressPercent: stale ? null : fields.progressPercent,
      // No nozzle readings are extracted and the nozzle count is unknown, matching fixtureNozzleCount 0 in capabilities.
      temperatures: { nozzlesC: [], bedC: stale ? null : fields.bedC },
      timeRemainingSeconds: stale ? null : fields.timeRemainingSeconds,
      provenance: this.#liveProvenance(observation.freshness, observation.ageMs),
      warnings: [...(stale ? ['Telemetry is stale; values are withheld.'] : observation.warnings), NOZZLE_WARNING],
    };
  }

  #transport(printerId: string): MockTransport {
    if (!isSafeIdentifier(printerId)) throw new ServiceError('INVALID_ARGUMENT', 'Invalid local printer identifier.');
    const transport = this.#transports.get(printerId);
    if (!transport) throw new ServiceError('PRINTER_NOT_FOUND', 'Unknown mock printer.');
    return transport;
  }

  #time(): number {
    const value = this.#now();
    // Safe integers keep expiry arithmetic exact; huge values could overflow to Infinity.
    if (!Number.isSafeInteger(value) || value < 0) throw new ServiceError('INVALID_ARGUMENT', 'Clock must return a safe nonnegative integer timestamp.');
    return value;
  }

  #prunePlans(now: number): void {
    for (const [id, plan] of this.#plans) if (plan.expiresAt <= now) this.#plans.delete(id);
  }

  #capabilities(transport: MockTransport, snapshot: TransportSnapshot): PrinterCapabilities {
    const printer = transport.descriptor();
    const knownFirmware = firmwareSupported(printer);
    const adapted = adaptSnapshot(printer, snapshot);
    const readable = knownFirmware && adapted.protocolValid;
    const controls = readable && this.#enableMockControls && adapted.actionStateValid;
    const state = adapted.status.state;
    const inactive = state === 'idle' || state === 'completed' || state === 'cancelled';
    const active = state === 'printing' || state === 'paused';
    const blocked = !knownFirmware
      ? 'Unknown firmware; only exact synthetic mock-1.0 is allowlisted.'
      : !adapted.protocolValid
        ? 'Missing or unsupported synthetic frame protocol.'
        : !this.#enableMockControls
          ? 'Mock controls are disabled by server policy.'
          : !adapted.actionStateValid
            ? 'Complete consistent synthetic telemetry and job binding are required.'
            : 'Current mock state does not permit this action.';
    return {
      ...printer,
      firmwareSupported: knownFirmware,
      fixtureNozzleCount: FAMILY_PROFILES[printer.family].fixtureNozzleCount,
      status: capability(readable, 'Synthetic status decoding is available.', 'Unknown firmware or synthetic protocol; decoding is unavailable.'),
      pause: capability(controls && state === 'printing', 'Simulated pause is available for the current mock job.', blocked),
      cancel: capability(controls && active, 'Simulated cancel is available for the current mock job.', blocked),
      print: capability(controls && inactive, 'Simulated print is available for allowlisted mock artifacts.', blocked),
      camera: capability(readable && this.#enableMockCamera, 'Static synthetic camera fixture is available.', !readable ? 'Unknown firmware or synthetic protocol.' : 'Mock camera is disabled by server policy.'),
      provenance: mockProvenance(),
    };
  }

  async getCapabilities(printerId: string): Promise<PrinterCapabilities> {
    const live = this.#liveFor(printerId);
    if (live !== null) return this.#liveCapabilities(live);
    const transport = this.#transport(printerId);
    return this.#capabilities(transport, await transport.read());
  }

  async getStatus(printerId: string): Promise<PrinterStatus> {
    const live = this.#liveFor(printerId);
    if (live !== null) return this.#liveStatus(live);
    const transport = this.#transport(printerId);
    if (!firmwareSupported(transport.descriptor())) throw new ServiceError('UNSUPPORTED_FIRMWARE', 'Only exact synthetic mock-1.0 firmware is implemented.');
    const adapted = adaptSnapshot(transport.descriptor(), await transport.read());
    if (!adapted.protocolValid) throw new ServiceError('INVALID_FRAME', 'Missing or unsupported synthetic frame protocol.');
    return adapted.status;
  }

  async prepareAction(input: PrepareActionInput): Promise<ActionPlan> {
    if (!input || !isAction(input.action)) throw new ServiceError('INVALID_ARGUMENT', 'Action must be pause, cancel, or print.');
    if (input.action === 'print' ? !isMockArtifactId(input.artifactId) : input.artifactId !== undefined) {
      throw new ServiceError('INVALID_ARGUMENT', 'Print requires an allowlisted mock artifact; pause/cancel take no artifact.');
    }
    // Capture the caller's intent before yielding; later mutation of the input
    // object cannot alter the action or target bound into the plan.
    const { printerId, action, artifactId } = input;
    if (this.#liveFor(printerId) !== null) throw new ServiceError('CAPABILITY_UNAVAILABLE', LIVE_CONTROL_REASON);
    const transport = this.#transport(printerId);
    const snapshot = await transport.read();
    // A supported capability already requires complete, consistent action state for this
    // same snapshot, so no second adaptation or redundant validity check is needed.
    const caps = this.#capabilities(transport, snapshot);
    if (!caps[action].supported) throw new ServiceError('CAPABILITY_UNAVAILABLE', caps[action].reason);
    const jobId = adaptSnapshot(transport.descriptor(), snapshot).status.jobId;
    const now = this.#time();
    this.#prunePlans(now);
    // Bound memory even if an untrusted caller prepares repeatedly without executing.
    if (this.#plans.size >= MAX_PENDING_PLANS) throw new ServiceError('CAPABILITY_UNAVAILABLE', 'Too many pending mock plans; wait for expiry.');
    const expiresAt = now + this.#planTtlMs;
    if (expiresAt > Number.MAX_SAFE_INTEGER) throw new ServiceError('INVALID_ARGUMENT', 'Plan expiry would exceed the safe timestamp range.');
    const plan: Readonly<ActionPlan> = Object.freeze({
      planId: randomUUID(),
      printerId,
      action,
      artifactId: action === 'print' && isMockArtifactId(artifactId) ? artifactId : null,
      jobId,
      revision: snapshot.revision,
      expiresAt,
      notice: 'Mock simulation only. Caller confirmation is not independently verified human approval.',
    });
    this.#plans.set(plan.planId, plan);
    return { ...plan };
  }

  /** Every attempt consumes its plan, including denied/expired/stale attempts. */
  async executeAction(input: ExecuteActionInput): Promise<PrinterStatus> {
    if (!input || typeof input.planId !== 'string') throw new ServiceError('INVALID_ARGUMENT', 'A plan identifier is required.');
    const plan = this.#plans.get(input.planId);
    if (!plan) throw new ServiceError('PLAN_NOT_FOUND', 'Unknown or already consumed action plan.');
    // Consume before any await so concurrent calls cannot execute a plan twice.
    this.#plans.delete(input.planId);
    if (input.confirmed !== true) throw new ServiceError('CONFIRMATION_REQUIRED', 'Explicit confirmed: true is required for this mock simulation.');
    if (this.#time() >= plan.expiresAt) throw new ServiceError('PLAN_EXPIRED', 'Action plan expired; prepare a new plan.');
    const transport = this.#transport(plan.printerId);
    const current = await transport.read();
    const caps = this.#capabilities(transport, current);
    const adapted = adaptSnapshot(transport.descriptor(), current);
    if (current.revision !== plan.revision || adapted.status.jobId !== plan.jobId) {
      throw new ServiceError('STALE_PLAN', 'Printer state or job changed; prepare a new plan.');
    }
    if (!caps[plan.action].supported) throw new ServiceError('CAPABILITY_UNAVAILABLE', caps[plan.action].reason);
    if (this.#time() >= plan.expiresAt) throw new ServiceError('PLAN_EXPIRED', 'Action plan expired while checking state; prepare a new plan.');
    const updated = await transport.applyAction({
      action: plan.action,
      artifactId: plan.artifactId,
      expectedRevision: plan.revision,
      expectedJobId: plan.jobId,
    });
    return adaptSnapshot(transport.descriptor(), updated).status;
  }

  async getCamera(printerId: string): Promise<MockCameraFrame> {
    if (this.#liveFor(printerId) !== null) throw new ServiceError('CAPABILITY_UNAVAILABLE', LIVE_CAMERA_REASON);
    const transport = this.#transport(printerId);
    const caps = await this.getCapabilities(printerId);
    if (!caps.camera.supported) throw new ServiceError('CAPABILITY_UNAVAILABLE', caps.camera.reason);
    return transport.camera();
  }
}
