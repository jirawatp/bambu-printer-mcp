import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MOCK_ARTIFACTS,
  MOCK_FIRMWARE,
  PRINTER_FAMILIES,
  SYNTHETIC_PROTOCOL,
  ServiceError,
} from '../src/domain.js';
import type { Action, PrinterFamily, ServiceErrorCode } from '../src/domain.js';
import { MockTransport, createMockFrame } from '../src/mock-transport.js';
import { PrinterService } from '../src/service.js';

const provenance = {
  transport: 'mock',
  protocol: SYNTHETIC_PROTOCOL,
  hardwareValidated: false,
  compatibility: 'synthetic-fixture-only',
};

function hasCode(code: ServiceErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}

function fixture(family: PrinterFamily = 'X2D', frame?: unknown): MockTransport {
  return new MockTransport({
    id: `test-${family.toLowerCase()}`,
    family,
    ...(frame === undefined ? {} : { frame }),
  });
}

function inactiveFrame(family: PrinterFamily = 'X2D') {
  return createMockFrame(family, {
    state: 'idle', jobId: null, artifactId: null, progressPercent: 0, timeRemainingSeconds: 0,
  });
}

test('default fleet identifies all five families as synthetic fixtures', () => {
  const service = new PrinterService();
  const fleet = service.listPrinters();
  assert.deepEqual(fleet.map((printer) => printer.family), ['A1', 'P1', 'X1', 'H2', 'X2D']);
  assert.equal(new Set(fleet.map((printer) => printer.id)).size, 5);
  for (const printer of fleet) {
    assert.equal(printer.firmware, MOCK_FIRMWARE);
    assert.equal(printer.transport, 'mock');
    assert.equal(printer.hardwareValidated, false);
  }
  // A caller cannot replace the service's descriptor or fleet through the result.
  fleet[0]!.id = 'changed';
  fleet.pop();
  assert.equal(service.listPrinters().length, 5);
  assert.equal(service.listPrinters()[0]!.id, 'mock-a1');
});

for (const family of PRINTER_FAMILIES) {
  test(`${family}: normalizes status and explicitly reports mock provenance`, async () => {
    const nozzleCounts = { A1: 1, P1: 1, X1: 1, H2: 2, X2D: 2 } as const;
    const nozzles = Array.from({ length: nozzleCounts[family] }, (_, index) => 201 + index);
    const transport = fixture(family, createMockFrame(family, {
      jobId: 'fixture-job', progressPercent: 37.5,
      temperatures: { nozzlesC: nozzles, bedC: 58.5 }, timeRemainingSeconds: 912,
    }));
    const service = new PrinterService([transport]);
    const status = await service.getStatus(transport.id);
    assert.equal(status.family, family);
    assert.equal(status.state, 'printing');
    assert.equal(status.jobId, 'fixture-job');
    assert.equal(status.progressPercent, 37.5);
    assert.deepEqual(status.temperatures, { nozzlesC: nozzles, bedC: 58.5 });
    assert.equal(status.timeRemainingSeconds, 912);
    assert.equal(status.revision, 0);
    assert.deepEqual(status.provenance, provenance);
    assert.deepEqual(status.warnings, []);
    const capabilities = await service.getCapabilities(transport.id);
    assert.equal(capabilities.fixtureNozzleCount, nozzleCounts[family]);
    assert.equal(capabilities.status.supported, true);
    assert.deepEqual(capabilities.provenance, provenance);
  });
}

test('zero readings remain valid values instead of becoming unavailable', async () => {
  const transport = fixture('X2D', createMockFrame('X2D', {
    progressPercent: 0, temperatures: { nozzlesC: [0, 0], bedC: 0 }, timeRemainingSeconds: 0,
  }));
  const service = new PrinterService([transport], { enableMockControls: true });
  const status = await service.getStatus(transport.id);
  assert.equal(status.progressPercent, 0);
  assert.deepEqual(status.temperatures, { nozzlesC: [0, 0], bedC: 0 });
  assert.equal(status.timeRemainingSeconds, 0);
  assert.deepEqual(status.warnings, []);
  assert.equal((await service.getCapabilities(transport.id)).pause.supported, true);
});

test('missing telemetry becomes null and disables controls', async () => {
  const transport = fixture('X2D', { protocol: SYNTHETIC_PROTOCOL, state: 'printing', jobId: 'fixture-job' });
  const service = new PrinterService([transport], { enableMockControls: true });
  const status = await service.getStatus(transport.id);
  assert.equal(status.progressPercent, null);
  assert.deepEqual(status.temperatures, { nozzlesC: [null, null], bedC: null });
  assert.equal(status.timeRemainingSeconds, null);
  assert.ok(status.warnings.length > 0);
  const caps = await service.getCapabilities(transport.id);
  assert.equal(caps.status.supported, true);
  for (const action of ['pause', 'cancel', 'print'] as const) assert.equal(caps[action].supported, false);
  await assert.rejects(service.prepareAction({ printerId: transport.id, action: 'pause' }), hasCode('CAPABILITY_UNAVAILABLE'));
});

