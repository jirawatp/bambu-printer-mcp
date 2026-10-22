import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ENV_ACCESS_CODE, ENV_HOST, ENV_SERIAL } from '../src/lan-config.js';
import { UNRESOLVED_CONTRACT_ITEMS, admitContract } from '../src/lan-contract.js';
import { ObservationEngine } from '../src/lan-engine.js';
import { SMOKE_LIMITS, createSmokeRuntime, readBoundedLine, runLanSmoke } from '../src/lan-smoke.js';
import type { ProcessIo, SmokeRuntime } from '../src/lan-smoke.js';
import { STAGE_TEXT } from '../src/lan-session.js';
import type { ChannelHandlers, SessionLimits } from '../src/lan-session.js';
import { CA_PEM, CODE, HOST, SERIAL, TOPIC, connack, operatorInput, publish, recordingFactory, status, suback, writtenTypes } from './lan-helpers.js';

const smokePath = fileURLToPath(new URL('../src/lan-smoke.js', import.meta.url));

interface Options {
  env?: Record<string, string | undefined>;
  tty?: boolean;
  stdin?: string | ((max: number) => Promise<string>);
  broker?: (handlers: ChannelHandlers) => void;
  limits?: Partial<SessionLimits>;
  realAdmission?: boolean;
  /** Injected wall clock for the engine (wall only, deterministic). */
  clock?: () => number;
}

function rig(options: Options = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const created: { limits: Partial<SessionLimits> }[] = [];
  const signals = new Map<string, () => void>();
  const removed: string[] = [];
  const recording = recordingFactory({
    onCreate: (handlers) => queueMicrotask(() => (options.broker ?? ((h) => { h.secure(); h.data(connack()); h.data(suback()); }))(handlers)),
  });
  const env = options.env ?? {};
  const reads = { stdin: 0, files: 0 };
  const runtime: SmokeRuntime = {
    stdout: (text) => { out.push(text); },
    stderr: (text) => { err.push(text); },
    env,
    stdinIsTty: options.tty ?? false,
    // The flow is exercised with admission injected open and an engine, which the real runtime can never produce.
    admission: options.realAdmission === true ? admitContract : () => ({ admitted: true }),
    readStdin: async (max) => {
      reads.stdin += 1;
      return typeof options.stdin === 'function' ? options.stdin(max) : (options.stdin ?? '');
    },
    readFile: () => { reads.files += 1; return CA_PEM; },
    createSession: (config, limits) => {
      created.push({ limits });
      return new ObservationEngine({ config, channelFactory: recording.factory, limits: { ...limits, ...options.limits }, ...(options.clock === undefined ? {} : { now: options.clock }) });
    },
    onSignal: (signal, handler) => { signals.set(signal, handler); },
    offSignal: (signal) => { removed.push(signal); signals.delete(signal); },
  };
  return { runtime, out, err, created, signals, removed, recording, env, reads };
}

const burst = (count: number) => (handlers: ChannelHandlers): void => {
  handlers.secure();
  handlers.data(connack());
  handlers.data(suback());
  for (let index = 0; index < count; index += 1) handlers.data(publish(TOPIC, status()));
};

const stdinInput = (override: Record<string, unknown> = {}): string => JSON.stringify({ ...operatorInput(), ...override });

test('--help prints usage and nothing else; arguments of any other kind are refused without contact', async () => {
  const help = rig();
  assert.equal(await runLanSmoke(['--help'], help.runtime), 0);
  assert.match(help.out.join(''), /no arguments/i);
  assert.match(help.out.join(''), /60 s, 20 messages or 1 MiB/);
  assert.deepEqual(help.err, []);
  for (const args of [['--host', HOST], [`--access-code=${CODE}`], ['x'], ['--help', 'extra'], ['']]) {
    const state = rig({ stdin: stdinInput() });
    assert.equal(await runLanSmoke(args, state.runtime), 2);
    assert.equal(state.err.length, 1);
    assert.doesNotMatch(state.err.join(''), new RegExp(`${CODE}|${HOST}|${SERIAL}`));
    assert.deepEqual(state.out, []);
    assert.equal(state.recording.recorder.targets.length, 0);
  }
});

test('it never prompts: a terminal without environment input is refused', async () => {
  const state = rig({ tty: true });
  assert.equal(await runLanSmoke([], state.runtime), 2);
  assert.match(state.err.join(''), /Interactive entry is not provided/);
  assert.equal(state.recording.recorder.targets.length, 0);
});

test('missing, oversized, malformed or unknown stdin input is refused before any connection', async () => {
  const cases: Options[] = [
    { stdin: '' },
    { stdin: '{not json' },
    { stdin: stdinInput({ extra: 'x' }) },
    { stdin: () => Promise.reject(new RangeError(`too large ${CODE}`)) },
  ];
  for (const options of cases) {
    const state = rig(options);
    assert.equal(await runLanSmoke([], state.runtime), 2);
    assert.equal(state.err.join(''), 'Invalid input.\n');
    assert.equal(state.recording.recorder.targets.length, 0);
    assert.equal(state.created.length, 0);
  }
});

