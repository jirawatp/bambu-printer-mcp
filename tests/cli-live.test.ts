import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { defaultRuntime, runCli } from '../src/cli.js';
import type { CliRuntime } from '../src/cli.js';
import { ENV_ACCESS_CODE, ENV_CA_FILE, ENV_HOST, ENV_SERIAL } from '../src/lan-config.js';
import { UNRESOLVED_CONTRACT_ITEMS, admitContract } from '../src/lan-contract.js';
import { ObservationEngine } from '../src/lan-engine.js';
import { LanReadOnlySession, STAGE_TEXT } from '../src/lan-session.js';
import type { ChannelHandlers } from '../src/lan-session.js';
import { createServer } from '../src/server.js';
import type { PrinterService } from '../src/service.js';
import { CA_PEM, CODE, HOST, SERIAL, TOPIC, connack, publish, recordingFactory, status, suback, writtenTypes } from './lan-helpers.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fullEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    [ENV_HOST]: HOST, [ENV_SERIAL]: SERIAL, [ENV_ACCESS_CODE]: CODE, UNRELATED: 'kept', ...extra,
  };
}

function rig(options: { env?: Record<string, string | undefined>; broker?: (handlers: ChannelHandlers) => void; omitLive?: boolean; createThrows?: boolean; caText?: string; realAdmission?: boolean } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const reads: string[] = [];
  const services: PrinterService[] = [];
  const signals = new Map<string, () => void>();
  const sessions: ObservationEngine[] = [];
  let createCalls = 0;
  const recording = recordingFactory({
    onCreate: (handlers) => queueMicrotask(() => (options.broker ?? ((h) => { h.secure(); h.data(connack()); h.data(suback()); }))(handlers)),
  });
  const env = options.env ?? fullEnv();
  const runtime: CliRuntime = {
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
    onSignal: (signal, handler) => { signals.set(signal, handler); },
    offSignal: (signal) => { signals.delete(signal); },
    setExitCode: () => undefined,
    createTransport: () => ({ marker: 'fake' }) as never,
    createServer: (service) => { services.push(service); return { connect: async () => undefined, close: async () => undefined }; },
    ...(options.omitLive === true ? {} : {
      live: {
        env,
        // The flow is exercised with admission injected open and an engine, which the real runtime can never produce.
        admission: options.realAdmission === true ? admitContract : () => ({ admitted: true }),
        readFile: (path) => { reads.push(path); return options.caText ?? CA_PEM; },
        createSession: (config) => {
          createCalls += 1;
          if (options.createThrows === true) throw new Error(`SECRET ${CODE}`);
          const session = new ObservationEngine({ config, channelFactory: recording.factory });
          sessions.push(session);
          return session;
        },
      },
    }),
  };
  return { runtime, stdout, stderr, reads, services, signals, sessions, recording, env, createCalls: () => createCalls };
}

test('the flag without runtime support exits 2 and builds no server', async () => {
  const state = rig({ omitLive: true });
  assert.equal(await runCli(['--enable-x2d-lan-readonly'], state.runtime), 2);
  assert.deepEqual(state.stderr, ['Live X2D read-only support is unavailable in this runtime.\n']);
  assert.equal(state.services.length, 0);
});

test('closed real admission exits 2 before reading anything, creating a session or connecting', async () => {
  const env = fullEnv();
  const before = { ...env };
  const state = rig({ env, realAdmission: true });
  assert.equal(await runCli(['--enable-x2d-lan-readonly'], state.runtime), 2);
  assert.equal(state.stderr.length, 1);
  for (const item of UNRESOLVED_CONTRACT_ITEMS) assert.match(state.stderr[0]!, new RegExp(item));
  assert.match(state.stderr[0]!, /no operator override/);
  assert.doesNotMatch(state.stderr[0]!, new RegExp(`${HOST}|${SERIAL}|${CODE}`));
  assert.deepEqual(state.reads, []);
  assert.equal(state.createCalls(), 0);
  assert.equal(state.recording.recorder.targets.length, 0);
  assert.equal(state.services.length, 0);
  assert.deepEqual(state.stdout, []);
  assert.deepEqual(env, before, 'operator values were never even read');
});

