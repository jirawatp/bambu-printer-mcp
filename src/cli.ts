import type { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ServiceError } from './domain.js';
import { buildLiveConfig, takeLiveInputFromEnv } from './lan-config.js';
import type { LiveConfig } from './lan-config.js';
import { admitContract } from './lan-contract.js';
import type { Admission } from './lan-contract.js';
import { LanReadOnlySession, LiveSessionError } from './lan-session.js';
import type { LiveSession } from './lan-session.js';
import { createTlsChannelFactory } from './lan-tls.js';
import { readBoundedRegularFile } from './safe-file.js';
import { PrinterService } from './service.js';
import { createServer } from './server.js';

type ServerTransport = Parameters<McpServer['connect']>[0];

/** Seams for the optional operator-enabled X2D LAN read-only path. */
export interface LiveRuntime {
  /** Inherited environment; operator values are read from it and then removed. */
  env: Record<string, string | undefined>;
  /** Contract admission, checked before any input is read. The real value is the ledger rule; there is no override. */
  admission(): Admission;
  /** Bounded read of a regular file only. */
  readFile(path: string): string;
  createSession(config: LiveConfig): LiveSession;
}

/** Process-facing seams so lifecycle behavior can be tested without real stdio or signals. */
export interface CliRuntime {
  stdout(text: string): void;
  stderr(text: string): void;
  onSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
  offSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
  setExitCode(code: number): void;
  createTransport(): ServerTransport;
  createServer(service: PrinterService): Pick<McpServer, 'connect' | 'close'>;
  /** Absent means the LAN read-only flag cannot be honored. */
  live?: LiveRuntime;
}

const MAX_CA_FILE_BYTES = 16_384;

export const defaultRuntime: CliRuntime = {
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
  onSignal: (signal, handler) => { process.once(signal, handler); },
  offSignal: (signal, handler) => { process.off(signal, handler); },
  setExitCode: (code) => { process.exitCode = code; },
  createTransport: () => new StdioServerTransport(),
  createServer: (service) => createServer(service),
  live: {
    env: process.env,
    admission: admitContract,
    readFile: (path) => readBoundedRegularFile(path, MAX_CA_FILE_BYTES),
    createSession: (config) => new LanReadOnlySession({ config, channelFactory: createTlsChannelFactory() }),
  },
};

const LIVE_FLAG = '--enable-x2d-lan-readonly';
const ALLOWED_OPTIONS = new Set(['--enable-mock-controls', '--enable-mock-camera', LIVE_FLAG, '--help']);

/**
 * Mock-by-default startup. Returns a process exit code: 0 once serving (or after --help),
 * 2 for an unsupported option or a closed/invalid live admission (admission is checked before any input is read), and 1 when startup fails.
 * Diagnostics go to stderr only; stdout stays reserved for MCP protocol messages.
 * `--enable-x2d-lan-readonly` additionally starts one operator-supplied, subscribe-only X2D
 * observation; its inputs come only from the inherited environment, never from arguments.
 */
export async function runCli(args: string[], runtime: CliRuntime = defaultRuntime): Promise<number> {
  if (args.some((arg) => !ALLOWED_OPTIONS.has(arg))) {
    runtime.stderr('Unsupported option. Only --enable-mock-controls, --enable-mock-camera, --enable-x2d-lan-readonly and --help are accepted. Hardware transport is unavailable except through --enable-x2d-lan-readonly, which takes no arguments.\n');
    return 2;
  }
  if (args.includes('--help')) {
    runtime.stdout('bambu-printer-mcp (mock by default)\n\nUsage: node dist/src/cli.js [--enable-mock-controls] [--enable-mock-camera] [--enable-x2d-lan-readonly]\n\nDefault: read-only synthetic telemetry over MCP stdio. No real printer transport exists unless the operator passes --enable-x2d-lan-readonly, which adds one subscribe-only X2D telemetry observation (unverified contract, no controls, no camera). Its inputs come only from the inherited environment; see docs/hardware-validation.md.\n');
    return 0;
  }
  let session: LiveSession | undefined;
  if (args.includes(LIVE_FLAG)) {
    if (runtime.live === undefined) {
      runtime.stderr('Live X2D read-only support is unavailable in this runtime.\n');
      return 2;
    }
    const admission = runtime.live.admission();
    if (!admission.admitted) {
      runtime.stderr(`${admission.reason}\n`);
      return 2;
    }
    try {
      session = runtime.live.createSession(buildLiveConfig(takeLiveInputFromEnv(runtime.live.env), runtime.live.readFile));
    } catch (error) {
      // ServiceError texts name only a field or a fixed reason, never a value.
      runtime.stderr(`${error instanceof ServiceError ? error.message : 'Live X2D read-only configuration failed.'}\n`);
      return 2;
    }
  }
  const service = new PrinterService(undefined, {
    enableMockControls: args.includes('--enable-mock-controls'),
    enableMockCamera: args.includes('--enable-mock-camera'),
  }, session);
  const server = runtime.createServer(service);
  let released = false;
  // Idempotent: unregisters signal handlers and closes the server at most once, for shutdown and failed startup alike.
  // Returns false (after one bounded stderr line) when closing fails; error text is never forwarded.
  const release = async (): Promise<boolean> => {
    if (released) return true;
    released = true;
    try {
      runtime.offSignal('SIGINT', close);
      runtime.offSignal('SIGTERM', close);
    } catch { /* unregistering is best effort */ }
    try {
      await session?.close();
      await server.close();
      return true;
    } catch {
      runtime.stderr('MCP stdio shutdown failed.\n');
      return false;
    }
  };
  function close(): void {
    void release().then((closed) => { if (!closed) runtime.setExitCode(1); });
  }
  try {
    runtime.onSignal('SIGINT', close);
    runtime.onSignal('SIGTERM', close);
    await session?.start();
    const transport = runtime.createTransport();
    // Stdin EOF (the MCP host going away) closes the transport and fires onclose without any signal.
    // Chain behind a handler the transport already has, and release the live session exactly once
    // (release is idempotent, so a signal racing the EOF cannot double close). The SDK in turn chains
    // this handler when connecting.
    const priorOnClose = transport.onclose;
    transport.onclose = () => {
      try {
        priorOnClose?.();
      } catch { /* a failing earlier handler must not keep the live session open */ }
      close();
    };
    await server.connect(transport);
  } catch (error) {
    await release();
    runtime.stderr(error instanceof LiveSessionError ? `${error.message}\n` : 'MCP stdio startup failed.\n');
    return 1;
  }
  return 0;
}

// import.meta.main is true only for the process entry module, including extensionless and symlinked launches.
if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