test('closed real admission refuses before reading stdin, the environment or any file, and never connects', async () => {
  const env: Record<string, string | undefined> = { BAMBU_X2D_HOST: HOST, BAMBU_X2D_SERIAL: SERIAL, BAMBU_X2D_ACCESS_CODE: CODE };
  const before = { ...env };
  const state = rig({ env, stdin: stdinInput(), realAdmission: true });
  assert.equal(await runLanSmoke([], state.runtime), 2);
  for (const item of UNRESOLVED_CONTRACT_ITEMS) assert.match(state.err.join(''), new RegExp(item));
  assert.match(state.err.join(''), /no operator override/);
  assert.doesNotMatch(state.err.join(''), new RegExp(`${CODE}|${HOST}|${SERIAL}`));
  assert.deepEqual(state.reads, { stdin: 0, files: 0 });
  assert.deepEqual(env, before, 'environment values were not even consumed');
  assert.equal(state.created.length, 0);
  assert.deepEqual(state.out, []);
  assert.equal(state.recording.recorder.targets.length, 0);
});

test('an invalid host fails with a field-only message', async () => {
  const state = rig({ stdin: stdinInput({ host: 'printer.invalid' }) });
  assert.equal(await runLanSmoke([], state.runtime), 2);
  assert.equal(state.err.join(''), 'Invalid host.\n');
});

test('an unexpected session construction failure is reported generically', async () => {
  const state = rig({ stdin: stdinInput() });
  state.runtime.createSession = () => { throw new Error(`SECRET ${CODE}`); };
  assert.equal(await runLanSmoke([], state.runtime), 2);
  assert.equal(state.err.join(''), 'Live X2D read-only configuration failed.\n');
});

test('environment input is accepted, scrubbed from the environment and takes precedence over stdin', async () => {
  const env: Record<string, string | undefined> = {
    [ENV_HOST]: HOST, [ENV_SERIAL]: SERIAL, [ENV_ACCESS_CODE]: CODE, UNRELATED: 'kept',
  };
  const state = rig({ env, stdin: () => Promise.reject(new Error('stdin must not be read')), broker: burst(1), limits: { maxMessages: 1 } });
  assert.equal(await runLanSmoke([], state.runtime), 0);
  assert.deepEqual(env, { UNRELATED: 'kept' });
});

test('a bounded successful observation prints only whitelisted fields and counters and exits 0', async () => {
  const state = rig({ stdin: stdinInput(), broker: burst(25) });
  assert.equal(await runLanSmoke([], state.runtime), 0);
  assert.deepEqual(state.created.map((entry) => entry.limits), [SMOKE_LIMITS]);
  assert.deepEqual(SMOKE_LIMITS, { maxSessionMs: 60_000, maxMessages: 20, maxBytes: 1_048_576 });
  const report = JSON.parse(state.out.join('')) as Record<string, unknown>;
  assert.equal(report.outcome, 'observed');
  assert.equal(report.end, 'limit', 'the 20 message cap stops the run');
  assert.equal(report.framesAccepted, 20);
  assert.equal(report.messagesReceived, 20);
  assert.deepEqual(report.outboundPackets, { connect: 1, subscribe: 1, pingreq: 0, disconnect: 1 });
  assert.equal(report.blockedOutbound, 0);
  const { ageMsAtReport, ...disclosed } = report.lastObservation as Record<string, unknown>;
  assert.deepEqual(disclosed, {
    state: 'printing', progressPercent: 42, timeRemainingSeconds: 1800, bedC: 55, nozzleTemperatures: 'unavailable-mapping-unverified',
    freshnessAtReport: 'fresh', staleAfterMsProvisional: 60_000, warnings: [],
  });
  assert.equal(typeof ageMsAtReport, 'number');
  assert.ok((ageMsAtReport as number) >= 0 && (ageMsAtReport as number) < 60_000);
  assert.deepEqual((report.contract as { verified: boolean; unresolved: string[] }), { verified: false, unresolved: [...UNRESOLVED_CONTRACT_ITEMS] });
  assert.match(String(report.note), /nothing here verifies/);
  assert.deepEqual(writtenTypes(state.recording.recorder), [1, 8, 14]);
  assert.doesNotMatch(state.out.join(''), new RegExp(`${CODE}|${HOST}|${SERIAL}|device/`));
  assert.deepEqual(state.err, []);
  assert.deepEqual(state.removed.sort(), ['SIGINT', 'SIGTERM']);
});