for (const [name, badFrame] of [
  ['non-finite values', { progressPercent: Number.NaN, temperatures: { nozzlesC: [Infinity, -1], bedC: Infinity }, timeRemainingSeconds: -1 }],
  ['out-of-range values', { progressPercent: 101, temperatures: { nozzlesC: [351, -1], bedC: 151 }, timeRemainingSeconds: 31_536_001 }],
  ['numeric strings', { progressPercent: '42', temperatures: { nozzlesC: ['205', '205'], bedC: '55' }, timeRemainingSeconds: '1800' }],
] as const) {
  test(`invalid telemetry (${name}) is nullable, never coerced or clamped`, async () => {
    const transport = fixture('X2D', { ...createMockFrame('X2D'), ...badFrame });
    const service = new PrinterService([transport], { enableMockControls: true });
    const status = await service.getStatus(transport.id);
    assert.equal(status.progressPercent, null);
    assert.deepEqual(status.temperatures, { nozzlesC: [null, null], bedC: null });
    assert.equal(status.timeRemainingSeconds, null);
    assert.equal((await service.getCapabilities(transport.id)).cancel.supported, false);
  });
}

test('unexpected nozzle channels prevent actions without inventing extra hardware', async () => {
  const transport = fixture('A1', createMockFrame('A1', { temperatures: { nozzlesC: [205, 206], bedC: 55 } }));
  const service = new PrinterService([transport], { enableMockControls: true });
  assert.deepEqual((await service.getStatus(transport.id)).temperatures.nozzlesC, [205]);
  assert.equal((await service.getCapabilities(transport.id)).pause.supported, false);
});

for (const frame of [
  { ...createMockFrame('X2D'), state: 'unknown' },
  { ...createMockFrame('X2D'), jobId: null },
  { ...inactiveFrame(), jobId: 'unexpected-active-job' },
] as const) {
  test(`inconsistent state/job binding denies actions (${String(frame.state)}/${String(frame.jobId)})`, async () => {
    const transport = fixture('X2D', frame);
    const service = new PrinterService([transport], { enableMockControls: true });
    const caps = await service.getCapabilities(transport.id);
    for (const action of ['pause', 'cancel', 'print'] as const) assert.equal(caps[action].supported, false);
  });
}

test('unknown firmware fails closed even when simulation policies are enabled', async () => {
  const transport = new MockTransport({ id: 'future-firmware', family: 'X2D', firmware: 'future-version' });
  const service = new PrinterService([transport], { enableMockControls: true, enableMockCamera: true });
  const caps = await service.getCapabilities(transport.id);
  assert.equal(caps.firmwareSupported, false);
  for (const name of ['status', 'pause', 'cancel', 'print', 'camera'] as const) assert.equal(caps[name].supported, false);
  await assert.rejects(service.getStatus(transport.id), hasCode('UNSUPPORTED_FIRMWARE'));
  await assert.rejects(service.prepareAction({ printerId: transport.id, action: 'pause' }), hasCode('CAPABILITY_UNAVAILABLE'));
  await assert.rejects(service.getCamera(transport.id), hasCode('CAPABILITY_UNAVAILABLE'));
});

for (const frame of [null, {}, { ...createMockFrame('X2D'), protocol: 'physical-mqtt' }]) {
  test(`missing or unknown frame protocol is not decoded (${JSON.stringify(frame)?.slice(0, 24)})`, async () => {
    const transport = new MockTransport({ id: 'bad-protocol', family: 'X2D', frame });
    const service = new PrinterService([transport], { enableMockControls: true, enableMockCamera: true });
    const caps = await service.getCapabilities(transport.id);
    for (const name of ['status', 'pause', 'cancel', 'print', 'camera'] as const) assert.equal(caps[name].supported, false);
    await assert.rejects(service.getStatus(transport.id), hasCode('INVALID_FRAME'));
  });
}

test('controls and camera are disabled by default', async () => {
  const transport = fixture();
  const service = new PrinterService([transport]);
  const caps = await service.getCapabilities(transport.id);
  for (const name of ['pause', 'cancel', 'print', 'camera'] as const) assert.equal(caps[name].supported, false);
  await assert.rejects(service.prepareAction({ printerId: transport.id, action: 'pause' }), hasCode('CAPABILITY_UNAVAILABLE'));
  await assert.rejects(service.getCamera(transport.id), hasCode('CAPABILITY_UNAVAILABLE'));
  assert.equal((await service.getStatus(transport.id)).revision, 0);
});

