import { randomUUID } from 'node:crypto';
import { FAMILY_PROFILES, adaptSnapshot } from './adapters.js';
import {
  MOCK_FIRMWARE,
  PRINTER_FAMILIES,
  SYNTHETIC_PROTOCOL,
  ServiceError,
  isAction,
  isMockArtifactId,
  isSafeIdentifier,
  mockProvenance,
} from './domain.js';
import type {
  Action,
  MockArtifactId,
  MockCameraFrame,
  PrinterDescriptor,
  PrinterFamily,
  SyntheticFrame,
  TransportSnapshot,
} from './domain.js';

export interface MockTransportOptions {
  id: string;
  family: PrinterFamily;
  firmware?: string;
  /** May intentionally contain malformed values for fail-closed tests. */
  frame?: unknown;
}

export interface MockActionCommand {
  action: Action;
  artifactId: MockArtifactId | null;
  expectedRevision: number;
  expectedJobId: string | null;
}

/** Make a complete invented frame; overrides are useful for local test fixtures. */
export function createMockFrame(family: PrinterFamily, overrides: Partial<SyntheticFrame> = {}): SyntheticFrame {
  return {
    protocol: SYNTHETIC_PROTOCOL,
    state: 'printing',
    jobId: 'mock-job',
    artifactId: 'demo-cube',
    progressPercent: 42,
    temperatures: {
      nozzlesC: Array.from({ length: FAMILY_PROFILES[family].fixtureNozzleCount }, () => 205),
      bedC: 55,
    },
    timeRemainingSeconds: 1_800,
    ...structuredClone(overrides),
  };
}

/**
 * In-memory simulator with no sockets, HTTP, MQTT, file uploads or credentials.
 * Revision increments on every replacement/mutation and is checked atomically
 * when applying a command. Reads return clones, never live mutable state.
 */
export class MockTransport {
  readonly id: string;
  readonly family: PrinterFamily;
  readonly firmware: string;
  #frame: unknown;
  #revision = 0;

  constructor(options: MockTransportOptions) {
    if (!isSafeIdentifier(options.id)) throw new ServiceError('INVALID_ARGUMENT', 'Printer ID must be a conservative local identifier.');
    if (!PRINTER_FAMILIES.includes(options.family)) throw new ServiceError('INVALID_ARGUMENT', 'Unknown printer family.');
    if (options.firmware !== undefined && (typeof options.firmware !== 'string' || options.firmware.length > 64)) {
      throw new ServiceError('INVALID_ARGUMENT', 'Firmware identifier is invalid.');
    }
    this.id = options.id;
    this.family = options.family;
    this.firmware = options.firmware ?? MOCK_FIRMWARE;
    this.#frame = structuredClone(Object.hasOwn(options, 'frame')
      ? options.frame
      : createMockFrame(this.family, { jobId: `mock-job-${this.id}` }));
  }

  get revision(): number { return this.#revision; }

  descriptor(): PrinterDescriptor {
    return { id: this.id, family: this.family, firmware: this.firmware, transport: 'mock', hardwareValidated: false };
  }

  async read(): Promise<TransportSnapshot> {
    return { revision: this.#revision, frame: structuredClone(this.#frame) };
  }

  /** Local test hook simulating an external state update; never contacts a device. */
  replaceFrame(frame: unknown): void {
    this.#frame = structuredClone(frame);
    this.#revision += 1;
  }

  /** A command may only mutate a complete known synthetic frame at its exact revision. */
  async applyAction(command: MockActionCommand): Promise<TransportSnapshot> {
    if (this.firmware !== MOCK_FIRMWARE) throw new ServiceError('UNSUPPORTED_FIRMWARE', 'Only synthetic mock-1.0 firmware is implemented.');
    if (!isAction(command.action)) throw new ServiceError('INVALID_ARGUMENT', 'Unknown mock action.');
    if (command.action === 'print' ? !isMockArtifactId(command.artifactId) : command.artifactId !== null) {
      throw new ServiceError('INVALID_ARGUMENT', 'Only allowlisted mock artifacts may be used for print.');
    }
    if (command.expectedRevision !== this.#revision) throw new ServiceError('STALE_PLAN', 'Printer revision changed; prepare a new plan.');
    const adapted = adaptSnapshot(this.descriptor(), { revision: this.#revision, frame: this.#frame });
    if (!adapted.actionStateValid) throw new ServiceError('INVALID_FRAME', 'Complete consistent synthetic state is required for a mock action.');
    if (adapted.status.jobId !== command.expectedJobId) throw new ServiceError('STALE_PLAN', 'Printer job changed; prepare a new plan.');
    const frame = structuredClone(this.#frame) as SyntheticFrame;
    if (command.action === 'pause') {
      if (frame.state !== 'printing') throw new ServiceError('CAPABILITY_UNAVAILABLE', 'Pause requires a printing mock job.');
      frame.state = 'paused';
    } else if (command.action === 'cancel') {
      if (frame.state !== 'printing' && frame.state !== 'paused') throw new ServiceError('CAPABILITY_UNAVAILABLE', 'Cancel requires an active mock job.');
      frame.state = 'cancelled';
      frame.jobId = null;
      frame.artifactId = null;
      frame.timeRemainingSeconds = 0;
    } else {
      if (frame.state !== 'idle' && frame.state !== 'completed' && frame.state !== 'cancelled') {
        throw new ServiceError('CAPABILITY_UNAVAILABLE', 'Print requires an inactive mock printer.');
      }
      frame.state = 'printing';
      frame.jobId = `mock-job-${randomUUID()}`;
      frame.artifactId = command.artifactId;
      frame.progressPercent = 0;
      frame.timeRemainingSeconds = 3_600;
    }
    this.#frame = frame;
    this.#revision += 1;
    return { revision: this.#revision, frame: structuredClone(this.#frame) };
  }

  /** A literal SVG fixture, never a camera URL, stream token, or hardware image. */
  async camera(): Promise<MockCameraFrame> {
    return {
      printerId: this.id,
      contentType: 'image/svg+xml',
      data: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#142533"/><rect x="220" y="105" width="200" height="150" rx="10" fill="#3b7283"/><text x="320" y="300" fill="#fff" font-family="sans-serif" font-size="22" text-anchor="middle">SYNTHETIC MOCK CAMERA</text></svg>',
      description: 'Static synthetic camera fixture; no physical camera connection.',
      provenance: mockProvenance(),
    };
  }
}

export function createDefaultMockFleet(): MockTransport[] {
  return PRINTER_FAMILIES.map((family) => new MockTransport({ id: `mock-${family.toLowerCase()}`, family }));
}