test('invalid operator values exit 2 with a field-only message and no connection', async () => {
  const cases: [Record<string, string>, string][] = [
    [{ [ENV_HOST]: 'printer.invalid' }, 'Invalid host.'],
    [{ [ENV_SERIAL]: '01P00A000000000' }, 'Invalid serial.'],
    [{ [ENV_ACCESS_CODE]: 'x' }, 'Invalid access code.'],
    [{ [ENV_CA_FILE]: 'relative.pem' }, 'Invalid CA file.'],
  ];
  for (const [override, message] of cases) {
    const state = rig({ env: fullEnv(override) });
    assert.equal(await runCli(['--enable-x2d-lan-readonly'], state.runtime), 2);
    assert.deepEqual(state.stderr, [`${message}\n`]);
    assert.equal(state.recording.recorder.targets.length, 0);
    assert.equal(state.services.length, 0);
  }
  const unreadable = rig({ caText: 'not a certificate' });
  assert.equal(await runCli(['--enable-x2d-lan-readonly'], unreadable.runtime), 2);
  assert.deepEqual(unreadable.stderr, ['Invalid CA file.\n']);
});

test('a non-service failure while creating the session is reported generically', async () => {
  const state = rig({ createThrows: true });
  assert.equal(await runCli(['--enable-x2d-lan-readonly'], state.runtime), 2);
  assert.deepEqual(state.stderr, ['Live X2D read-only configuration failed.\n']);
  assert.doesNotMatch(state.stderr.join(''), /SECRET|synthetic/);
});

test('an admitted session starts before MCP connects, is attached read-only and is closed on shutdown', async () => {
  const state = rig();
  assert.equal(await runCli(['--enable-x2d-lan-readonly'], state.runtime), 0);
  assert.equal(state.services.length, 1);
  assert.equal(state.recording.recorder.targets.length, 1);
  assert.deepEqual(state.recording.recorder.targets[0], { host: HOST, port: 8883, serverName: SERIAL, caPem: CA_PEM });
  assert.deepEqual(state.reads, ['/Applications/BambuStudio.app/Contents/Resources/cert/printer.cer']);
  assert.equal(Object.keys(state.env).some((key) => key.startsWith('BAMBU_X2D')), false, 'inherited secrets are removed from the environment');
  assert.deepEqual([state.stdout, state.stderr], [[], []]);

  state.recording.recorder.handlers!.data(publish(TOPIC, status()));
  const live = await state.services[0]!.getStatus('live-x2d');
  assert.equal(live.state, 'printing');
  const capabilities = await state.services[0]!.getCapabilities('mock-x2d');
  assert.equal(capabilities.pause.supported, false, 'the flag does not enable mock controls');

  state.signals.get('SIGTERM')!();
  await tick();
  assert.equal((await state.sessions[0]!.finished).end, 'closed');
  assert.deepEqual(writtenTypes(state.recording.recorder), [1, 8, 14]);
  assert.equal(state.signals.size, 0);
});

test('the live flag composes with mock flags without enabling controls on the live printer', async () => {
  const state = rig();
  assert.equal(await runCli(['--enable-x2d-lan-readonly', '--enable-mock-controls', '--enable-mock-camera'], state.runtime), 0);
  const service = state.services[0]!;
  assert.equal((await service.getCapabilities('mock-x2d')).pause.supported, true);
  const live = await service.getCapabilities('live-x2d');
  for (const name of ['pause', 'cancel', 'print', 'camera'] as const) assert.equal(live[name].supported, false);
  await state.sessions[0]!.close();
});

