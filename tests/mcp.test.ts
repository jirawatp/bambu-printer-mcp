import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type {
  ActionPlan,
  MockCameraFrame,
  PrinterCapabilities,
  PrinterDescriptor,
  PrinterStatus,
  ServiceErrorCode,
} from '../src/domain.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function success<T>(response: ToolResult): T {
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const structured = object(response.structuredContent);
  assert.ok(Object.hasOwn(structured, 'result'));
  const text = response.content.find((item) => item.type === 'text');
  assert.ok(text && text.type === 'text');
  assert.deepEqual(JSON.parse(text.text), structured);
  return structured.result as T;
}

function serviceError(response: ToolResult, code: ServiceErrorCode): void {
  assert.equal(response.isError, true);
  const structured = object(response.structuredContent);
  assert.equal(structured.code, code);
  assert.equal(typeof structured.message, 'string');
  assert.ok((structured.message as string).length > 0);
}

function inputError(response: ToolResult): void {
  assert.equal(response.isError, true);
  const text = response.content.find((item) => item.type === 'text');
  assert.ok(text && text.type === 'text');
  assert.match(text.text, /Input validation error/);
}

async function connect(t: TestContext, args: string[] = []): Promise<Client> {
  const client = new Client({ name: 'mock-printer-integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, ...args],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  t.after(async () => {
    await client.close();
    assert.equal(stderr, '', 'MCP server should start and stop without stderr diagnostics');
  });
  await client.connect(transport);
  return client;
}

