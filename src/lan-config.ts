import { ServiceError } from './domain.js';
import { X2D_SERIAL_PREFIX } from './lan-contract.js';

/**
 * Ephemeral operator input for the optional X2D LAN read-only path. Nothing here is persisted,
 * accepted as a command-line argument or returned through MCP. Errors name only the failing
 * field, never its value.
 */
export interface LiveInput {
  host?: unknown;
  serial?: unknown;
  accessCode?: unknown;
  caFile?: unknown;
}

export interface LiveConfig {
  /** Literal private IPv4 address; no DNS name, range or scan. */
  host: string;
  serial: string;
  accessCode: string;
  caPem: string;
}

/** Public vendor CA shipped inside the installed Studio app; a public certificate, not a secret. */
export const DEFAULT_STUDIO_CA_FILE = '/Applications/BambuStudio.app/Contents/Resources/cert/printer.cer';
export const ENV_HOST = 'BAMBU_X2D_HOST';
export const ENV_SERIAL = 'BAMBU_X2D_SERIAL';
export const ENV_ACCESS_CODE = 'BAMBU_X2D_ACCESS_CODE';
export const ENV_CA_FILE = 'BAMBU_X2D_CA_FILE';
const MAX_CA_BYTES = 16_384;
const MAX_CA_CERTIFICATES = 4;

function invalid(field: string): ServiceError {
  return new ServiceError('LIVE_CONFIG_INVALID', `Invalid ${field}.`);
}

function octet(part: string): number | null {
  return /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255 ? Number(part) : null;
}

/** True only for a canonical dotted-quad inside 10/8, 172.16/12 or 192.168/16. */
export function isPrivateIPv4Literal(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map(octet);
  if (octets.some((part) => part === null)) return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function isX2dSerial(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${X2D_SERIAL_PREFIX}[0-9A-Z]{6,20}$`).test(value);
}

function isAccessCode(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{4,64}$/.test(value);
}

/** Read and remove operator-provided values from an inherited environment object. */
export function takeLiveInputFromEnv(env: Record<string, string | undefined>): LiveInput {
  const input: LiveInput = {
    host: env[ENV_HOST],
    serial: env[ENV_SERIAL],
    accessCode: env[ENV_ACCESS_CODE],
    caFile: env[ENV_CA_FILE],
  };
  for (const key of [ENV_HOST, ENV_SERIAL, ENV_ACCESS_CODE, ENV_CA_FILE]) delete env[key];
  return input;
}

const STDIN_KEYS: readonly string[] = ['host', 'serial', 'accessCode', 'caFile'];

/** Parse one strict JSON object from operator stdin. Unknown keys and non-strings are rejected. */
export function parseLiveInputJson(text: string): LiveInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('input');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid('input');
  const record = parsed as Record<string, unknown>;
  const input: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (!STDIN_KEYS.includes(key) || typeof record[key] !== 'string') throw invalid('input');
    input[key] = record[key];
  }
  return input as LiveInput;
}

function readCa(caFile: unknown, readFile: (path: string) => string): string {
  const path = caFile === undefined ? DEFAULT_STUDIO_CA_FILE : caFile;
  if (typeof path !== 'string' || path.length > 1024 || !path.startsWith('/') || path.includes('\0')) throw invalid('CA file');
  let pem: string;
  try {
    pem = readFile(path);
  } catch {
    throw invalid('CA file');
  }
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;
  if (Buffer.byteLength(pem) > MAX_CA_BYTES || certificates < 1 || certificates > MAX_CA_CERTIFICATES) throw invalid('CA file');
  return pem;
}

/**
 * Validate and assemble a session configuration. This is validation only: contract admission is
 * enforced by `LanReadOnlySession` itself and cannot be granted by any input value. Every failure
 * is a bounded ServiceError naming only the field.
 */
export function buildLiveConfig(input: LiveInput, readFile: (path: string) => string): LiveConfig {
  if (!isPrivateIPv4Literal(input.host)) throw invalid('host');
  if (!isX2dSerial(input.serial)) throw invalid('serial');
  if (!isAccessCode(input.accessCode)) throw invalid('access code');
  return { host: input.host, serial: input.serial, accessCode: input.accessCode, caPem: readCa(input.caFile, readFile) };
}
