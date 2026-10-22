import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { mock, type TestContext } from 'node:test';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { defaultRuntime, runCli } from '../src/cli.js';
import type { CliRuntime } from '../src/cli.js';
import type { PrinterService } from '../src/service.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Harness {
  runtime: CliRuntime;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
  signals: Map<string, () => void>;
  services: PrinterService[];
  connected: unknown[];
  closes: number;
  unregistered: string[];
}

function harness(options: { connect?: () => Promise<void>; close?: () => Promise<void>; transportThrows?: boolean; signalThrowsAt?: number } = {}): Harness {
  const state: Harness = {
    stdout: [], stderr: [], exitCodes: [], signals: new Map(), services: [], connected: [], closes: 0, unregistered: [],
    runtime: undefined as unknown as CliRuntime,
  };
  const transport = { marker: 'fake-transport' };
  state.runtime = {
    stdout: (text) => { state.stdout.push(text); },
    stderr: (text) => { state.stderr.push(text); },
    onSignal: (signal, handler) => {
      if (options.signalThrowsAt === state.signals.size) throw new Error('SECRET signal registration failure');
      state.signals.set(signal, handler);
    },
    offSignal: (signal, handler) => {
      assert.equal(state.signals.get(signal), handler, 'only the registered handler is unregistered');
      state.signals.delete(signal);
      state.unregistered.push(signal);
    },
    setExitCode: (code) => { state.exitCodes.push(code); },
    createTransport: () => { if (options.transportThrows) throw new Error('SECRET transport construction failure'); return transport as never; },
    createServer: (service) => {
      state.services.push(service);
      return {
        connect: async (given) => { state.connected.push(given); await options.connect?.(); },
        close: async () => { state.closes++; await options.close?.(); },
      };
    },
  };
  return state;
}

test('unsupported options exit 2 with a bounded stderr message and no stdout or server', async () => {
  for (const args of [['--host', 'printer.invalid'], ['--transport=lan'], ['--enable-mock-controls', '--bogus'], ['']]) {
    const state = harness();
    assert.equal(await runCli(args, state.runtime), 2);
    assert.deepEqual(state.stdout, []);
    assert.equal(state.stderr.length, 1);
    assert.match(state.stderr[0]!, /Unsupported option.*Hardware transport is unavailable/);
    assert.equal(state.services.length, 0);
    assert.equal(state.signals.size, 0);
  }
});

test('--help prints usage to stdout only and never builds a server', async () => {
  const state = harness();
  assert.equal(await runCli(['--help'], state.runtime), 0);
  assert.equal(state.stdout.length, 1);
  assert.match(state.stdout[0]!, /bambu-printer-mcp \(mock by default\)/);
  assert.match(state.stdout[0]!, /No real printer transport exists/);
  assert.deepEqual(state.stderr, []);
  assert.equal(state.services.length, 0);
  assert.equal(state.signals.size, 0);
});

test('default startup is read-only: controls and camera stay disabled', async () => {
  const state = harness();
  assert.equal(await runCli([], state.runtime), 0);
  assert.equal(state.connected.length, 1);
  assert.equal((state.connected[0] as { marker: string }).marker, 'fake-transport');
  const capabilities = await state.services[0]!.getCapabilities('mock-x2d');
  for (const name of ['pause', 'cancel', 'print', 'camera'] as const) assert.equal(capabilities[name].supported, false);
  assert.deepEqual([state.stdout, state.stderr], [[], []]);
});

test('each opt-in flag enables only its own simulation', async () => {
  const controls = harness();
  assert.equal(await runCli(['--enable-mock-controls'], controls.runtime), 0);
  const controlCaps = await controls.services[0]!.getCapabilities('mock-x2d');
  assert.equal(controlCaps.pause.supported, true);
  assert.equal(controlCaps.camera.supported, false);

  const camera = harness();
  assert.equal(await runCli(['--enable-mock-camera'], camera.runtime), 0);
  const cameraCaps = await camera.services[0]!.getCapabilities('mock-x2d');
  assert.equal(cameraCaps.camera.supported, true);
  assert.equal(cameraCaps.pause.supported, false);
});

test('shutdown unregisters both handlers and closes the server exactly once however many signals arrive', async () => {
  const state = harness();
  await runCli([], state.runtime);
  assert.deepEqual([...state.signals.keys()].sort(), ['SIGINT', 'SIGTERM']);
  const sigint = state.signals.get('SIGINT')!;
  const sigterm = state.signals.get('SIGTERM')!;
  sigint();
  sigterm();
  sigint();
  await tick();
  assert.equal(state.closes, 1);
  assert.deepEqual(state.unregistered.sort(), ['SIGINT', 'SIGTERM']);
  assert.equal(state.signals.size, 0);
  assert.deepEqual([state.stderr, state.exitCodes], [[], []]);
});

test('a rejected shutdown reports a bounded stderr line and a failing status without leaking its text', async () => {
  const state = harness({ close: async () => { throw new Error('SECRET internal detail /private/path'); } });
  await runCli([], state.runtime);
  const sigterm = state.signals.get('SIGTERM')!;
  const sigint = state.signals.get('SIGINT')!;
  sigterm();
  sigint();
  await tick();
  assert.equal(state.closes, 1, 'a failing close is not retried by a second signal');
  assert.deepEqual(state.stderr, ['MCP stdio shutdown failed.\n']);
  assert.deepEqual(state.exitCodes, [1]);
  assert.deepEqual(state.stdout, []);
  assert.doesNotMatch(state.stderr.join(''), /SECRET|private/);
});