test('stdio handshake discovers the bounded mock tools and all five synthetic families', { timeout: 15_000 }, async (t) => {
  const client = await connect(t);
  assert.deepEqual(client.getServerVersion(), { name: 'bambu-printer-mcp', version: '0.1.0' });
  assert.match(client.getInstructions() ?? '', /mock-only/i);
  assert.match(client.getInstructions() ?? '', /No hardware support is validated/);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'execute_mock_action',
    'get_mock_camera',
    'get_printer_capabilities',
    'get_printer_status',
    'list_printers',
    'prepare_mock_action',
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject additional inputs`);
    assert.equal(tool.annotations?.openWorldHint, false);
  }

  const printers = success<PrinterDescriptor[]>(await client.callTool({ name: 'list_printers', arguments: {} }));
  assert.deepEqual(printers.map((printer) => [printer.id, printer.family]), [
    ['mock-a1', 'A1'], ['mock-p1', 'P1'], ['mock-x1', 'X1'], ['mock-h2', 'H2'], ['mock-x2d', 'X2D'],
  ]);
  for (const printer of printers) {
    assert.equal(printer.transport, 'mock');
    assert.equal(printer.firmware, 'mock-1.0');
    assert.equal(printer.hardwareValidated, false);
    const capabilities = success<PrinterCapabilities>(await client.callTool({
      name: 'get_printer_capabilities', arguments: { printerId: printer.id },
    }));
    assert.equal(capabilities.status.supported, true);
    for (const capability of ['pause', 'cancel', 'print', 'camera'] as const) {
      assert.equal(capabilities[capability].supported, false, `${printer.id}: ${capability} must default off`);
    }
  }

  const status = success<PrinterStatus>(await client.callTool({
    name: 'get_printer_status', arguments: { printerId: 'mock-x2d' },
  }));
  assert.equal(status.id, 'mock-x2d');
  assert.equal(status.family, 'X2D');
  assert.equal(status.state, 'printing');
  assert.equal(status.progressPercent, 42);
  assert.deepEqual(status.temperatures, { nozzlesC: [205, 205], bedC: 55 });
  assert.equal(status.timeRemainingSeconds, 1_800);
  assert.deepEqual(status.provenance, {
    transport: 'mock', protocol: 'bambu-mcp.synthetic.v1',
    hardwareValidated: false, compatibility: 'synthetic-fixture-only',
  });
  assert.deepEqual(status.warnings, []);
});

test('stdio defaults deny controls and camera and reject unknown printers or extra status inputs', { timeout: 15_000 }, async (t) => {
  const client = await connect(t);
  serviceError(await client.callTool({
    name: 'prepare_mock_action', arguments: { printerId: 'mock-x2d', action: 'pause' },
  }), 'CAPABILITY_UNAVAILABLE');
  serviceError(await client.callTool({
    name: 'get_mock_camera', arguments: { printerId: 'mock-x2d' },
  }), 'CAPABILITY_UNAVAILABLE');
  serviceError(await client.callTool({
    name: 'get_printer_status', arguments: { printerId: 'unknown-printer' },
  }), 'PRINTER_NOT_FOUND');

  for (const extra of [
    { host: 'printer.invalid' },
    { rawCommand: 'arbitrary-command' },
    { path: 'example.3mf' },
  ]) {
    inputError(await client.callTool({
      name: 'get_printer_status', arguments: { printerId: 'mock-x2d', ...extra },
    }));
  }
  inputError(await client.callTool({ name: 'list_printers', arguments: { discoverNetwork: true } }));
  inputError(await client.callTool({ name: 'get_printer_status', arguments: { printerId: '../printer' } }));
  const unchanged = success<PrinterStatus>(await client.callTool({
    name: 'get_printer_status', arguments: { printerId: 'mock-x2d' },
  }));
  assert.equal(unchanged.state, 'printing');
  assert.equal(unchanged.revision, 0);
});

test('stdio action inputs remain allowlisted with controls enabled and confirmation is one-use', { timeout: 15_000 }, async (t) => {
  const client = await connect(t, ['--enable-mock-controls']);
  for (const args of [
    { printerId: 'mock-x2d', action: 'resume' },
    { printerId: 'mock-x2d', action: 'print', artifactId: 'unlisted-model' },
    { printerId: 'mock-x2d', action: 'print', path: 'example.3mf' },
  ]) {
    inputError(await client.callTool({ name: 'prepare_mock_action', arguments: args }));
  }
  serviceError(await client.callTool({
    name: 'prepare_mock_action', arguments: { printerId: 'mock-x2d', action: 'print' },
  }), 'INVALID_ARGUMENT');
  serviceError(await client.callTool({
    name: 'prepare_mock_action', arguments: { printerId: 'mock-x2d', action: 'pause', artifactId: 'demo-cube' },
  }), 'INVALID_ARGUMENT');
  inputError(await client.callTool({
    name: 'execute_mock_action', arguments: { planId: 'not-a-plan', confirmed: 'true' },
  }));

  const plan = success<ActionPlan>(await client.callTool({
    name: 'prepare_mock_action', arguments: { printerId: 'mock-x2d', action: 'pause' },
  }));
  assert.equal(plan.printerId, 'mock-x2d');
  assert.equal(plan.action, 'pause');
  assert.equal(plan.jobId, 'mock-job-mock-x2d');
  assert.equal(plan.revision, 0);
  assert.match(plan.notice, /Mock simulation only/);
  serviceError(await client.callTool({
    name: 'execute_mock_action', arguments: { planId: plan.planId, confirmed: false },
  }), 'CONFIRMATION_REQUIRED');
  serviceError(await client.callTool({
    name: 'execute_mock_action', arguments: { planId: plan.planId, confirmed: true },
  }), 'PLAN_NOT_FOUND');
  const unchanged = success<PrinterStatus>(await client.callTool({
    name: 'get_printer_status', arguments: { printerId: 'mock-x2d' },
  }));
  assert.equal(unchanged.state, 'printing');
  assert.equal(unchanged.revision, 0);
  serviceError(await client.callTool({
    name: 'get_mock_camera', arguments: { printerId: 'mock-x2d' },
  }), 'CAPABILITY_UNAVAILABLE');
});

test('opted-in stdio actions pause, reject replay, cancel, and simulate an allowlisted print with synthetic camera', { timeout: 15_000 }, async (t) => {
  const client = await connect(t, ['--enable-mock-controls', '--enable-mock-camera']);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  const pausePlan = success<ActionPlan>(await call('prepare_mock_action', { printerId: 'mock-x2d', action: 'pause' }));
  const paused = success<PrinterStatus>(await call('execute_mock_action', { planId: pausePlan.planId, confirmed: true }));
  assert.equal(paused.state, 'paused');
  assert.equal(paused.revision, 1);
  assert.equal(paused.jobId, pausePlan.jobId);
  serviceError(await call('execute_mock_action', { planId: pausePlan.planId, confirmed: true }), 'PLAN_NOT_FOUND');

  const pausedCaps = success<PrinterCapabilities>(await call('get_printer_capabilities', { printerId: 'mock-x2d' }));
  assert.equal(pausedCaps.pause.supported, false);
  assert.equal(pausedCaps.cancel.supported, true);
  assert.equal(pausedCaps.print.supported, false);
  const cancelPlan = success<ActionPlan>(await call('prepare_mock_action', { printerId: 'mock-x2d', action: 'cancel' }));
  const cancelled = success<PrinterStatus>(await call('execute_mock_action', { planId: cancelPlan.planId, confirmed: true }));
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.jobId, null);
  assert.equal(cancelled.timeRemainingSeconds, 0);
  assert.equal(cancelled.revision, 2);

  const inactiveCaps = success<PrinterCapabilities>(await call('get_printer_capabilities', { printerId: 'mock-x2d' }));
  assert.equal(inactiveCaps.print.supported, true);
  assert.equal(inactiveCaps.cancel.supported, false);
  const printPlan = success<ActionPlan>(await call('prepare_mock_action', {
    printerId: 'mock-x2d', action: 'print', artifactId: 'demo-cube',
  }));
  assert.equal(printPlan.artifactId, 'demo-cube');
  assert.equal(printPlan.jobId, null);
  assert.equal(printPlan.revision, 2);
  const printed = success<PrinterStatus>(await call('execute_mock_action', { planId: printPlan.planId, confirmed: true }));
  assert.equal(printed.state, 'printing');
  assert.match(printed.jobId ?? '', /^mock-job-/);
  assert.notEqual(printed.jobId, pausePlan.jobId);
  assert.equal(printed.progressPercent, 0);
  assert.equal(printed.timeRemainingSeconds, 3_600);
  assert.equal(printed.revision, 3);
  assert.equal(printed.provenance.hardwareValidated, false);

  const camera = success<MockCameraFrame>(await call('get_mock_camera', { printerId: 'mock-x2d' }));
  assert.equal(camera.printerId, 'mock-x2d');
  assert.equal(camera.contentType, 'image/svg+xml');
  assert.match(camera.data, /^<svg/);
  assert.match(camera.data, /SYNTHETIC MOCK CAMERA/);
  assert.match(camera.description, /no physical camera connection/i);
  assert.equal(camera.provenance.transport, 'mock');
  assert.equal(camera.provenance.hardwareValidated, false);
});

test('CLI rejects hardware-oriented flags with exit 2 and no protocol stdout', { timeout: 15_000 }, async () => {
  for (const args of [['--host', 'printer.invalid'], ['--transport=lan']]) {
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(output.code, 2);
    assert.equal(output.stdout, '');
    assert.match(output.stderr, /Unsupported option/);
    assert.match(output.stderr, /Hardware transport is unavailable/);
  }
});