test('authentication rejection at startup exits 1 with the fixed text, without retry or leaked values', async () => {
  const state = rig({ broker: (handlers) => { handlers.secure(); handlers.data(connack(5)); } });
  assert.equal(await runCli(['--enable-x2d-lan-readonly'], state.runtime), 1);
  assert.deepEqual(state.stderr, [`${STAGE_TEXT.authentication}\n`]);
  assert.equal(state.recording.recorder.targets.length, 1);
  assert.deepEqual(writtenTypes(state.recording.recorder), [1]);
  assert.equal(state.signals.size, 0);
  assert.deepEqual(state.stdout, []);
  assert.doesNotMatch(state.stderr.join(''), new RegExp(`${CODE}|${SERIAL}|${HOST}`));
});

test('certificate verification failure at startup exits 1 and never writes CONNECT', async () => {
  const state = rig({ broker: (handlers) => { handlers.failed('tls-verify'); } });
  assert.equal(await runCli(['--enable-x2d-lan-readonly'], state.runtime), 1);
  assert.deepEqual(state.stderr, [`${STAGE_TEXT['tls-verify']}\n`]);
  assert.deepEqual(state.recording.recorder.written, []);
  assert.equal(state.recording.recorder.targets.length, 1);
});

test('arguments cannot carry targets or secrets, and the live flag takes none', async () => {
  for (const args of [['--enable-x2d-lan-readonly=1'], ['--enable-x2d-lan-readonly', '--host', HOST], [`--access-code=${CODE}`], ['--serial', SERIAL]]) {
    const state = rig();
    assert.equal(await runCli(args, state.runtime), 2);
    assert.equal(state.stderr.length, 1);
    assert.doesNotMatch(state.stderr[0]!, new RegExp(`${CODE}|${HOST}|${SERIAL}`));
    assert.equal(state.recording.recorder.targets.length, 0);
  }
});

test('the real runtime is admission-closed, and even a valid config cannot create a session', async () => {
  const live = defaultRuntime.live!;
  assert.equal(live.env, process.env);
  assert.deepEqual(live.admission(), admitContract());
  assert.equal(live.admission().admitted, false);
  assert.throws(
    () => live.createSession({ host: HOST, serial: SERIAL, accessCode: CODE, caPem: CA_PEM }),
    (error: Error & { code?: string }) => error.code === 'CONTRACT_UNVERIFIED' && !error.message.includes(CODE) && !error.message.includes(SERIAL),
  );
  assert.throws(() => new LanReadOnlySession({ config: { host: HOST, serial: SERIAL, accessCode: CODE, caPem: CA_PEM }, channelFactory: recordingFactory().factory }), /not admitted/);
});