test('the printed observation discloses how old the last frame was when the report was made', async () => {
  let time = 2_000_000;
  const state = rig({
    stdin: stdinInput(),
    clock: () => time,
    limits: { maxMessages: 1 },
    broker: (handlers) => { burst(1)(handlers); time += 90_000; },
  });
  assert.equal(await runLanSmoke([], state.runtime), 0);
  const report = JSON.parse(state.out.join('')) as { lastObservation: Record<string, unknown> };
  assert.equal(report.lastObservation.ageMsAtReport, 90_000);
  assert.equal(report.lastObservation.freshnessAtReport, 'stale');
  assert.equal(report.lastObservation.staleAfterMsProvisional, 60_000);
});

test('an unrelated or malformed payload is counted by reason, never printed', async () => {
  const state = rig({
    stdin: stdinInput(),
    limits: { maxMessages: 2 },
    broker: (handlers) => {
      handlers.secure(); handlers.data(connack()); handlers.data(suback());
      handlers.data(publish(TOPIC, '{PEER-CANARY'));
      handlers.data(publish(TOPIC, JSON.stringify({ print: { command: 'push_status', msg: 1 } })));
    },
  });
  assert.equal(await runLanSmoke([], state.runtime), 3);
  const report = JSON.parse(state.out.join('')) as Record<string, unknown>;
  assert.equal(report.outcome, 'no-telemetry');
  assert.deepEqual(report.ignoredByReason, { 'malformed-json': 1, 'diff-message': 1 });
  assert.equal(report.lastObservation, null);
  assert.doesNotMatch(state.out.join(''), /PEER-CANARY/);
});

test('silence until the session cap ends gracefully with no telemetry (exit 3)', async () => {
  const state = rig({ stdin: stdinInput(), limits: { maxSessionMs: 40, tickMs: 10 } });
  const keepAlive = setTimeout(() => undefined, 5_000);
  try {
    assert.equal(await runLanSmoke([], state.runtime), 3);
  } finally {
    clearTimeout(keepAlive);
  }
  const report = JSON.parse(state.out.join('')) as Record<string, unknown>;
  assert.equal(report.outcome, 'no-telemetry');
  assert.equal(report.end, 'limit');
});

test('authentication rejection closes immediately without retry, exits 1 and prints no secret', async () => {
  const state = rig({ stdin: stdinInput(), broker: (handlers) => { handlers.secure(); handlers.data(connack(5)); } });
  assert.equal(await runLanSmoke([], state.runtime), 1);
  const report = JSON.parse(state.out.join('')) as Record<string, unknown>;
  assert.equal(report.outcome, 'failed');
  assert.equal(report.end, 'authentication');
  assert.equal(state.recording.recorder.targets.length, 1);
  assert.deepEqual(writtenTypes(state.recording.recorder), [1]);
  assert.deepEqual(report.outboundPackets, { connect: 1, subscribe: 0, pingreq: 0, disconnect: 0 });
  assert.doesNotMatch(state.out.join(''), new RegExp(`${CODE}|${HOST}|${SERIAL}|${STAGE_TEXT.authentication}`));
});

test('certificate verification failure exits 1 without ever sending the access code', async () => {
  const state = rig({ stdin: stdinInput(), broker: (handlers) => { handlers.failed('tls-verify'); } });
  assert.equal(await runLanSmoke([], state.runtime), 1);
  assert.equal((JSON.parse(state.out.join('')) as Record<string, unknown>).end, 'tls-verify');
  assert.deepEqual(state.recording.recorder.written, []);
  assert.equal(state.recording.recorder.targets.length, 1);
});

test('SIGINT cancels cleanly, closes without retry and unregisters its handlers', async () => {
  const state = rig({ stdin: stdinInput() });
  const pending = runLanSmoke([], state.runtime);
  for (let attempt = 0; attempt < 20 && state.signals.size < 2; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...state.signals.keys()].sort(), ['SIGINT', 'SIGTERM']);
  await new Promise<void>((resolve) => setImmediate(resolve));
  state.signals.get('SIGINT')!();
  assert.equal(await pending, 1);
  const report = JSON.parse(state.out.join('')) as Record<string, unknown>;
  assert.equal(report.end, 'cancelled');
  assert.equal(state.recording.recorder.targets.length, 1);
  assert.deepEqual(state.removed.sort(), ['SIGINT', 'SIGTERM']);
  assert.equal(state.signals.size, 0);
});

test('readBoundedLine stops at the first newline, tolerates EOF and refuses oversized input', async () => {
  assert.equal(await readBoundedLine(Readable.from([Buffer.from('{"a":1}\nrest')]), 100), '{"a":1}');
  assert.equal(await readBoundedLine(Readable.from(['ab', 'cd\n', 'ignored']), 100), 'abcd');
  assert.equal(await readBoundedLine(Readable.from(['no newline']), 100), 'no newline');
  assert.equal(await readBoundedLine(Readable.from([]), 100), '');
  await assert.rejects(readBoundedLine(Readable.from([Buffer.alloc(101, 0x41)]), 100), RangeError);
  await assert.rejects(readBoundedLine(Readable.from(['x'.repeat(60), 'y'.repeat(60)]), 100), /input too large/);
});

