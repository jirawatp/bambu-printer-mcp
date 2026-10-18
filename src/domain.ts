/** Prototype family names; these do not assert compatibility with physical printers. */
export const PRINTER_FAMILIES = ['A1', 'P1', 'X1', 'H2', 'X2D'] as const;
export type PrinterFamily = (typeof PRINTER_FAMILIES)[number];

/** An exact synthetic firmware allowlist; no real firmware is supported. */
export const MOCK_FIRMWARE = 'mock-1.0';
export const SYNTHETIC_PROTOCOL = 'bambu-mcp.synthetic.v1';
export const MOCK_ARTIFACTS = ['demo-cube', 'demo-benchy'] as const;
export type MockArtifactId = (typeof MOCK_ARTIFACTS)[number];
export type Action = 'pause' | 'cancel' | 'print';
export type PrinterState = 'idle' | 'printing' | 'paused' | 'completed' | 'cancelled';

/** Deliberately invented fixture protocol, not Bambu MQTT/FTP/camera wire data. */
export interface SyntheticFrame {
  protocol: typeof SYNTHETIC_PROTOCOL;
  state: PrinterState;
  jobId: string | null;
  artifactId: MockArtifactId | null;
  progressPercent: number;
  temperatures: { nozzlesC: number[]; bedC: number };
  timeRemainingSeconds: number;
}

export interface TransportSnapshot {
  revision: number;
  frame: unknown;
}

/** Every returned status explicitly identifies its simulated origin. */
export interface Provenance {
  transport: 'mock';
  protocol: typeof SYNTHETIC_PROTOCOL;
  hardwareValidated: false;
  compatibility: 'synthetic-fixture-only';
}

export interface PrinterDescriptor {
  id: string;
  family: PrinterFamily;
  firmware: string;
  transport: 'mock';
  hardwareValidated: false;
}

/** Unknown, absent, or out-of-range telemetry is null; values are never guessed. */
export interface PrinterStatus extends PrinterDescriptor {
  revision: number;
  state: PrinterState | null;
  jobId: string | null;
  progressPercent: number | null;
  temperatures: { nozzlesC: (number | null)[]; bedC: number | null };
  timeRemainingSeconds: number | null;
  provenance: Provenance;
  warnings: string[];
}

export interface Capability {
  supported: boolean;
  reason: string;
}

/** Dynamic capabilities include policy, firmware, frame validity, and current state. */
export interface PrinterCapabilities extends PrinterDescriptor {
  firmwareSupported: boolean;
  fixtureNozzleCount: number;
  status: Capability;
  pause: Capability;
  cancel: Capability;
  print: Capability;
  camera: Capability;
  provenance: Provenance;
}

/** Programmatic policy only enables local simulations, never hardware access. */
export interface ServicePolicy {
  enableMockControls?: boolean;
  enableMockCamera?: boolean;
  planTtlMs?: number;
  /** Injectable clock for deterministic expiration tests. */
  now?: () => number;
}

export interface PrepareActionInput {
  printerId: string;
  action: Action;
  artifactId?: string | undefined;
}

/** A short-lived, single-use simulation intent bound to exact printer/job/revision. */
export interface ActionPlan {
  planId: string;
  printerId: string;
  action: Action;
  artifactId: MockArtifactId | null;
  jobId: string | null;
  revision: number;
  expiresAt: number;
  notice: string;
}

export interface ExecuteActionInput {
  planId: string;
  /** This is a caller assertion, not independent or authenticated human approval. */
  confirmed: boolean;
}

export interface MockCameraFrame {
  printerId: string;
  contentType: 'image/svg+xml';
  data: string;
  description: string;
  provenance: Provenance;
}

export type ServiceErrorCode =
  | 'INVALID_ARGUMENT'
  | 'PRINTER_NOT_FOUND'
  | 'UNSUPPORTED_FIRMWARE'
  | 'INVALID_FRAME'
  | 'CAPABILITY_UNAVAILABLE'
  | 'CONFIRMATION_REQUIRED'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_EXPIRED'
  | 'STALE_PLAN';

/** Predictable, secret-free errors suitable for MCP tool error responses. */
export class ServiceError extends Error {
  constructor(public readonly code: ServiceErrorCode, message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

export function mockProvenance(): Provenance {
  return {
    transport: 'mock',
    protocol: SYNTHETIC_PROTOCOL,
    hardwareValidated: false,
    compatibility: 'synthetic-fixture-only',
  };
}

/** Only conservative identifiers, never network locations or credentials. */
export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
}

export function isMockArtifactId(value: unknown): value is MockArtifactId {
  return typeof value === 'string' && MOCK_ARTIFACTS.some((id) => id === value);
}

export function isAction(value: unknown): value is Action {
  return value === 'pause' || value === 'cancel' || value === 'print';
}
