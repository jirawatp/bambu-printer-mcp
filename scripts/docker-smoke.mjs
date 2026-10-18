import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const runFile = promisify(execFile);
const defaultImage = 'bambu-printer-mcp:local';
const expectedPrinters = [
  ['mock-a1', 'A1'], ['mock-p1', 'P1'], ['mock-x1', 'X1'], ['mock-h2', 'H2'], ['mock-x2d', 'X2D'],
];

function object(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value;
}

function success(response) {
  assert.notEqual(response.isError, true, 'Expected a successful MCP tool result');
  const structured = object(response.structuredContent);
  assert.ok(Object.hasOwn(structured, 'result'));
  const text = response.content.find((item) => item.type === 'text');
  assert.ok(text, 'Expected a JSON text result');
  assert.deepEqual(JSON.parse(text.text), structured);
  return structured.result;
}

function capabilityDenied(response) {
  assert.equal(response.isError, true, 'Default controls/camera must be denied');
  const structured = object(response.structuredContent);
  assert.equal(structured.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(typeof structured.message, 'string');
  assert.ok(structured.message.length > 0);
}

async function main() {
  const args = process.argv.slice(2);
  const image = args[0] ?? defaultImage;
  // A deliberately narrow image-reference subset, passed as one argv element without a shell.
  if (args.length > 1 || image.length > 255 || !/^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/.test(image)) {
    throw new Error(`Usage: node scripts/docker-smoke.mjs [image:tag] (default: ${defaultImage})`);
  }

  const containerName = `bambu-mcp-smoke-${randomUUID()}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('Docker MCP smoke check timed out after 45 seconds')), 45_000);
  const options = { timeout: 10_000, signal: abort.signal };
  const client = new Client({ name: 'bambu-docker-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'docker',
    args: [
      'run', '--rm', '--interactive', '--pull=never', '--name', containerName,
      '--init', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--cpus', '0.5', '--memory', '256m',
      '--pids-limit', '64', '--log-driver', 'none', image,
    ],
    stderr: 'pipe',
    maxBufferSize: 1_048_576,
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2_048); });

  try {
    await client.connect(transport, options);
    assert.deepEqual(client.getServerVersion(), { name: 'bambu-printer-mcp', version: '0.1.0' });
    assert.match(client.getInstructions() ?? '', /mock-only/i);
    assert.match(client.getInstructions() ?? '', /No hardware support is validated/);
    const { tools } = await client.listTools({}, options);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'execute_mock_action', 'get_mock_camera', 'get_printer_capabilities',
      'get_printer_status', 'list_printers', 'prepare_mock_action',
    ]);
    const call = (name, arguments_) => client.callTool({ name, arguments: arguments_ }, options);
    const printers = success(await call('list_printers', {}));
    assert.deepEqual(printers.map((printer) => [printer.id, printer.family]), expectedPrinters);
    for (const printer of printers) {
      assert.equal(printer.transport, 'mock');
      assert.equal(printer.firmware, 'mock-1.0');
      assert.equal(printer.hardwareValidated, false);
      const capabilities = success(await call('get_printer_capabilities', { printerId: printer.id }));
      assert.equal(capabilities.status.supported, true);
      for (const capability of ['pause', 'cancel', 'print', 'camera']) {
        assert.equal(capabilities[capability].supported, false, `${printer.id}: ${capability} must default off`);
      }
    }
    const status = success(await call('get_printer_status', { printerId: 'mock-x2d' }));
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
    capabilityDenied(await call('prepare_mock_action', { printerId: 'mock-x2d', action: 'pause' }));
    capabilityDenied(await call('get_mock_camera', { printerId: 'mock-x2d' }));
  } catch (error) {
    if (stderr.trim()) console.error(stderr.trim());
    throw error;
  } finally {
    clearTimeout(timer);
    try {
      await client.close();
    } finally {
      // Also close when connection initialization failed before Client took ownership.
      try {
        await transport.close();
      } finally {
        try {
          // Only this invocation's unique container may be removed; never prune shared resources.
          await runFile('docker', ['rm', '--force', containerName], { timeout: 5_000, maxBuffer: 4_096 });
        } catch (error) {
          // --rm usually removed it already. A failed daemon connection is reported above.
          if (!/No such container/i.test(error.stderr ?? '') && !process.exitCode) {
            console.error(`Cleanup could not confirm removal of ${containerName}.`);
            process.exitCode = 1;
          }
        }
      }
    }
  }
  if (!process.exitCode) console.log('Docker MCP smoke passed: SDK handshake, 5 mock printers, X2D telemetry, default safety gates.');
}

main().catch((error) => {
  console.error(`Docker MCP smoke failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exitCode = 1;
});