test('opt-in pause and cancel only mutate the mock job after confirmed execution', async () => {
  const transport = fixture();
  const service = new PrinterService([transport], { enableMockControls: true });
  const before = await service.getStatus(transport.id);
  const plan = await service.prepareAction({ printerId: transport.id, action: 'pause' });
  assert.equal(plan.printerId, transport.id);
  assert.equal(plan.jobId, before.jobId);
  assert.equal(plan.revision, before.revision);
  assert.deepEqual(await service.getStatus(transport.id), before);
  const paused = await service.executeAction({ planId: plan.planId, confirmed: true });
  assert.equal(paused.state, 'paused');
  assert.equal(paused.jobId, before.jobId);
  assert.equal(paused.revision, before.revision + 1);
  assert.equal((await service.getCapabilities(transport.id)).pause.supported, false);
  const cancellation = await service.prepareAction({ printerId: transport.id, action: 'cancel' });
  const cancelled = await service.executeAction({ planId: cancellation.planId, confirmed: true });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.jobId, null);
  assert.equal(cancelled.timeRemainingSeconds, 0);
  assert.equal(cancelled.revision, before.revision + 2);
  assert.deepEqual(cancelled.provenance, provenance);
});

for (const artifactId of MOCK_ARTIFACTS) {
  test(`opt-in print accepts bundled artifact ${artifactId} on an inactive mock`, async () => {
    const transport = fixture('X2D', inactiveFrame());
    const service = new PrinterService([transport], { enableMockControls: true });
    const plan = await service.prepareAction({ printerId: transport.id, action: 'print', artifactId });
    assert.equal(plan.artifactId, artifactId);
    assert.equal(plan.jobId, null);
    const status = await service.executeAction({ planId: plan.planId, confirmed: true });
    assert.equal(status.state, 'printing');
    assert.ok(status.jobId?.startsWith('mock-job-'));
    assert.equal(status.progressPercent, 0);
    assert.equal(status.revision, 1);
    assert.equal((await service.getCapabilities(transport.id)).print.supported, false);
    const frame = (await transport.read()).frame as { artifactId: string };
    assert.equal(frame.artifactId, artifactId);
  });
}

test('artifact allowlist rejects paths, URLs and missing artifacts', async () => {
  const transport = fixture('X2D', inactiveFrame());
  const service = new PrinterService([transport], { enableMockControls: true });
  for (const artifactId of ['/tmp/job.3mf', '../job.3mf', 'https://example.invalid/job.3mf', 'arbitrary-job', '']) {
    await assert.rejects(service.prepareAction({ printerId: transport.id, action: 'print', artifactId }), hasCode('INVALID_ARGUMENT'));
  }
  await assert.rejects(service.prepareAction({ printerId: transport.id, action: 'print' }), hasCode('INVALID_ARGUMENT'));
  await assert.rejects(service.prepareAction({ printerId: transport.id, action: 'pause', artifactId: 'demo-cube' }), hasCode('INVALID_ARGUMENT'));
  assert.equal((await service.getStatus(transport.id)).revision, 0);
});

test('state-specific action discovery prevents pause/cancel on idle and print on active jobs', async () => {
  const inactive = fixture('X2D', inactiveFrame());
  const active = fixture('A1');
  const service = new PrinterService([inactive, active], { enableMockControls: true });
  for (const action of ['pause', 'cancel'] as const) {
    await assert.rejects(service.prepareAction({ printerId: inactive.id, action }), hasCode('CAPABILITY_UNAVAILABLE'));
  }
  await assert.rejects(service.prepareAction({ printerId: active.id, action: 'print', artifactId: 'demo-cube' }), hasCode('CAPABILITY_UNAVAILABLE'));
});

test('an unconfirmed attempt consumes the plan without changing the printer', async () => {
  const transport = fixture();
  const service = new PrinterService([transport], { enableMockControls: true });
  const plan = await service.prepareAction({ printerId: transport.id, action: 'pause' });
  await assert.rejects(service.executeAction({ planId: plan.planId, confirmed: false }), hasCode('CONFIRMATION_REQUIRED'));
  await assert.rejects(service.executeAction({ planId: plan.planId, confirmed: true }), hasCode('PLAN_NOT_FOUND'));
  assert.equal((await service.getStatus(transport.id)).state, 'printing');
  assert.equal(transport.revision, 0);
});

