import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { ServiceError } from '../src/domain.js';
import type { PrinterCapabilities, PrinterDescriptor, PrinterStatus, ServiceErrorCode } from '../src/domain.js';
import { MockTransport } from '../src/mock-transport.js';
import { createServer } from '../src/server.js';
import { PrinterService } from '../src/service.js';
import { CODE, HOST, SERIAL, TOPIC, connack, harness, publish, status, suback } from './lan-helpers.js';

const hasCode = (code: ServiceErrorCode) => (error: unknown): boolean => error instanceof ServiceError && error.code === code;

function liveService(policy = {}) {
  const rig = harness();
  return { rig, service: new PrinterService(undefined, policy, rig.session) };
}

test('without an operator-enabled session the live printer does not exist', async () => {
  const service = new PrinterService();
  assert.equal(service.listPrinters().some((printer) => printer.id === 'live-x2d'), false);
  await assert.rejects(service.getStatus('live-x2d'), hasCode('PRINTER_NOT_FOUND'));
  await assert.rejects(service.getCapabilities('live-x2d'), hasCode('PRINTER_NOT_FOUND'));
});

test('the live printer is listed after the mock fleet and labelled as unverified read-only', () => {
  const { service } = liveService();
  const printers = service.listPrinters();
  assert.deepEqual(printers.map((printer) => printer.id), ['mock-a1', 'mock-p1', 'mock-x1', 'mock-h2', 'mock-x2d', 'live-x2d']);
  assert.deepEqual(printers.at(-1), { id: 'live-x2d', family: 'X2D', firmware: 'unverified', transport: 'lan-readonly', hardwareValidated: false });
  assert.equal(printers.slice(0, 5).every((printer) => printer.transport === 'mock'), true);
});

test('only a session-shaped live source can be attached and its id cannot collide with a mock', () => {
  assert.throws(() => new PrinterService(undefined, {}, { observation: () => ({}) } as never), hasCode('INVALID_ARGUMENT'));
  assert.throws(() => new PrinterService(undefined, {}, { descriptor: () => ({}) } as never), hasCode('INVALID_ARGUMENT'));
  assert.throws(() => new PrinterService(undefined, {}, null as never), hasCode('INVALID_ARGUMENT'));
  const rig = harness();
  assert.throws(() => new PrinterService([new MockTransport({ id: 'live-x2d', family: 'X2D' })], {}, rig.session), hasCode('INVALID_ARGUMENT'));
});

test('before subscription and before any frame the live status is honestly unavailable', async () => {
  const { rig, service } = liveService();
  await assert.rejects(service.getStatus('live-x2d'), hasCode('LIVE_UNAVAILABLE'));
  const early = await service.getCapabilities('live-x2d');
  assert.equal(early.status.supported, false);
  assert.match(early.status.reason, /not subscribed/);
  await rig.subscribe();
  await assert.rejects(service.getStatus('live-x2d'), (error: unknown) => hasCode('LIVE_UNAVAILABLE')(error) && /No telemetry frame/.test((error as Error).message));
  const waiting = await service.getCapabilities('live-x2d');
  assert.equal(waiting.status.supported, false);
  assert.match(waiting.status.reason, /No telemetry frame/);
  assert.equal(waiting.provenance.transport, 'lan-readonly');
  assert.equal('freshness' in waiting.provenance && waiting.provenance.freshness, 'none');
});

test('a retained report followed by silence never becomes current status or a supported capability', async () => {
  const { rig, service } = liveService();
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status({ subtask_name: 'CANARY-OLD-JOB' }), 1));
  rig.advance(5_000);
  await assert.rejects(service.getStatus('live-x2d'), (error: unknown) => hasCode('LIVE_UNAVAILABLE')(error) && /No telemetry frame/.test((error as Error).message));
  const capabilities = await service.getCapabilities('live-x2d');
  assert.equal(capabilities.status.supported, false);
  assert.match(capabilities.status.reason, /No telemetry frame/);
  assert.equal('freshness' in capabilities.provenance && capabilities.provenance.freshness, 'none');
  assert.equal('ageMs' in capabilities.provenance && capabilities.provenance.ageMs, null);
  assert.doesNotMatch(JSON.stringify(capabilities), /CANARY/);
  rig.handlers().data(publish(TOPIC, status()));
  assert.equal((await service.getStatus('live-x2d')).state, 'printing');
});

