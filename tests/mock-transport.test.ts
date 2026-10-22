import assert from 'node:assert/strict';
import test from 'node:test';
import { MOCK_FIRMWARE, SYNTHETIC_PROTOCOL, ServiceError } from '../src/domain.js';
import type { Action, ServiceErrorCode, SyntheticFrame, TransportSnapshot } from '../src/domain.js';
import { MockTransport, createDefaultMockFleet, createMockFrame } from '../src/mock-transport.js';
import type { MockActionCommand } from '../src/mock-transport.js';

function hasCode(code: ServiceErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}

function printing(): MockTransport {
  return new MockTransport({ id: 'direct-x2d', family: 'X2D' });
}

function inactiveFrame(state: SyntheticFrame['state'] = 'idle'): SyntheticFrame {
  return createMockFrame('X2D', {
    state, jobId: null, artifactId: null, progressPercent: 0, timeRemainingSeconds: 0,
  });
}

const pauseCommand = (transport: MockTransport, overrides: Partial<MockActionCommand> = {}): MockActionCommand => ({
  action: 'pause', artifactId: null, expectedRevision: transport.revision, expectedJobId: 'mock-job-direct-x2d', ...overrides,
});

/** A denied command must reject with the exact code and leave frame and revision untouched. */
async function assertDenied(transport: MockTransport, command: MockActionCommand, code: ServiceErrorCode): Promise<void> {
  const before: TransportSnapshot = await transport.read();
  await assert.rejects(transport.applyAction(command), hasCode(code));
  const after = await transport.read();
  assert.deepEqual(after, before);
  assert.equal(transport.revision, before.revision);
}

test('constructor rejects unsafe identifiers, unknown families and malformed firmware', () => {
  for (const id of ['', '1printer', 'a/b', 'a b', 'https://printer.invalid', 'x'.repeat(65), 42, null, undefined]) {
    assert.throws(() => new MockTransport({ id: id as string, family: 'A1' }), hasCode('INVALID_ARGUMENT'));
  }
  for (const family of ['Z9', '', 'a1', undefined]) {
    assert.throws(() => new MockTransport({ id: 'ok', family: family as 'A1' }), hasCode('INVALID_ARGUMENT'));
  }
  for (const firmware of ['x'.repeat(65), 7, {}, null]) {
    assert.throws(() => new MockTransport({ id: 'ok', family: 'A1', firmware: firmware as string }), hasCode('INVALID_ARGUMENT'));
  }
  assert.equal(new MockTransport({ id: 'ok', family: 'A1', firmware: 'x'.repeat(64) }).firmware, 'x'.repeat(64));
  assert.equal(new MockTransport({ id: 'ok', family: 'A1' }).firmware, MOCK_FIRMWARE);
});

test('an explicit frame option, even undefined, replaces the default fixture', async () => {
  const explicit = new MockTransport({ id: 'explicit', family: 'P1', frame: undefined });
  assert.equal((await explicit.read()).frame, undefined);
  const defaulted = new MockTransport({ id: 'default', family: 'P1' });
  assert.equal((defaulted.descriptor()).transport, 'mock');
  assert.equal(((await defaulted.read()).frame as SyntheticFrame).jobId, 'mock-job-default');
  assert.equal(createDefaultMockFleet().length, 5);
});

test('unsupported firmware denies every action without changing state', async () => {
  const transport = new MockTransport({ id: 'future', family: 'X2D', firmware: 'future-1.0' });
  await assertDenied(transport, pauseCommand(transport, { expectedJobId: 'mock-job-future' }), 'UNSUPPORTED_FIRMWARE');
});

test('unknown actions are rejected before state is inspected', async () => {
  const transport = printing();
  for (const action of ['resume', 'raw-gcode', '', undefined]) {
    await assertDenied(transport, pauseCommand(transport, { action: action as Action }), 'INVALID_ARGUMENT');
  }
});

test('artifact rules: print needs an allowlisted artifact and pause/cancel accept none', async () => {
  const idle = new MockTransport({ id: 'idle-printer', family: 'X2D', frame: inactiveFrame() });
  for (const artifactId of [null, '/tmp/job.3mf', 'https://example.invalid/job.3mf', 'arbitrary', '']) {
    await assertDenied(idle, {
      action: 'print', artifactId: artifactId as 'demo-cube', expectedRevision: 0, expectedJobId: null,
    }, 'INVALID_ARGUMENT');
  }
  const active = printing();
  for (const action of ['pause', 'cancel'] as const) {
    await assertDenied(active, pauseCommand(active, { action, artifactId: 'demo-cube' }), 'INVALID_ARGUMENT');
  }
});

test('a changed revision makes the command stale even when the job looks the same', async () => {
  const transport = printing();
  const snapshot = await transport.read();
  transport.replaceFrame(snapshot.frame);
  await assertDenied(transport, pauseCommand(transport, { expectedRevision: 0 }), 'STALE_PLAN');
  await assertDenied(transport, pauseCommand(transport, { expectedRevision: 2 }), 'STALE_PLAN');
  await assertDenied(transport, pauseCommand(transport, { expectedRevision: Number.NaN }), 'STALE_PLAN');
});

