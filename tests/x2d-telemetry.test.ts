import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MAX_REPORT_BYTES, parseReportPayload } from '../src/x2d-telemetry.js';

const parse = (value: unknown, max?: number) => parseReportPayload(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), max);
const print = (extra: Record<string, unknown>) => ({ print: { command: 'push_status', ...extra } });

test('full status frames normalize to the whitelist and convert minutes to seconds', () => {
  const outcome = parse(print({ msg: 0, gcode_state: 'RUNNING', mc_percent: 42, mc_remaining_time: 30, device: { bed_temp: (60 << 16) | 55 } }));
  assert.deepEqual(outcome, {
    kind: 'status',
    fields: { state: 'printing', progressPercent: 42, timeRemainingSeconds: 1800, bedC: 55 },
    warnings: [],
  });
});

test('every mapped state and the unmapped ones', () => {
  const states = { IDLE: 'idle', RUNNING: 'printing', PAUSE: 'paused', FINISH: 'completed' };
  for (const [raw, mapped] of Object.entries(states)) {
    const outcome = parse(print({ gcode_state: raw }));
    assert.equal(outcome.kind === 'status' && outcome.fields.state, mapped);
  }
  for (const raw of ['FAILED', 'PREPARE', 'SLICING', 'running', '__proto__', 'toString', 7, null]) {
    const outcome = parse(print({ gcode_state: raw }));
    assert.equal(outcome.kind === 'status' && outcome.fields.state, null, String(raw));
  }
});

test('absent msg is treated as a full LAN message and numeric strings are accepted within bounds', () => {
  const outcome = parse(print({ gcode_state: 'IDLE', mc_percent: '7', mc_remaining_time: '2', bed_temper: 21.5 }));
  assert.deepEqual(outcome.kind === 'status' && outcome.fields, { state: 'idle', progressPercent: 7, timeRemainingSeconds: 120, bedC: 21.5 });
});

test('out-of-range and malformed values become null with specific warnings, never clamped', () => {
  const outcome = parse(print({ gcode_state: 'RUNNING', mc_percent: 101, mc_remaining_time: -1, bed_temper: 151 }));
  assert.equal(outcome.kind, 'status');
  if (outcome.kind !== 'status') return;
  assert.deepEqual(outcome.fields, { state: 'printing', progressPercent: null, timeRemainingSeconds: null, bedC: null });
  assert.deepEqual(outcome.warnings, [
    'Progress is missing or invalid.', 'Time remaining is missing or invalid.', 'Bed temperature is missing or invalid.',
  ]);
  for (const bad of [1.5, 'x', '1e3', '-1', '1234567890', {}, [], null, true, Number.NaN]) {
    const result = parse(print({ mc_percent: bad }));
    assert.equal(result.kind === 'status' && result.fields.progressPercent, null, String(bad));
  }
  const limit = parse(print({ mc_remaining_time: 525_600 }));
  assert.equal(limit.kind === 'status' && limit.fields.timeRemainingSeconds, 525_600 * 60);
  const over = parse(print({ mc_remaining_time: 525_601 }));
  assert.equal(over.kind === 'status' && over.fields.timeRemainingSeconds, null);
});

test('bed temperature: packed value wins, invalid packed value does not fall back, legacy is bounded', () => {
  const bed = (device: unknown, legacy?: unknown) => {
    const outcome = parse(print({ device, ...(legacy === undefined ? {} : { bed_temper: legacy }) }));
    return outcome.kind === 'status' ? outcome.fields.bedC : 'ignored';
  };
  assert.equal(bed({ bed_temp: 0 }), 0);
  assert.equal(bed({ bed_temp: 150 }), 150);
  assert.equal(bed({ bed_temp: 151 }), null);
  assert.equal(bed({ bed_temp: (80 << 16) | 40 }, 99), 40);
  assert.equal(bed({ bed_temp: 'junk' }, 99), null);
  assert.equal(bed({ bed_temp: -5 }, 99), null);
  assert.equal(bed({ bed_temp: 4_294_967_296 }, 99), null);
  assert.equal(bed({}, 61), 61);
  assert.equal(bed('not-an-object', 61), 61);
  assert.equal(bed(undefined, 'hot'), null);
  assert.equal(bed(undefined, -1), null);
  assert.equal(bed(undefined, Number.POSITIVE_INFINITY), null);
});