test('the real runtime adapter maps process seams, caps CA reads and never prompts', async () => {
  const written: string[] = [];
  const listeners: string[] = [];
  const io: ProcessIo = {
    stdin: Object.assign(Readable.from(['{"host":"x"}\n']), { isTTY: true }),
    stdout: { write: (text) => written.push(`out:${text}`) },
    stderr: { write: (text) => written.push(`err:${text}`) },
    env: { A: '1' },
    once: (signal) => listeners.push(`once:${signal}`),
    off: (signal) => listeners.push(`off:${signal}`),
  };
  const runtime = createSmokeRuntime(io);
  runtime.stdout('a');
  runtime.stderr('b');
  assert.deepEqual(written, ['out:a', 'err:b']);
  assert.equal(runtime.env, io.env);
  assert.equal(runtime.stdinIsTty, true);
  assert.equal(await runtime.readStdin(100), '{"host":"x"}');
  runtime.onSignal('SIGINT', () => undefined);
  runtime.offSignal('SIGTERM', () => undefined);
  assert.deepEqual(listeners, ['once:SIGINT', 'off:SIGTERM']);
  assert.equal(createSmokeRuntime({ ...io, stdin: Readable.from([]) }).stdinIsTty, false);

  const directory = await mkdtemp(join(tmpdir(), 'bambu-smoke-'));
  try {
    const small = join(directory, 'small.pem');
    const big = join(directory, 'big.pem');
    await writeFile(small, CA_PEM);
    await writeFile(big, 'A'.repeat(20_000));
    assert.equal(runtime.readFile(small), CA_PEM);
    assert.throws(() => runtime.readFile(big), /too large/);
    assert.throws(() => runtime.readFile(directory), /not a regular file/);
    assert.throws(() => runtime.readFile(join(directory, 'missing.pem')), /unavailable/);
    assert.deepEqual(runtime.admission(), admitContract());
    assert.equal(runtime.admission().admitted, false);
    assert.throws(
      () => runtime.createSession({ host: HOST, serial: SERIAL, accessCode: CODE, caPem: CA_PEM }, SMOKE_LIMITS),
      (error: Error & { code?: string }) => error.code === 'CONTRACT_UNVERIFIED',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the real launcher process is permanently offline: help, argument refusal, closed admission and a missing CA', async () => {
  const base = { encoding: 'utf8' as const, timeout: 15_000 };
  // The CA path was created and removed, so even if admission were one day open every spawned run
  // below stops at "Invalid CA file." (or earlier) before a session or socket can exist.
  const directory = await mkdtemp(join(tmpdir(), 'bambu-smoke-offline-'));
  await rm(directory, { recursive: true, force: true });
  const offlineInput = (override: Record<string, unknown> = {}): string => `${stdinInput({ caFile: join(directory, 'missing-ca.pem'), ...override })}\n`;
  const refusal = admitContract().admitted ? /Invalid CA file/ : /not admitted/;

  const help = spawnSync(process.execPath, [smokePath, '--help'], { ...base, env: {} });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /bambu-printer-mcp X2D LAN read-only smoke/);

  const withArgs = spawnSync(process.execPath, [smokePath, `--access-code=${CODE}`], { ...base, env: {} });
  assert.equal(withArgs.status, 2);
  assert.equal(withArgs.stdout, '');
  assert.doesNotMatch(withArgs.stderr, new RegExp(CODE));

  const noInput = spawnSync(process.execPath, [smokePath], { ...base, env: {}, input: '' });
  assert.equal(noInput.status, 2);
  assert.equal(noInput.stdout, '');
  assert.match(noInput.stderr, admitContract().admitted ? /Invalid/ : /not admitted/);

  const refused = spawnSync(process.execPath, [smokePath], { ...base, env: {}, input: offlineInput() });
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, refusal);
  if (!admitContract().admitted) assert.match(refused.stderr, /no operator override/);

  // The removed acknowledgement is now an unknown key and, in any case, opens nothing.
  const withOldAck = spawnSync(process.execPath, [smokePath], { ...base, env: {}, input: offlineInput({ observationAck: 'device-report-topic;mqtt-3.1.1;qos-0' }) });
  assert.equal(withOldAck.status, 2);
  assert.equal(withOldAck.stdout, '');
  assert.match(withOldAck.stderr, admitContract().admitted ? /Invalid/ : /not admitted/);
  for (const run of [refused, withOldAck]) assert.doesNotMatch(run.stderr, new RegExp(`${CODE}|${HOST}|${SERIAL}`));
});