test('plans expire at the deadline and cannot be retried', async () => {
  let now = 1_000;
  const transport = fixture();
  const service = new PrinterService([transport], { enableMockControls: true, planTtlMs: 100, now: () => now });
  const plan = await service.prepareAction({ printerId: transport.id, action: 'pause' });
  assert.equal(plan.expiresAt, 1_100);
  now = 1_100;
  await assert.rejects(service.executeAction({ planId: plan.planId, confirmed: true }), hasCode('PLAN_EXPIRED'));
  await assert.rejects(service.executeAction({ planId: plan.planId, confirmed: true }), hasCode('PLAN_NOT_FOUND'));
  assert.equal(transport.revision, 0);
});

test('a replaced frame makes a plan stale even when job and state look unchanged', async () => {
  const transport = fixture();
  const service = new PrinterService([transport], { enableMockControls: true });
  const plan = await service.prepareAction({ printerId: transport.id, action: 'pause' });
  transport.replaceFrame((await transport.read()).frame);
  await assert.rejects(service.executeAction({ planId: plan.planId, confirmed: true }), hasCode('STALE_PLAN'));
  await assert.rejects(service.executeAction({ planId: plan.planId, confirmed: true }), hasCode('PLAN_NOT_FOUND'));
  assert.equal((await service.getStatus(transport.id)).state, 'printing');
  assert.equal(transport.revision, 1);
});

test('returned plans cannot be edited to retarget the stored intent', async () => {
  const transport = fixture();
  const service = new PrinterService([transport], { enableMockControls: true });
  const plan = await service.prepareAction({ printerId: transport.id, action: 'pause' });
  plan.action = 'cancel';
  plan.printerId = 'other-printer';
  plan.revision = 999;
  const status = await service.executeAction({ planId: plan.planId, confirmed: true });
  assert.equal(status.id, transport.id);
  assert.equal(status.state, 'paused');
  assert.ok(status.jobId);
});

test('concurrent execution of the same plan can succeed only once', async () => {
  const transport = fixture();
  const service = new PrinterService([transport], { enableMockControls: true });
  const plan = await service.prepareAction({ printerId: transport.id, action: 'pause' });
  const results = await Promise.allSettled([
    service.executeAction({ planId: plan.planId, confirmed: true }),
    service.executeAction({ planId: plan.planId, confirmed: true }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(hasCode('PLAN_NOT_FOUND')(rejected.reason));
  assert.equal(transport.revision, 1);
});

test('unknown targets, unknown plans and arbitrary commands are rejected', async () => {
  const service = new PrinterService();
  await assert.rejects(service.getStatus('unknown-printer'), hasCode('PRINTER_NOT_FOUND'));
  await assert.rejects(service.getCapabilities('unknown-printer'), hasCode('PRINTER_NOT_FOUND'));
  await assert.rejects(service.getCamera('unknown-printer'), hasCode('PRINTER_NOT_FOUND'));
  await assert.rejects(service.prepareAction({ printerId: 'unknown-printer', action: 'pause' }), hasCode('PRINTER_NOT_FOUND'));
  await assert.rejects(service.getStatus('https://example.invalid'), hasCode('INVALID_ARGUMENT'));
  await assert.rejects(service.executeAction({ planId: 'unknown-plan', confirmed: true }), hasCode('PLAN_NOT_FOUND'));
  await assert.rejects(service.prepareAction({ printerId: 'mock-x2d', action: 'raw-gcode' as Action }), hasCode('INVALID_ARGUMENT'));
});

test('camera access requires its own opt-in and returns a static synthetic fixture', async () => {
  const transport = fixture();
  const controlsOnly = new PrinterService([transport], { enableMockControls: true });
  await assert.rejects(controlsOnly.getCamera(transport.id), hasCode('CAPABILITY_UNAVAILABLE'));
  const cameraOnly = new PrinterService([transport], { enableMockCamera: true });
  const camera = await cameraOnly.getCamera(transport.id);
  assert.equal(camera.printerId, transport.id);
  assert.equal(camera.contentType, 'image/svg+xml');
  assert.match(camera.data, /^<svg\b/);
  assert.match(camera.data, /SYNTHETIC MOCK CAMERA/);
  assert.doesNotMatch(camera.data, /(?:href=|src=|<script|<foreignObject)/i);
  assert.deepEqual(camera.provenance, provenance);
  assert.equal((await cameraOnly.getCapabilities(transport.id)).pause.supported, false);
  assert.equal(transport.revision, 0);
});

test('transport reads and incoming frames are isolated from caller mutation', async () => {
  const frame = createMockFrame('X2D');
  const transport = fixture('X2D', frame);
  frame.temperatures.nozzlesC[0] = 999;
  const first = await transport.read();
  (first.frame as { temperatures: { nozzlesC: number[] } }).temperatures.nozzlesC[0] = 888;
  const status = await new PrinterService([transport]).getStatus(transport.id);
  assert.deepEqual(status.temperatures.nozzlesC, [205, 205]);
  assert.equal(status.revision, 0);
});
