import { ServiceError } from './domain.js';
import { buildLiveConfig, parseLiveInputJson, takeLiveInputFromEnv } from './lan-config.js';
import type { LiveConfig, LiveInput } from './lan-config.js';
import { UNRESOLVED_CONTRACT_ITEMS, admitContract } from './lan-contract.js';
import type { Admission } from './lan-contract.js';
import { LanReadOnlySession } from './lan-session.js';
import type { LiveSession, SessionLimits, SessionReport } from './lan-session.js';
import { createTlsChannelFactory } from './lan-tls.js';
import { readBoundedRegularFile } from './safe-file.js';

/** Hard caps for one passive operator observation. */
export const SMOKE_LIMITS: Readonly<Partial<SessionLimits>> = Object.freeze({
  maxSessionMs: 60_000,
  maxMessages: 20,
  maxBytes: 1024 * 1024,
});

const MAX_STDIN_BYTES = 4_096;
const MAX_CA_FILE_BYTES = 16_384;

export interface SmokeRuntime {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Inherited environment; operator values are read from it and then removed. */
  env: Record<string, string | undefined>;
  stdinIsTty: boolean;
  /** Reads at most `maxBytes` of piped stdin up to the first newline or EOF. */
  readStdin(maxBytes: number): Promise<string>;
  /** Contract admission, checked before stdin or the environment are read. No override exists. */
  admission(): Admission;
  /** Bounded read of a regular file only. */
  readFile(path: string): string;
  createSession(config: LiveConfig, limits: Partial<SessionLimits>): LiveSession;
  onSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
  offSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
}

/** Collect stdin chunks, stopping at the first newline, and refuse more than `maxBytes`. */
export async function readBoundedLine(stream: AsyncIterable<Buffer | string>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += buffer.length;
    if (size > maxBytes) throw new RangeError('input too large');
    chunks.push(buffer);
    if (buffer.includes(0x0a)) break;
  }
  return Buffer.concat(chunks).toString('utf8').split('\n', 1)[0] ?? '';
}

/** The minimal process surface the real runtime needs; injectable so it can be tested. */
export interface ProcessIo {
  stdin: AsyncIterable<Buffer | string> & { isTTY?: boolean };
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
  once(signal: 'SIGINT' | 'SIGTERM', handler: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', handler: () => void): unknown;
}

export function createSmokeRuntime(io: ProcessIo): SmokeRuntime {
  return {
    stdout: (text) => { io.stdout.write(text); },
    stderr: (text) => { io.stderr.write(text); },
    env: io.env,
    stdinIsTty: io.stdin.isTTY === true,
    readStdin: (maxBytes) => readBoundedLine(io.stdin, maxBytes),
    admission: admitContract,
    readFile: (path) => readBoundedRegularFile(path, MAX_CA_FILE_BYTES),
    createSession: (config, limits) => new LanReadOnlySession({ config, channelFactory: createTlsChannelFactory(), limits }),
    onSignal: (signal, handler) => { io.once(signal, handler); },
    offSignal: (signal, handler) => { io.off(signal, handler); },
  };
}

const USAGE = [
  'bambu-printer-mcp X2D LAN read-only smoke observation (operator only)',
  '',
  'Usage: node dist/src/lan-smoke.js            (no arguments)',
  '',
  'Takes host, serial and access code only from the inherited BAMBU_X2D_* environment or from ONE JSON line on piped stdin.',
  'Never pass them as arguments. Subscribes to one exact topic, publishes nothing, never retries, and stops after 60 s, 20 messages or 1 MiB.',
  'Admission is closed while the wire contract is unverified and has no override; see docs/hardware-validation.md.',
  '',
].join('\n');

async function readInput(runtime: SmokeRuntime): Promise<LiveInput> {
  const fromEnvironment = takeLiveInputFromEnv(runtime.env);
  if (fromEnvironment.accessCode !== undefined || fromEnvironment.host !== undefined) return fromEnvironment;
  if (runtime.stdinIsTty) {
    throw new ServiceError('LIVE_CONFIG_INVALID', 'Interactive entry is not provided: pipe one JSON line on stdin or use the inherited environment.');
  }
  let line: string;
  try {
    line = await runtime.readStdin(MAX_STDIN_BYTES);
  } catch {
    throw new ServiceError('LIVE_CONFIG_INVALID', 'Invalid input.');
  }
  return parseLiveInputJson(line);
}

function summarize(report: SessionReport, session: LiveSession): { exitCode: number; text: string } {
  const graceful = report.end === 'closed' || report.end === 'limit';
  const observed = report.stats.framesAccepted > 0;
  const outcome = !graceful ? 'failed' : observed ? 'observed' : 'no-telemetry';
  const last = session.lastAccepted();
  const text = `${JSON.stringify({
    outcome,
    end: report.end,
    framesAccepted: report.stats.framesAccepted,
    messagesReceived: report.stats.messagesReceived,
    bytesReceived: report.stats.bytesReceived,
    ignoredByReason: report.stats.ignored,
    outboundPackets: report.stats.outboundPackets,
    blockedOutbound: report.stats.blockedOutbound,
    lastObservation: last === null ? null : {
      ...last.fields,
      nozzleTemperatures: 'unavailable-mapping-unverified',
      ageMsAtReport: Math.round(last.ageMs),
      freshnessAtReport: last.freshness,
      staleAfterMsProvisional: last.staleAfterMs,
      warnings: last.warnings,
    },
    contract: { verified: false, unresolved: UNRESOLVED_CONTRACT_ITEMS },
    note: 'Observation only. Compare values with the printer UI manually; nothing here verifies firmware, schema or the MQTT contract.',
  }, null, 2)}\n`;
  return { exitCode: !graceful ? 1 : observed ? 0 : 3, text };
}

/**
 * Operator-run, passive, subscribe-only observation. Exit codes: 0 telemetry observed, 1 failure
 * (TLS verification, authentication, subscription, protocol, timeout, cancellation: no retry),
 * 2 invalid input or closed admission (nothing was contacted), 3 session ended with no telemetry.
 * Only the whitelist-normalized fields and counters are printed; never the target, topic, code
 * or any raw payload.
 */
export async function runLanSmoke(args: string[], runtime: SmokeRuntime): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    runtime.stdout(USAGE);
    return 0;
  }
  if (args.length > 0) {
    runtime.stderr('No arguments are accepted: targets and secrets must never be passed on the command line.\n');
    return 2;
  }
  const admission = runtime.admission();
  if (!admission.admitted) {
    runtime.stderr(`${admission.reason}\n`);
    return 2;
  }
  let session: LiveSession;
  try {
    const config = buildLiveConfig(await readInput(runtime), runtime.readFile);
    session = runtime.createSession(config, SMOKE_LIMITS);
  } catch (error) {
    runtime.stderr(`${error instanceof ServiceError ? error.message : 'Live X2D read-only configuration failed.'}\n`);
    return 2;
  }
  const abort = new AbortController();
  const cancel = (): void => { abort.abort(); };
  runtime.onSignal('SIGINT', cancel);
  runtime.onSignal('SIGTERM', cancel);
  try {
    await session.start(abort.signal).catch(() => undefined);
    const { exitCode, text } = summarize(await session.finished, session);
    runtime.stdout(text);
    return exitCode;
  } finally {
    runtime.offSignal('SIGINT', cancel);
    runtime.offSignal('SIGTERM', cancel);
  }
}

if (import.meta.main) {
  process.exitCode = await runLanSmoke(process.argv.slice(2), createSmokeRuntime(process));
}