test('a fresh frame yields normalized status with unknown nozzles, no job id and full unverified provenance', async () => {
  const { rig, service } = liveService({ enableMockControls: true, enableMockCamera: true });
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status({ subtask_name: 'CANARY-JOB' })));
  const { warnings, ...live } = await service.getStatus('live-x2d');
  assert.deepEqual(live, {
    id: 'live-x2d', family: 'X2D', firmware: 'unverified', transport: 'lan-readonly', hardwareValidated: false,
    revision: 1, state: 'printing', jobId: null, progressPercent: 42,
    temperatures: { nozzlesC: [], bedC: 55 }, timeRemainingSeconds: 1800,
    provenance: {
      transport: 'lan-readonly', protocol: 'bambu-lan-mqtt-observation', hardwareValidated: false,
      compatibility: 'operator-observation-unverified-contract', contractVerified: false, firmwareVerified: false,
      schemaVerified: false, nozzleMapping: 'unknown', freshness: 'fresh', ageMs: 0,
    },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /nozzle/i);
  assert.doesNotMatch(JSON.stringify([live, warnings]), /CANARY/);
});

test('capabilities expose status only while fresh and never any control or camera, whatever the policy', async () => {
  const { rig, service } = liveService({ enableMockControls: true, enableMockCamera: true });
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status()));
  const capabilities = await service.getCapabilities('live-x2d');
  assert.equal(capabilities.status.supported, true);
  assert.equal(capabilities.firmwareSupported, false);
  assert.equal(capabilities.fixtureNozzleCount, 0);
  for (const name of ['pause', 'cancel', 'print', 'camera'] as const) {
    assert.equal(capabilities[name].supported, false, name);
    assert.ok(capabilities[name].reason.length > 0);
  }
  assert.equal('contractVerified' in capabilities.provenance && capabilities.provenance.contractVerified, false);
  // The mock fleet keeps honoring the same policy, proving the live path is not a policy bypass.
  assert.equal((await service.getCapabilities('mock-x2d')).pause.supported, true);
});

test('stale telemetry withholds every value but keeps provenance and warnings', async () => {
  const rig = harness({ limits: { staleAfterMs: 1_000 } });
  const service = new PrinterService(undefined, {}, rig.session);
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status()));
  rig.setNow(rig.now() + 1_001);
  const stale = await service.getStatus('live-x2d');
  assert.equal(stale.state, null);
  assert.equal(stale.progressPercent, null);
  assert.equal(stale.timeRemainingSeconds, null);
  assert.deepEqual(stale.temperatures, { nozzlesC: [], bedC: null });
  assert.equal('freshness' in stale.provenance && stale.provenance.freshness, 'stale');
  assert.ok(stale.warnings.includes('Telemetry is stale; values are withheld.'));
  const capabilities = await service.getCapabilities('live-x2d');
  assert.equal(capabilities.status.supported, false);
  assert.match(capabilities.status.reason, /stale/);
});

test('an ended session reports its fixed failure reason and never returns old values', async () => {
  const { rig, service } = liveService();
  const started = rig.session.start();
  rig.handlers().secure();
  rig.handlers().data(connack(5));
  await started.catch(() => undefined);
  await assert.rejects(service.getStatus('live-x2d'), (error: unknown) => hasCode('LIVE_UNAVAILABLE')(error) && /authentication was rejected/.test((error as Error).message));
  const capabilities = await service.getCapabilities('live-x2d');
  assert.equal(capabilities.status.supported, false);
  assert.match(capabilities.status.reason, /authentication was rejected/);
  assert.doesNotMatch(JSON.stringify(capabilities), new RegExp(`${CODE}|${SERIAL}|${HOST}`));
});

