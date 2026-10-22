import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceError } from '../src/domain.js';
import type { ActionPlan, PrepareActionInput, ServiceErrorCode, ServicePolicy, SyntheticFrame, TransportSnapshot } from '../src/domain.js';
import { MockTransport, createMockFrame } from '../src/mock-transport.js';
import { PrinterService } from '../src/service.js';

function hasCode(code: ServiceErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof ServiceError && error.code === code;
}

function fixture(id = 'policy-x2d'): MockTransport {
  return new MockTransport({ id, family: 'X2D' });
}

async function assertUnchanged(transport: MockTransport, before: TransportSnapshot): Promise<void> {
  assert.deepEqual(await transport.read(), before);
}

test('only genuine MockTransport instances in an array are accepted', () => {
  const fake = { id: 'fake', family: 'X2D', descriptor: () => ({}), read: async () => ({}) };
  assert.throws(() => new PrinterService(fake as unknown as MockTransport[]), hasCode('INVALID_ARGUMENT'));
  assert.throws(() => new PrinterService([fake as unknown as MockTransport]), hasCode('INVALID_ARGUMENT'));
  assert.throws(() => new PrinterService([{ ...fake } as unknown as MockTransport, fixture()]), hasCode('INVALID_ARGUMENT'));
  assert.equal(new PrinterService([]).listPrinters().length, 0);
});

test('duplicate printer identifiers are rejected', () => {
  assert.throws(() => new PrinterService([fixture('same'), fixture('same')]), hasCode('INVALID_ARGUMENT'));
});

test('policy flags, lifetime and clock must be well formed', () => {
  const bad: Record<string, unknown>[] = [
    { enableMockControls: 'yes' }, { enableMockControls: 1 }, { enableMockCamera: 'true' }, { enableMockCamera: {} },
    { planTtlMs: 0 }, { planTtlMs: 0.5 }, { planTtlMs: 300_001 }, { planTtlMs: Number.NaN },
    { planTtlMs: Infinity }, { planTtlMs: -5 }, { now: 'not-a-function' }, { now: 123 },
  ];
  for (const policy of bad) {
    assert.throws(() => new PrinterService([fixture()], policy as ServicePolicy), hasCode('INVALID_ARGUMENT'), JSON.stringify(policy));
  }
  for (const planTtlMs of [1, 300_000]) {
    assert.doesNotThrow(() => new PrinterService([fixture()], { planTtlMs }));
  }
  assert.doesNotThrow(() => new PrinterService([fixture()], { enableMockControls: false, enableMockCamera: false }));
});

test('invalid clock values deny preparation without storing a plan or touching the simulator', async () => {
  for (const value of [Number.NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '5' as unknown as number]) {
    const transport = fixture();
    const before = await transport.read();
    const service = new PrinterService([transport], { enableMockControls: true, now: () => value });
    await assert.rejects(service.prepareAction({ printerId: transport.id, action: 'pause' }), hasCode('INVALID_ARGUMENT'));
    await assertUnchanged(transport, before);
  }
});

test('plan expiry that would leave the safe integer range is refused', async () => {
  const transport = fixture();
  const before = await transport.read();
  const service = new PrinterService([transport], { enableMockControls: true, planTtlMs: 100, now: () => Number.MAX_SAFE_INTEGER });
  await assert.rejects(service.prepareAction({ printerId: transport.id, action: 'pause' }), hasCode('INVALID_ARGUMENT'));
  await assertUnchanged(transport, before);
  const nearLimit = new PrinterService([transport], { enableMockControls: true, planTtlMs: 5, now: () => Number.MAX_SAFE_INTEGER - 5 });
  assert.equal((await nearLimit.prepareAction({ printerId: transport.id, action: 'pause' })).expiresAt, Number.MAX_SAFE_INTEGER);
});

test('pending plans are bounded at 1000 and expired plans are pruned to make room', async () => {
  let now = 1_000;
  const transport = fixture();
  const before = await transport.read();
  const service = new PrinterService([transport], { enableMockControls: true, planTtlMs: 100, now: () => now });
  const plans: ActionPlan[] = [];
  for (let index = 0; index < 1_000; index++) {
    plans.push(await service.prepareAction({ printerId: transport.id, action: 'pause' }));
  }
  assert.equal(new Set(plans.map((plan) => plan.planId)).size, 1_000);
  await assert.rejects(service.prepareAction({ printerId: transport.id, action: 'pause' }), hasCode('CAPABILITY_UNAVAILABLE'));
  await assertUnchanged(transport, before);
  now = 1_099;
  await assert.rejects(service.prepareAction({ printerId: transport.id, action: 'pause' }), /Too many pending/);
  now = 1_100;
  const fresh = await service.prepareAction({ printerId: transport.id, action: 'pause' });
  assert.equal(fresh.expiresAt, 1_200);
  // Pruned plans are really gone, not merely hidden.
  await assert.rejects(service.executeAction({ planId: plans[0]!.planId, confirmed: true }), hasCode('PLAN_NOT_FOUND'));
  await assertUnchanged(transport, before);
});

