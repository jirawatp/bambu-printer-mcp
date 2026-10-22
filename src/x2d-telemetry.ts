import type { PrinterState } from './domain.js';

/**
 * Normalizes a Bambu LAN `report` payload into a tiny whitelist. Field names follow the public
 * BambuStudio parser (DeviceManager.cpp, DeviceCore/DevBed.cpp); that is Studio-side evidence,
 * not proof of what any X2D firmware emits. Everything not whitelisted - job and file names,
 * identifiers, AMS/filament data, network info, raw keys - is dropped and never retained.
 *
 * Extruder/nozzle temperatures are intentionally NOT extracted: the extruder-id to physical
 * nozzle mapping for this printer is unverified, so no nozzle values are extracted.
 */
export interface LiveFields {
  state: PrinterState | null;
  progressPercent: number | null;
  timeRemainingSeconds: number | null;
  bedC: number | null;
}

export type IgnoreReason =
  | 'oversized'
  | 'malformed-json'
  | 'not-an-object'
  | 'no-print-object'
  | 'not-status'
  | 'diff-message'
  | 'unsupported-message-type';

export type ReportOutcome =
  | { kind: 'status'; fields: LiveFields; warnings: string[] }
  | { kind: 'ignored'; reason: IgnoreReason };

export const DEFAULT_MAX_REPORT_BYTES = 262_144;

const MAX_REMAINING_MINUTES = 525_600;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const STATE_MAP: Readonly<Record<string, PrinterState>> = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'printing',
  PAUSE: 'paused',
  FINISH: 'completed',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Studio accepts integers or numeric strings for these fields; so do we, within strict bounds. */
function boundedInteger(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function bedTemperature(print: Record<string, unknown>): number | null {
  const device = print.device;
  if (isRecord(device) && Object.hasOwn(device, 'bed_temp')) {
    // Newer firmware packs current temperature in the low 16 bits and target in the high 16.
    const packed = boundedInteger(device.bed_temp, 0, 0xffff_ffff);
    if (packed === null) return null;
    const current = packed % 0x1_0000;
    return current <= 150 ? current : null;
  }
  const legacy = print.bed_temper;
  return typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= 0 && legacy <= 150 ? legacy : null;
}

export function parseReportPayload(payload: Uint8Array, maxBytes = DEFAULT_MAX_REPORT_BYTES): ReportOutcome {
  if (payload.length > maxBytes) return { kind: 'ignored', reason: 'oversized' };
  let root: unknown;
  try {
    root = JSON.parse(utf8.decode(payload));
  } catch {
    return { kind: 'ignored', reason: 'malformed-json' };
  }
  if (!isRecord(root)) return { kind: 'ignored', reason: 'not-an-object' };
  const print = root.print;
  if (!isRecord(print)) return { kind: 'ignored', reason: 'no-print-object' };
  if (print.command !== 'push_status') return { kind: 'ignored', reason: 'not-status' };
  // Studio treats msg 1 as a diff that needs a retained base; this passive path never sends
  // pushall, so it cannot reconstruct a diff and refuses to guess.
  if (print.msg === 1) return { kind: 'ignored', reason: 'diff-message' };
  if (print.msg !== undefined && print.msg !== 0) return { kind: 'ignored', reason: 'unsupported-message-type' };

  const rawState = print.gcode_state;
  const state = typeof rawState === 'string' && Object.hasOwn(STATE_MAP, rawState) ? STATE_MAP[rawState]! : null;
  const progressPercent = boundedInteger(print.mc_percent, 0, 100);
  const minutes = boundedInteger(print.mc_remaining_time, 0, MAX_REMAINING_MINUTES);
  const fields: LiveFields = {
    state,
    progressPercent,
    timeRemainingSeconds: minutes === null ? null : minutes * 60,
    bedC: bedTemperature(print),
  };
  const warnings: string[] = [];
  if (fields.state === null) warnings.push('State is missing or not mapped.');
  if (fields.progressPercent === null) warnings.push('Progress is missing or invalid.');
  if (fields.timeRemainingSeconds === null) warnings.push('Time remaining is missing or invalid.');
  if (fields.bedC === null) warnings.push('Bed temperature is missing or invalid.');
  return { kind: 'status', fields, warnings };
}