test('the real runtime reads a CA only through the bounded regular-file reader', async () => {
  const live = defaultRuntime.live!;
  const directory = await mkdtemp(join(tmpdir(), 'bambu-live-'));
  try {
    const small = join(directory, 'small.pem');
    const big = join(directory, 'big.pem');
    await writeFile(small, CA_PEM);
    await writeFile(big, 'A'.repeat(20_000));
    assert.equal(live.readFile(small), CA_PEM);
    assert.throws(() => live.readFile(big), /too large/);
    assert.throws(() => live.readFile(join(directory, 'missing.pem')), /unavailable/);
    assert.throws(() => live.readFile(directory), /not a regular file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the real process refuses the live flag with a closed gate before any network use', () => {
  const run = spawnSync(process.execPath, [cliPath, '--enable-x2d-lan-readonly'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 15_000 });
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  for (const item of UNRESOLVED_CONTRACT_ITEMS) assert.match(run.stderr, new RegExp(item));
});

test('the removed acknowledgement string no longer opens anything, and the spawned process is permanently offline', async () => {
  // The CA file points at a path that was created and removed, so even if admission were one day
  // open this process stops at "Invalid CA file." before any session or socket exists.
  const directory = await mkdtemp(join(tmpdir(), 'bambu-offline-'));
  await rm(directory, { recursive: true, force: true });
  const env = {
    PATH: process.env.PATH ?? '', [ENV_HOST]: HOST, [ENV_SERIAL]: SERIAL, [ENV_ACCESS_CODE]: CODE,
    [ENV_CA_FILE]: join(directory, 'missing-ca.pem'),
    BAMBU_X2D_OBSERVE_UNVERIFIED_CONTRACT: 'device-report-topic;mqtt-3.1.1;qos-0',
  };
  const run = spawnSync(process.execPath, [cliPath, '--enable-x2d-lan-readonly'], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, admitContract().admitted ? /Invalid CA file/ : /not admitted/);
  assert.doesNotMatch(run.stderr, new RegExp(`${CODE}|${SERIAL}|${HOST}`));
});

function stdioRig() {
  const state = rig();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new StdioServerTransport(stdin, stdout);
  const exitCodes: number[] = [];
  state.runtime.createTransport = () => transport;
  state.runtime.createServer = (service) => { state.services.push(service); return createServer(service); };
  state.runtime.setExitCode = (code) => { exitCodes.push(code); };
  return { state, stdin, stdout, transport, exitCodes };
}

test('stdin EOF on a real stdio transport closes the live session exactly once and keeps an earlier onclose', async () => {
  const { state, stdin, transport } = stdioRig();
  let earlier = 0;
  transport.onclose = () => { earlier += 1; };
  assert.equal(await runCli(['--enable-x2d-lan-readonly'], state.runtime), 0);
  assert.equal(state.signals.size, 2);
  stdin.end();
  const report = await state.sessions[0]!.finished;
  await tick();
  assert.equal(report.end, 'closed');
  assert.equal(earlier, 1, 'the handler present before startup still ran');
  assert.deepEqual(writtenTypes(state.recording.recorder), [1, 8, 14], 'exactly one DISCONNECT, nothing else');
  assert.equal(state.recording.recorder.destroyed, 1);
  assert.equal(state.signals.size, 0, 'signal handlers are unregistered');
  assert.deepEqual(state.stderr, []);
  assert.deepEqual(state.stdout, []);
});

test('a signal racing stdin EOF still closes the session only once', async () => {
  const { state, stdin } = stdioRig();
  assert.equal(await runCli(['--enable-x2d-lan-readonly'], state.runtime), 0);
  state.signals.get('SIGTERM')!();
  stdin.end();
  await state.sessions[0]!.finished;
  await tick();
  assert.deepEqual(writtenTypes(state.recording.recorder), [1, 8, 14]);
  assert.equal(state.recording.recorder.destroyed, 1);
});

test('an earlier onclose that throws cannot keep the live session open', async () => {
  const { state, stdin, transport } = stdioRig();
  transport.onclose = () => { throw new Error('SECRET earlier handler failure'); };
  assert.equal(await runCli(['--enable-x2d-lan-readonly'], state.runtime), 0);
  stdin.end();
  assert.equal((await state.sessions[0]!.finished).end, 'closed');
  await tick();
  assert.doesNotMatch(state.stderr.join(''), /SECRET/);
});

test('a failing live-session close on EOF is reported once and sets exit code 1', async () => {
  const { state, stdin, exitCodes } = stdioRig();
  assert.equal(await runCli(['--enable-x2d-lan-readonly'], state.runtime), 0);
  state.sessions[0]!.close = async () => { throw new Error(`SECRET ${CODE}`); };
  stdin.end();
  await tick();
  await tick();
  assert.deepEqual(exitCodes, [1]);
  assert.deepEqual(state.stderr, ['MCP stdio shutdown failed.\n']);
  assert.equal(state.signals.size, 0);
});

test('mock-only runs also release cleanly on stdin EOF', async () => {
  const { state, stdin, exitCodes } = stdioRig();
  assert.equal(await runCli([], state.runtime), 0);
  stdin.end();
  await tick();
  await tick();
  assert.deepEqual(exitCodes, []);
  assert.equal(state.signals.size, 0);
  assert.deepEqual(state.stderr, []);
});

test('the real process help and unsupported-option paths mention the live flag without needing it', () => {
  const help = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--enable-x2d-lan-readonly/);
  assert.equal(help.stderr, '');
  const bad = spawnSync(process.execPath, [cliPath, `--access-code=${CODE}`], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
  assert.doesNotMatch(bad.stderr, new RegExp(CODE));
});
