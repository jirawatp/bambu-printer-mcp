import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { admitContract } from '../src/lan-contract.js';
import { ObservationEngine } from '../src/lan-engine.js';
import { LanReadOnlySession } from '../src/lan-session.js';
import { CA_PEM, CODE, HOST, SERIAL, config, recordingFactory } from './lan-helpers.js';

const hasCode = (code: string, text?: RegExp) => (error: unknown): boolean => {
  const failure = error as Error & { code?: string };
  return failure.code === code && (text === undefined || text.test(failure.message));
};

test('the public session refuses construction while the wire contract is unverified', () => {
  const rig = recordingFactory();
  const reason = admitContract();
  assert.equal(reason.admitted, false);
  assert.throws(
    () => new LanReadOnlySession({ config: config(), channelFactory: rig.factory }),
    (error: unknown) => hasCode('CONTRACT_UNVERIFIED', /not admitted/)(error) && (error as Error).message === (reason.admitted ? '' : reason.reason),
  );
  assert.equal(rig.recorder.targets.length, 0, 'no channel is created');
  assert.deepEqual(rig.recorder.written, []);
});

test('no option, injected seam or extra property can substitute for evidence', () => {
  const rig = recordingFactory();
  const attempts: Record<string, unknown>[] = [
    { limits: { maxMessages: 1 } },
    { now: () => 0, schedule: () => () => undefined },
    { acknowledgement: 'device-report-topic;mqtt-3.1.1;qos-0', observationAck: 'device-report-topic;mqtt-3.1.1;qos-0' },
    { contract: [{ id: 'report-topic', evidence: 'first-party-source' }], admitted: true, force: true, verified: true },
  ];
  for (const extra of attempts) {
    assert.throws(
      () => new LanReadOnlySession({ config: config(), channelFactory: rig.factory, ...extra } as never),
      hasCode('CONTRACT_UNVERIFIED'),
      JSON.stringify(Object.keys(extra)),
    );
  }
  assert.equal(rig.recorder.targets.length, 0);
});

test('admission is evaluated before configuration, so it cannot be probed with invalid values', () => {
  const rig = recordingFactory();
  assert.throws(() => new LanReadOnlySession({ config: { ...config(), host: 'printer.local' }, channelFactory: rig.factory }), hasCode('CONTRACT_UNVERIFIED'));
  assert.throws(() => new LanReadOnlySession({ config: undefined as never, channelFactory: rig.factory }), hasCode('CONTRACT_UNVERIFIED'));
  assert.throws(() => new LanReadOnlySession({ config: { host: HOST, serial: SERIAL, accessCode: CODE, caPem: CA_PEM }, channelFactory: undefined as never }), hasCode('CONTRACT_UNVERIFIED'));
});

test('the refusal never exposes configuration values', () => {
  try {
    new LanReadOnlySession({ config: config(), channelFactory: recordingFactory().factory });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.doesNotMatch(String((error as Error).message), new RegExp(`${HOST}|${SERIAL}|${CODE}|${CA_PEM.slice(0, 20)}`));
  }
});

const sourceDirectory = new URL('../src/', import.meta.url);
const sources = readdirSync(sourceDirectory).filter((name) => name.endsWith('.js')).map((name) => [name, readFileSync(new URL(name, sourceDirectory), 'utf8')] as const);

test('only the admission-checked wrapper can reach the engine; no entry point imports or names it', () => {
  assert.ok(sources.length >= 10, 'the production sources were found');
  for (const [name, text] of sources) {
    if (name === 'lan-engine.js') continue;
    if (name === 'lan-session.js') {
      assert.match(text, /requireAdmission\(\);\s*super\(options\)/, 'the wrapper checks admission before the engine is constructed');
      continue;
    }
    assert.doesNotMatch(text, /lan-engine/, `${name} must not import the engine directly`);
    assert.doesNotMatch(text, /ObservationEngine/, `${name} must not name the engine`);
  }
});

test('no production source retains the removed acknowledgement or any verification override', () => {
  for (const [name, text] of sources) {
    assert.doesNotMatch(text, /OBSERVE_UNVERIFIED_CONTRACT|OBSERVATION_ACK|observationAck|device-report-topic;mqtt/, `${name} still references the acknowledgement`);
  }
});

test('the engine remains constructible only for offline mechanics and is not a session type the wrapper hides', () => {
  const engine = new ObservationEngine({ config: config(), channelFactory: recordingFactory().factory });
  assert.equal(engine.observation().phase, 'unavailable');
  assert.equal(engine instanceof LanReadOnlySession, false);
});