test('caller input mutation while the asynchronous read is pending cannot retarget the plan', async () => {
  const printer = fixture('policy-first');
  const other = fixture('policy-second');
  const service = new PrinterService([printer, other], { enableMockControls: true });
  const input: PrepareActionInput = { printerId: printer.id, action: 'pause' };
  const pending = service.prepareAction(input);
  input.printerId = other.id;
  input.action = 'cancel';
  const plan = await pending;
  assert.equal(plan.printerId, printer.id);
  assert.equal(plan.action, 'pause');
  const result = await service.executeAction({ planId: plan.planId, confirmed: true });
  assert.equal(result.id, printer.id);
  assert.equal(result.state, 'paused');
  assert.equal(other.revision, 0);
});

test('malformed prepare and execute inputs are rejected', async () => {
  const transport = fixture();
  const before = await transport.read();
  const service = new PrinterService([transport], { enableMockControls: true });
  for (const input of [null, undefined, {}, { printerId: transport.id }, { printerId: transport.id, action: 'reboot' }]) {
    await assert.rejects(service.prepareAction(input as unknown as PrepareActionInput), hasCode('INVALID_ARGUMENT'));
  }
  for (const input of [null, undefined, {}, { planId: 7, confirmed: true }]) {
    await assert.rejects(service.executeAction(input as never), hasCode('INVALID_ARGUMENT'));
  }
  await assertUnchanged(transport, before);
});

test('expiry that occurs during the asynchronous recheck denies execution and consumes the plan', async () => {
  const readings = [1_000, 1_099, 1_100];
  let calls = 0;
  const transport = fixture();
  const before = await transport.read();
  const service = new PrinterService([transport], { enableMockControls: true, planTtlMs: 100, now: () => readings[Math.min(calls++, 2)]! });
  const plan = await service.prepareAction({ printerId: transport.id, action: 'pause' });
  await assert.rejects(service.executeAction({ planId: plan.planId, confirmed: true }), /expired while checking/);
  assert.equal(calls, 3);
  await assertUnchanged(transport, before);
  await assert.rejects(service.executeAction({ planId: plan.planId, confirmed: true }), hasCode('PLAN_NOT_FOUND'));
});

/** A misbehaving transport that changes state without bumping its revision. */
class SilentlyMutatingTransport extends MockTransport {
  forcedFrame: SyntheticFrame | undefined;
  override async read(): Promise<TransportSnapshot> {
    const snapshot = await super.read();
    return this.forcedFrame === undefined ? snapshot : { revision: snapshot.revision, frame: structuredClone(this.forcedFrame) };
  }
}

test('execution rechecks capability even if a transport changes state without a new revision', async () => {
  const transport = new SilentlyMutatingTransport({ id: 'silent', family: 'X2D' });
  const service = new PrinterService([transport], { enableMockControls: true });
  const plan = await service.prepareAction({ printerId: transport.id, action: 'pause' });
  transport.forcedFrame = createMockFrame('X2D', { state: 'paused', jobId: 'mock-job-silent' });
  await assert.rejects(service.executeAction({ planId: plan.planId, confirmed: true }), hasCode('CAPABILITY_UNAVAILABLE'));
  transport.forcedFrame = undefined;
  assert.equal(transport.revision, 0);
  assert.equal(((await transport.read()).frame as SyntheticFrame).state, 'printing');
});

test('a job change reported without a new revision is stale', async () => {
  const transport = new SilentlyMutatingTransport({ id: 'silent-job', family: 'X2D' });
  const service = new PrinterService([transport], { enableMockControls: true });
  const plan = await service.prepareAction({ printerId: transport.id, action: 'pause' });
  transport.forcedFrame = createMockFrame('X2D', { jobId: 'a-different-job' });
  await assert.rejects(service.executeAction({ planId: plan.planId, confirmed: true }), hasCode('STALE_PLAN'));
  assert.equal(transport.revision, 0);
});

test('an unsupported transport firmware is denied at execution as well as discovery', async () => {
  const transport = new MockTransport({ id: 'future', family: 'A1', firmware: 'future-9' });
  const service = new PrinterService([transport], { enableMockControls: true, enableMockCamera: true });
  await assert.rejects(service.prepareAction({ printerId: transport.id, action: 'pause' }), hasCode('CAPABILITY_UNAVAILABLE'));
  await assert.rejects(service.getStatus(transport.id), hasCode('UNSUPPORTED_FIRMWARE'));
  assert.equal(transport.revision, 0);
});

test('disabled controls still allow read-only discovery of every printer', async () => {
  const service = new PrinterService();
  for (const printer of service.listPrinters()) {
    const capabilities = await service.getCapabilities(printer.id);
    assert.equal(capabilities.status.supported, true);
    assert.equal(capabilities.pause.supported, false);
    assert.match(capabilities.pause.reason, /disabled by server policy/);
  }
});
