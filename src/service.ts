import { randomUUID } from 'node:crypto';
import { FAMILY_PROFILES, adaptSnapshot, firmwareSupported } from './adapters.js';
import {
  ServiceError,
  isAction,
  isMockArtifactId,
  isSafeIdentifier,
  mockProvenance,
} from './domain.js';
import type {
  ActionPlan,
  Capability,
  ExecuteActionInput,
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

  constructor(transports: MockTransport[] = createDefaultMockFleet(), policy: ServicePolicy = {}) {
    if (!Array.isArray(transports) || transports.some((transport) => !(transport instanceof MockTransport))) {
      throw new ServiceError('INVALID_ARGUMENT', 'Only local MockTransport instances are accepted.');
    }
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
    return [...this.#transports.values()].map((transport) => transport.descriptor());
  }

  #transport(printerId: string): MockTransport {
    if (!isSafeIdentifier(printerId)) throw new ServiceError('INVALID_ARGUMENT', 'Invalid local printer identifier.');
    const transport = this.#transports.get(printerId);
    if (!transport) throw new ServiceError('PRINTER_NOT_FOUND', 'Unknown mock printer.');
    return transport;
  }

  #time(): number {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0) throw new ServiceError('INVALID_ARGUMENT', 'Clock must return a finite nonnegative timestamp.');
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
    const transport = this.#transport(printerId);
    return this.#capabilities(transport, await transport.read());
  }

  async getStatus(printerId: string): Promise<PrinterStatus> {
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
    const transport = this.#transport(printerId);
    const snapshot = await transport.read();
    const caps = this.#capabilities(transport, snapshot);
    if (!caps[action].supported) throw new ServiceError('CAPABILITY_UNAVAILABLE', caps[action].reason);
    const adapted = adaptSnapshot(transport.descriptor(), snapshot);
    if (!adapted.actionStateValid) throw new ServiceError('INVALID_FRAME', 'State changed or is incomplete; prepare again after checking status.');
    const now = this.#time();
    this.#prunePlans(now);
    // Bound memory even if an untrusted caller prepares repeatedly without executing.
    if (this.#plans.size >= 1_000) throw new ServiceError('CAPABILITY_UNAVAILABLE', 'Too many pending mock plans; wait for expiry.');
    const plan: Readonly<ActionPlan> = Object.freeze({
      planId: randomUUID(),
      printerId,
      action,
      artifactId: action === 'print' && isMockArtifactId(artifactId) ? artifactId : null,
      jobId: adapted.status.jobId,
      revision: snapshot.revision,
      expiresAt: now + this.#planTtlMs,
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
    const transport = this.#transport(printerId);
    const caps = await this.getCapabilities(printerId);
    if (!caps.camera.supported) throw new ServiceError('CAPABILITY_UNAVAILABLE', caps.camera.reason);
    return transport.camera();
  }
}
