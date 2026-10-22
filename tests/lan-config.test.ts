import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_STUDIO_CA_FILE, ENV_ACCESS_CODE, ENV_CA_FILE, ENV_HOST, ENV_SERIAL, buildLiveConfig, isPrivateIPv4Literal, isX2dSerial, parseLiveInputJson, takeLiveInputFromEnv,
} from '../src/lan-config.js';
import {
  LAN_CONTRACT, LAN_PORT, MQTT_USERNAME, UNRESOLVED_CONTRACT_ITEMS, admitContract, evaluateAdmission, reportTopic, requireAdmission,
} from '../src/lan-contract.js';
import type { ContractItem } from '../src/lan-contract.js';
import { CA_PEM, CODE, HOST, SERIAL, operatorInput } from './lan-helpers.js';

const reads: string[] = [];
const readFile = (path: string): string => { reads.push(path); return CA_PEM; };
const codeOf = (fn: () => unknown): { code: string; message: string } => {
  try { fn(); } catch (error) { return error as { code: string; message: string }; }
  throw new Error('expected a throw');
};

test('private IPv4 literals only, in canonical form', () => {
  for (const ok of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.100.200']) assert.equal(isPrivateIPv4Literal(ok), true, ok);
  for (const bad of [
    '', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '127.0.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '192.168.1', '192.168.1.1.1',
    '192.168.1.256', '192.168.01.1', '192.168.1.1 ', ' 192.168.1.1', '192.168.1.1/24', '192.168.1.0-255', 'printer.local', '::1', 'fe80::1', '0xc0.0xa8.0.1',
    '010.0.0.1', '192.168.1.-1', '10.0.0.1:8883', '192.168.1.+1',
  ]) assert.equal(isPrivateIPv4Literal(bad), false, bad);
  for (const notString of [undefined, null, 1, {}, ['192.168.1.1']]) assert.equal(isPrivateIPv4Literal(notString), false);
});

test('only the X2D serial prefix with a bounded uppercase alphanumeric body is accepted', () => {
  assert.equal(isX2dSerial('20P00A000000000'), true);
  assert.equal(isX2dSerial('20PABCDEF'), true);
  for (const bad of ['', '20P', '20PABCDE', '20P' + 'A'.repeat(21), '01P00A000000000', '20p00a000000000', '20P00A0-0000000', 'x20P00A000000000', '20P00A000000000\n', 7, null, undefined]) {
    assert.equal(isX2dSerial(bad), false, String(bad));
  }
});

test('environment input is read once and removed from the inherited environment', () => {
  const env: Record<string, string | undefined> = {
    [ENV_HOST]: HOST, [ENV_SERIAL]: SERIAL, [ENV_ACCESS_CODE]: CODE, [ENV_CA_FILE]: '/ca.pem', UNRELATED: 'kept',
  };
  const input = takeLiveInputFromEnv(env);
  assert.deepEqual(input, { host: HOST, serial: SERIAL, accessCode: CODE, caFile: '/ca.pem' });
  assert.deepEqual(env, { UNRELATED: 'kept' });
  assert.deepEqual(takeLiveInputFromEnv(env), { host: undefined, serial: undefined, accessCode: undefined, caFile: undefined });
});

test('stdin JSON is strict: one object, known keys, string values only', () => {
  assert.deepEqual(parseLiveInputJson(JSON.stringify(operatorInput())), operatorInput());
  for (const bad of ['', '{', 'null', '[]', '"x"', '7', '{"host":1}', '{"extra":"x"}', '{"__proto__":"x"}', '{"constructor":"x"}', '{"host":null}', '{"host":["a"]}', '{"observationAck":"device-report-topic;mqtt-3.1.1;qos-0"}']) {
    const failure = codeOf(() => parseLiveInputJson(bad));
    assert.equal(failure.code, 'LIVE_CONFIG_INVALID');
    assert.equal(failure.message, 'Invalid input.');
  }
});

test('a valid operator input yields a configuration with the default public CA path', () => {
  reads.length = 0;
  assert.deepEqual(buildLiveConfig(operatorInput(), readFile), { host: HOST, serial: SERIAL, accessCode: CODE, caPem: CA_PEM });
  assert.deepEqual(reads, [DEFAULT_STUDIO_CA_FILE]);
  reads.length = 0;
  buildLiveConfig({ ...operatorInput(), caFile: '/tmp/vendor-ca.pem' }, readFile);
  assert.deepEqual(reads, ['/tmp/vendor-ca.pem']);
});

test('each invalid field is rejected with a message naming only the field', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ host: 'printer.local' }, 'host'], [{ host: undefined }, 'host'], [{ host: '8.8.8.8' }, 'host'],
    [{ serial: '01P00A000000000' }, 'serial'], [{ serial: undefined }, 'serial'],
    [{ accessCode: 'abc' }, 'access code'], [{ accessCode: 'a'.repeat(65) }, 'access code'], [{ accessCode: 'has space' }, 'access code'],
    [{ accessCode: 'tab\tcode' }, 'access code'], [{ accessCode: 12345678 }, 'access code'], [{ accessCode: undefined }, 'access code'],
    [{ accessCode: 'códe-1234' }, 'access code'],
    [{ caFile: 'relative/ca.pem' }, 'CA file'], [{ caFile: 7 }, 'CA file'], [{ caFile: `/${'a'.repeat(1030)}` }, 'CA file'], [{ caFile: '/a\0b' }, 'CA file'],
  ];
  for (const [override, field] of cases) {
    const failure = codeOf(() => buildLiveConfig({ ...operatorInput(), ...override }, readFile));
    assert.equal(failure.code, 'LIVE_CONFIG_INVALID');
    assert.equal(failure.message, `Invalid ${field}.`);
  }
});