test('no action plan or camera frame can ever be produced for the live printer', async () => {
  const { rig, service } = liveService({ enableMockControls: true, enableMockCamera: true });
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status()));
  for (const action of ['pause', 'cancel', 'print'] as const) {
    await assert.rejects(
      service.prepareAction({ printerId: 'live-x2d', action, ...(action === 'print' ? { artifactId: 'demo-cube' as const } : {}) }),
      hasCode('CAPABILITY_UNAVAILABLE'),
      action,
    );
  }
  await assert.rejects(service.getCamera('live-x2d'), hasCode('CAPABILITY_UNAVAILABLE'));
  assert.deepEqual(rig.recorder.written.map((frame) => frame[0]! >> 4), [1, 8], 'no frame was written for any attempted action');
});

test('MCP exposes the live printer through the same read-only tools and no new tool', async () => {
  const rig = harness();
  const server = createServer(new PrinterService(undefined, {}, rig.session));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'live-readonly-test', version: '1.0.0' });
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    assert.match(client.getInstructions() ?? '', /mock-only by default/);
    assert.match(client.getInstructions() ?? '', /No hardware support is validated/);
    assert.match(client.getInstructions() ?? '', /live-x2d/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'execute_mock_action', 'get_mock_camera', 'get_printer_capabilities', 'get_printer_status', 'list_printers', 'prepare_mock_action',
    ]);
    for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);

    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const result = <T>(response: Awaited<ReturnType<typeof call>>): T => (response.structuredContent as { result: T }).result;
    assert.equal(result<PrinterDescriptor[]>(await call('list_printers', {})).at(-1)?.id, 'live-x2d');

    const early = await call('get_printer_status', { printerId: 'live-x2d' });
    assert.equal(early.isError, true);
    assert.equal((early.structuredContent as { code: string }).code, 'LIVE_UNAVAILABLE');

    await rig.subscribe();
    rig.handlers().data(publish(TOPIC, status()));
    const live = result<PrinterStatus>(await call('get_printer_status', { printerId: 'live-x2d' }));
    assert.equal(live.state, 'printing');
    assert.deepEqual(live.temperatures.nozzlesC, []);
    const capabilities = result<PrinterCapabilities>(await call('get_printer_capabilities', { printerId: 'live-x2d' }));
    assert.equal(capabilities.pause.supported, false);

    for (const [name, args] of [
      ['prepare_mock_action', { printerId: 'live-x2d', action: 'pause' }],
      ['get_mock_camera', { printerId: 'live-x2d' }],
    ] as const) {
      const denied = await call(name, args);
      assert.equal(denied.isError, true);
      assert.equal((denied.structuredContent as { code: string }).code, 'CAPABILITY_UNAVAILABLE');
    }
    const extra = await call('get_printer_status', { printerId: 'live-x2d', host: HOST });
    assert.equal(extra.isError, true, 'tools still reject device addresses and other extra inputs');

    const everything = JSON.stringify([live, capabilities, early.structuredContent]);
    assert.doesNotMatch(everything, new RegExp(`${CODE}|${SERIAL}|${HOST}|${TOPIC}`));
  } finally {
    await client.close();
    await rig.session.close();
  }
});

test('live status stays unavailable until the broker confirms the subscription', async () => {
  const { rig, service } = liveService();
  const started = rig.session.start();
  rig.handlers().secure();
  rig.handlers().data(connack());
  await assert.rejects(service.getStatus('live-x2d'), hasCode('LIVE_UNAVAILABLE'));
  rig.handlers().data(suback());
  await started;
  assert.equal((await service.getCapabilities('live-x2d')).status.reason, 'No telemetry frame has been accepted yet.');
});