test('nozzle temperatures, names, identifiers and unknown keys are never extracted', () => {
  const outcome = parse(print({
    gcode_state: 'RUNNING',
    subtask_name: 'CANARY-JOB-NAME', gcode_file: 'CANARY-FILE', task_id: 'CANARY-TASK', sn: 'CANARY-SERIAL',
    device: { bed_temp: 1, extruder: { info: [{ id: 0, temp: (200 << 16) | 190 }, { id: 1, temp: 5 }] } },
    ams: { ams: [{ tray: [{ tray_uuid: 'CANARY-TRAY' }] }] }, ipcam: { rtsp_url: 'rtsp://CANARY' },
  }));
  assert.equal(outcome.kind, 'status');
  const serialized = JSON.stringify(outcome);
  assert.doesNotMatch(serialized, /CANARY|rtsp|extruder|nozzle|temp/);
  assert.deepEqual(Object.keys(outcome.kind === 'status' ? outcome.fields : {}).sort(), ['bedC', 'progressPercent', 'state', 'timeRemainingSeconds']);
});

test('warnings flag a missing state', () => {
  const outcome = parse(print({}));
  assert.equal(outcome.kind === 'status' && outcome.warnings.includes('State is missing or not mapped.'), true);
});

test('diff messages and non-status frames are ignored, never merged or guessed', () => {
  assert.deepEqual(parse(print({ msg: 1, gcode_state: 'RUNNING' })), { kind: 'ignored', reason: 'diff-message' });
  assert.deepEqual(parse(print({ msg: 2 })), { kind: 'ignored', reason: 'unsupported-message-type' });
  assert.deepEqual(parse(print({ msg: '0' })), { kind: 'ignored', reason: 'unsupported-message-type' });
  assert.deepEqual(parse({ print: { command: 'gcode_line' } }), { kind: 'ignored', reason: 'not-status' });
  assert.deepEqual(parse({ print: { gcode_state: 'RUNNING' } }), { kind: 'ignored', reason: 'not-status' });
  assert.deepEqual(parse({ info: { command: 'get_version' } }), { kind: 'ignored', reason: 'no-print-object' });
  assert.deepEqual(parse({ print: [] }), { kind: 'ignored', reason: 'no-print-object' });
  assert.deepEqual(parse({ print: 'x' }), { kind: 'ignored', reason: 'no-print-object' });
  assert.deepEqual(parse('[1,2]'), { kind: 'ignored', reason: 'not-an-object' });
  assert.deepEqual(parse('null'), { kind: 'ignored', reason: 'not-an-object' });
  assert.deepEqual(parse('7'), { kind: 'ignored', reason: 'not-an-object' });
});

test('malformed, non-UTF-8 and oversized payloads are ignored without echoing content', () => {
  assert.deepEqual(parse('{not json PEER-SECRET'), { kind: 'ignored', reason: 'malformed-json' });
  assert.deepEqual(parseReportPayload(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])), { kind: 'ignored', reason: 'malformed-json' });
  assert.deepEqual(parseReportPayload(Buffer.alloc(11), 10), { kind: 'ignored', reason: 'oversized' });
  assert.deepEqual(parseReportPayload(Buffer.alloc(DEFAULT_MAX_REPORT_BYTES + 1)), { kind: 'ignored', reason: 'oversized' });
  assert.doesNotMatch(JSON.stringify(parse('{not json PEER-SECRET')), /PEER-SECRET/);
});