test('CA material is bounded: unreadable, empty, non-PEM, oversized and over-many-certificate files are refused', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
  const refusals: Record<string, () => string> = {
    unreadable: () => { throw new Error(`ENOENT ${HOST}`); },
    empty: () => '',
    notPem: () => 'plain text',
    huge: () => pem + 'A'.repeat(20_000),
    five: () => pem.repeat(5),
  };
  for (const [label, read] of Object.entries(refusals)) {
    const failure = codeOf(() => buildLiveConfig(operatorInput(), read));
    assert.equal(failure.message, 'Invalid CA file.', label);
  }
  assert.equal(buildLiveConfig(operatorInput(), () => pem.repeat(4)).caPem, pem.repeat(4));
});

test('contract: fixed values, accurate evidence labels, and unresolved items are exactly the unproven ones', () => {
  assert.equal(LAN_PORT, 8883);
  assert.equal(MQTT_USERNAME, 'bblp');
  assert.equal(reportTopic(SERIAL), `device/${SERIAL}/report`);
  const byId = new Map(LAN_CONTRACT.map((item) => [item.id, item]));
  assert.equal(byId.size, LAN_CONTRACT.length, 'ledger ids are unique');
  for (const id of UNRESOLVED_CONTRACT_ITEMS) {
    const evidence = byId.get(id)?.evidence;
    assert.ok(evidence === 'implementation-choice' || evidence === 'unverified', `${id} must not be labelled as verified`);
  }
  for (const item of LAN_CONTRACT) {
    if (item.evidence === 'implementation-choice' || item.evidence === 'unverified') {
      assert.ok(item.id === 'extruder-id-mapping' || UNRESOLVED_CONTRACT_ITEMS.includes(item.id), `${item.id} is unproven yet not gating admission`);
    }
  }
  assert.equal(byId.get('mqtt-username')?.evidence, 'first-party-source');
  assert.equal(byId.get('x2d-firmware-and-schema')?.evidence, 'unverified');
  assert.equal(byId.get('report-topic')?.evidence, 'implementation-choice');
  assert.ok(Object.isFrozen(LAN_CONTRACT) && Object.isFrozen(UNRESOLVED_CONTRACT_ITEMS));
});

const verified = (item: ContractItem): ContractItem => ({ ...item, evidence: 'first-party-source', source: 'synthetic test ledger' });

test('real admission is closed with the exact unresolved items and their labels, and cannot be argued open', () => {
  const admission = admitContract();
  assert.equal(admission.admitted, false);
  const reason = admission.admitted ? '' : admission.reason;
  assert.match(reason, /report-topic \[implementation-choice\]/);
  assert.match(reason, /mqtt-protocol-version \[implementation-choice\]/);
  assert.match(reason, /subscription-qos \[implementation-choice\]/);
  assert.match(reason, /x2d-firmware-and-schema \[unverified\]/);
  assert.match(reason, /no operator override/);
  assert.doesNotMatch(reason, /BAMBU_X2D|acknowledg/i, 'no environment variable or acknowledgement is advertised');
  const failure = codeOf(() => requireAdmission());
  assert.equal(failure.code, 'CONTRACT_UNVERIFIED');
  assert.equal(failure.message, reason);
});

test('the admission rule needs vendor-verified evidence for every required item and nothing else', () => {
  const needed = new Set(UNRESOLVED_CONTRACT_ITEMS);
  const allVerified = LAN_CONTRACT.map((item) => (needed.has(item.id) ? verified(item) : item));
  assert.deepEqual(evaluateAdmission(allVerified), { admitted: true });
  assert.deepEqual(evaluateAdmission(allVerified.map((item) => (item.id === 'extruder-id-mapping' ? { ...item, evidence: 'unverified' } : item))), { admitted: true }, 'nozzle mapping does not gate telemetry that never extracts nozzles');
  for (const id of UNRESOLVED_CONTRACT_ITEMS) {
    for (const label of ['implementation-choice', 'unverified'] as const) {
      const result = evaluateAdmission(allVerified.map((item) => (item.id === id ? { ...item, evidence: label } : item)));
      assert.equal(result.admitted, false, `${id} as ${label}`);
      assert.match(result.admitted ? '' : result.reason, new RegExp(`${id} \\[${label}\\]`));
    }
    const missing = evaluateAdmission(allVerified.filter((item) => item.id !== id));
    assert.equal(missing.admitted, false);
    assert.match(missing.admitted ? '' : missing.reason, new RegExp(`${id} \\[missing\\]`));
  }
  assert.equal(evaluateAdmission([]).admitted, false);
  for (const label of ['official-documentation', 'first-party-source'] as const) {
    assert.deepEqual(evaluateAdmission(LAN_CONTRACT.map((item) => (needed.has(item.id) ? { ...item, evidence: label } : item))), { admitted: true });
  }
});

test('the ledger is immutable at runtime, so evidence cannot be upgraded in place', () => {
  assert.ok(LAN_CONTRACT.every((item) => Object.isFrozen(item)));
  const topic = LAN_CONTRACT.find((item) => item.id === 'report-topic')!;
  assert.throws(() => { (topic as { evidence: string }).evidence = 'first-party-source'; }, TypeError);
  assert.throws(() => { (LAN_CONTRACT as ContractItem[]).push(topic); }, TypeError);
  assert.equal(admitContract().admitted, false);
});