test('a startup failure returns 1, closes the server once, unregisters handlers and redacts every error', async () => {
  const failures: Array<[string, Parameters<typeof harness>[0]]> = [
    ['connect rejects', { connect: async () => { throw new Error('SECRET transport failure'); } }],
    ['transport construction throws', { transportThrows: true }],
    ['second signal registration throws', { signalThrowsAt: 1 }],
    ['first signal registration throws', { signalThrowsAt: 0 }],
  ];
  for (const [label, options] of failures) {
    const state = harness(options);
    assert.equal(await runCli([], state.runtime), 1, label);
    assert.deepEqual(state.stderr, ['MCP stdio startup failed.\n'], label);
    assert.deepEqual(state.stdout, []);
    assert.equal(state.closes, 1, `${label}: server closed exactly once`);
    assert.equal(state.signals.size, 0, `${label}: no signal handler stays registered`);
    assert.deepEqual(state.exitCodes, []);
  }
});

test('a failing cleanup during a failed startup is reported once, redacted, and does not mask the startup failure', async () => {
  const state = harness({
    connect: async () => { throw new Error('SECRET connect'); },
    close: async () => { throw new Error('SECRET close /private/path'); },
  });
  assert.equal(await runCli([], state.runtime), 1);
  assert.deepEqual(state.stderr, ['MCP stdio shutdown failed.\n', 'MCP stdio startup failed.\n']);
  assert.equal(state.closes, 1);
  assert.doesNotMatch(state.stderr.join(''), /SECRET|private/);
  const unregisterThrows = harness({ connect: async () => { throw new Error('x'); } });
  unregisterThrows.runtime.offSignal = () => { throw new Error('SECRET off'); };
  assert.equal(await runCli([], unregisterThrows.runtime), 1);
  assert.equal(unregisterThrows.closes, 1, 'the server is still closed if unregistering fails');
  assert.deepEqual(unregisterThrows.stderr, ['MCP stdio startup failed.\n']);
});

test('default runtime writes through process streams, signals and exit code', () => {
  const originalExitCode = process.exitCode;
  const out = mock.method(process.stdout, 'write', () => true);
  const err = mock.method(process.stderr, 'write', () => true);
  const once = mock.method(process, 'once', () => process);
  const off = mock.method(process, 'off', () => process);
  try {
    defaultRuntime.stdout('hello\n');
    defaultRuntime.stderr('warn\n');
    const handler = () => {};
    defaultRuntime.onSignal('SIGTERM', handler);
    defaultRuntime.offSignal('SIGTERM', handler);
    defaultRuntime.setExitCode(7);
    assert.equal(process.exitCode, 7);
    assert.deepEqual(out.mock.calls[0]!.arguments, ['hello\n']);
    assert.deepEqual(err.mock.calls[0]!.arguments, ['warn\n']);
    assert.deepEqual(once.mock.calls[0]!.arguments, ['SIGTERM', handler]);
    assert.deepEqual(off.mock.calls[0]!.arguments, ['SIGTERM', handler]);
  } finally {
    process.exitCode = originalExitCode;
    mock.restoreAll();
  }
  assert.ok(defaultRuntime.createTransport() instanceof StdioServerTransport);
  const server = defaultRuntime.createServer(undefined as unknown as PrinterService);
  assert.ok(server instanceof McpServer);
});

interface Exit { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function launch(t: TestContext, args: string[], entry = cliPath) {
  const child = spawn(process.execPath, [entry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  // Registered immediately so a failed readiness wait or assertion can never leave a stdin-holding child running.
  t.after(() => {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => { state.stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { state.stderr += chunk.toString(); });
  const exited = new Promise<Exit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, ...state }));
  });
  return { child, state, exited };
}

test('process: --help exits 0 and prints only usage on stdout', { timeout: 15_000 }, async (t) => {
  const { exited } = launch(t, ['--help']);
  const result = await exited;
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: node dist\/src\/cli\.js/);
  assert.equal(result.stderr, '');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`process: ${signal} closes a serving CLI gracefully while stdin stays open`, { timeout: 15_000 }, async (t) => {
    const { child, state, exited } = launch(t, []);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'signal-test', version: '1.0.0' } },
    })}\n`);
    const deadline = Date.now() + 10_000;
    while (!state.stdout.includes('"id":1') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(state.stdout, /bambu-printer-mcp/);
    child.kill(signal);
    const result = await exited;
    assert.equal(result.signal, null, 'handler must exit the process normally, not by default signal action');
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    for (const line of result.stdout.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line), 'stdout carries only MCP JSON');
  });
}

test('process: extensionless, symlinked and dot-js launches all reject bogus options and honour --help', { timeout: 15_000 }, async (t) => {
  const distCli = fileURLToPath(new URL('../src/cli', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'bambu-cli-launch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const link = join(directory, 'linked-cli.js');
  await symlink(cliPath, link);
  for (const entry of [distCli, cliPath, link]) {
    const bogus = spawnSync(process.execPath, [entry, '--bogus'], { encoding: 'utf8', timeout: 10_000, input: '' });
    assert.equal(bogus.status, 2, `bogus option is rejected for ${entry === distCli ? 'extensionless' : entry === link ? 'symlink' : '.js'} entry`);
    assert.equal(bogus.stdout, '');
    assert.match(bogus.stderr, /Unsupported option/);
    const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', timeout: 10_000, input: '' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: node dist\/src\/cli\.js/);
    assert.equal(help.stderr, '');
  }
});

test('process: importing the CLI module starts nothing and exits immediately', { timeout: 15_000 }, () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(cliPath)});`],
    { encoding: 'utf8', timeout: 10_000, input: '' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