test('malformed or inconsistent frames never accept an action', async () => {
  const good = createMockFrame('X2D', { jobId: 'job-a' });
  const frames: unknown[] = [
    null, undefined, 'frame', [], {},
    { ...good, protocol: 'physical-mqtt' },
    { ...good, state: 'unknown' },
    { ...good, jobId: null },
    { ...good, progressPercent: Number.NaN },
    { ...good, temperatures: { nozzlesC: [205], bedC: 55 } },
    { ...good, temperatures: { nozzlesC: [205, 400], bedC: 55 } },
    { ...good, timeRemainingSeconds: -1 },
    { ...inactiveFrame(), jobId: 'phantom-job' },
  ];
  for (const frame of frames) {
    const transport = new MockTransport({ id: 'bad-frame', family: 'X2D', frame });
    await assertDenied(transport, { action: 'pause', artifactId: null, expectedRevision: 0, expectedJobId: 'job-a' }, 'INVALID_FRAME');
  }
});

test('a command bound to a different job is stale and changes nothing', async () => {
  const transport = printing();
  await assertDenied(transport, pauseCommand(transport, { expectedJobId: 'some-other-job' }), 'STALE_PLAN');
  await assertDenied(transport, pauseCommand(transport, { expectedJobId: null }), 'STALE_PLAN');
});

test('state guards: pause needs printing, cancel needs active, print needs inactive', async () => {
  const paused = new MockTransport({ id: 'paused', family: 'X2D', frame: createMockFrame('X2D', { state: 'paused', jobId: 'job-p' }) });
  await assertDenied(paused, { action: 'pause', artifactId: null, expectedRevision: 0, expectedJobId: 'job-p' }, 'CAPABILITY_UNAVAILABLE');
  await assertDenied(paused, { action: 'print', artifactId: 'demo-cube', expectedRevision: 0, expectedJobId: 'job-p' }, 'CAPABILITY_UNAVAILABLE');
  for (const state of ['idle', 'completed', 'cancelled'] as const) {
    const inactive = new MockTransport({ id: `inactive-${state}`, family: 'X2D', frame: inactiveFrame(state) });
    await assertDenied(inactive, { action: 'pause', artifactId: null, expectedRevision: 0, expectedJobId: null }, 'CAPABILITY_UNAVAILABLE');
    await assertDenied(inactive, { action: 'cancel', artifactId: null, expectedRevision: 0, expectedJobId: null }, 'CAPABILITY_UNAVAILABLE');
  }
  const active = printing();
  await assertDenied(active, { action: 'print', artifactId: 'demo-benchy', expectedRevision: 0, expectedJobId: 'mock-job-direct-x2d' }, 'CAPABILITY_UNAVAILABLE');
});

test('allowed transitions mutate only the in-memory frame and bump the revision once', async () => {
  const transport = printing();
  const paused = await transport.applyAction(pauseCommand(transport));
  assert.equal(paused.revision, 1);
  assert.equal((paused.frame as SyntheticFrame).state, 'paused');
  assert.equal((paused.frame as SyntheticFrame).jobId, 'mock-job-direct-x2d');

  const cancelled = await transport.applyAction({ action: 'cancel', artifactId: null, expectedRevision: 1, expectedJobId: 'mock-job-direct-x2d' });
  const frame = cancelled.frame as SyntheticFrame;
  assert.deepEqual([cancelled.revision, frame.state, frame.jobId, frame.artifactId, frame.timeRemainingSeconds], [2, 'cancelled', null, null, 0]);

  const restarted = await transport.applyAction({ action: 'print', artifactId: 'demo-benchy', expectedRevision: 2, expectedJobId: null });
  const next = restarted.frame as SyntheticFrame;
  assert.equal(restarted.revision, 3);
  assert.equal(next.state, 'printing');
  assert.equal(next.artifactId, 'demo-benchy');
  assert.equal(next.progressPercent, 0);
  assert.equal(next.timeRemainingSeconds, 3_600);
  assert.match(next.jobId ?? '', /^mock-job-[0-9a-f-]{36}$/);
});

test('cancel is allowed directly from a printing job', async () => {
  const transport = printing();
  const result = await transport.applyAction({ action: 'cancel', artifactId: null, expectedRevision: 0, expectedJobId: 'mock-job-direct-x2d' });
  assert.equal((result.frame as SyntheticFrame).state, 'cancelled');
});

test('returned snapshots are clones and cannot edit the simulator', async () => {
  const transport = printing();
  const result = await transport.applyAction(pauseCommand(transport));
  (result.frame as SyntheticFrame).state = 'idle';
  assert.equal(((await transport.read()).frame as SyntheticFrame).state, 'paused');
});

test('the camera fixture is a literal synthetic SVG with mock provenance', async () => {
  const camera = await printing().camera();
  assert.equal(camera.printerId, 'direct-x2d');
  assert.equal(camera.contentType, 'image/svg+xml');
  assert.match(camera.data, /SYNTHETIC MOCK CAMERA/);
  assert.equal(camera.provenance.protocol, SYNTHETIC_PROTOCOL);
  assert.equal(camera.provenance.hardwareValidated, false);
});
