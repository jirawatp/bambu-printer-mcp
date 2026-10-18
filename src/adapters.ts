import {
  MOCK_FIRMWARE,
  SYNTHETIC_PROTOCOL,
  mockProvenance,
} from './domain.js';
import type {
  PrinterDescriptor,
  PrinterFamily,
  PrinterState,
  PrinterStatus,
  TransportSnapshot,
} from './domain.js';

export interface FamilyProfile {
  family: PrinterFamily;
  /** Synthetic fixture channel count only; not a universal hardware assertion. */
  fixtureNozzleCount: number;
  supportedFirmware: readonly string[];
}

/** Separate profiles leave room for later model AND firmware-specific adapters. */
export const FAMILY_PROFILES: Readonly<Record<PrinterFamily, FamilyProfile>> = Object.freeze({
  A1: Object.freeze({ family: 'A1', fixtureNozzleCount: 1, supportedFirmware: Object.freeze([MOCK_FIRMWARE]) }),
  P1: Object.freeze({ family: 'P1', fixtureNozzleCount: 1, supportedFirmware: Object.freeze([MOCK_FIRMWARE]) }),
  X1: Object.freeze({ family: 'X1', fixtureNozzleCount: 1, supportedFirmware: Object.freeze([MOCK_FIRMWARE]) }),
  H2: Object.freeze({ family: 'H2', fixtureNozzleCount: 2, supportedFirmware: Object.freeze([MOCK_FIRMWARE]) }),
  X2D: Object.freeze({ family: 'X2D', fixtureNozzleCount: 2, supportedFirmware: Object.freeze([MOCK_FIRMWARE]) }),
});

export interface AdaptedSnapshot {
  status: PrinterStatus;
  protocolValid: boolean;
  /** All telemetry and state needed for conservative mock mutations is present. */
  actionStateValid: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function parseState(value: unknown): PrinterState | null {
  return value === 'idle' || value === 'printing' || value === 'paused' || value === 'completed' || value === 'cancelled'
    ? value
    : null;
}

export function firmwareSupported(printer: PrinterDescriptor): boolean {
  return FAMILY_PROFILES[printer.family].supportedFirmware.includes(printer.firmware);
}

/**
 * Normalize an untrusted synthetic snapshot. Bounds protect consumers from NaN,
 * infinity and nonsensical readings; they are fixture validation limits, not
 * instructions or safety limits for a physical Bambu Lab printer.
 */
export function adaptSnapshot(printer: PrinterDescriptor, snapshot: TransportSnapshot): AdaptedSnapshot {
  const profile = FAMILY_PROFILES[printer.family];
  const candidate = object(snapshot.frame);
  const protocolValid = candidate?.protocol === SYNTHETIC_PROTOCOL;
  const frame = protocolValid ? candidate : null;
  const warnings: string[] = [];
  if (!protocolValid) warnings.push('Unsupported or missing synthetic frame protocol.');

  const state = parseState(frame?.state);
  const jobValue = frame?.jobId;
  const jobValid = jobValue === null || (typeof jobValue === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(jobValue));
  const jobId = typeof jobValue === 'string' && jobValid ? jobValue : null;
  const progressPercent = finiteInRange(frame?.progressPercent, 0, 100);
  const timeRemainingSeconds = finiteInRange(frame?.timeRemainingSeconds, 0, 31_536_000);
  const temperatures = object(frame?.temperatures);
  const rawNozzles = Array.isArray(temperatures?.nozzlesC) ? temperatures.nozzlesC : [];
  const nozzlesC = Array.from({ length: profile.fixtureNozzleCount }, (_, index) => finiteInRange(rawNozzles[index], 0, 350));
  const bedC = finiteInRange(temperatures?.bedC, 0, 150);

  if (state === null) warnings.push('Missing or invalid state.');
  if (!jobValid) warnings.push('Missing or invalid job binding.');
  if (progressPercent === null) warnings.push('Missing or invalid progress.');
  if (timeRemainingSeconds === null) warnings.push('Missing or invalid time remaining.');
  if (rawNozzles.length !== profile.fixtureNozzleCount || nozzlesC.some((value) => value === null)) {
    warnings.push('Missing, invalid, or unexpected synthetic nozzle temperature channels.');
  }
  if (bedC === null) warnings.push('Missing or invalid bed temperature.');

  const active = state === 'printing' || state === 'paused';
  const consistentJob = state !== null && jobValid && (active ? jobId !== null : jobValue === null);
  if (state !== null && jobValid && !consistentJob) warnings.push('State and job binding are inconsistent.');

  return {
    protocolValid,
    actionStateValid: protocolValid && warnings.length === 0 && consistentJob,
    status: {
      ...printer,
      revision: snapshot.revision,
      state,
      jobId,
      progressPercent,
      temperatures: { nozzlesC, bedC },
      timeRemainingSeconds,
      provenance: mockProvenance(),
      warnings,
    },
  };
}
