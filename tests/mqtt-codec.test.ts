import assert from 'node:assert/strict';
import test from 'node:test';
import * as codec from '../src/mqtt-codec.js';
import {
  MqttDecoder,
  MqttProtocolError,
  type MqttPacket,
  classifyOutbound,
  encodeConnect,
  encodeDisconnect,
  encodePingReq,
  encodeSubscribe,
} from '../src/mqtt-codec.js';
import { connack, packet, pingresp, publish, suback } from './lan-helpers.js';

const violation = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MqttProtocolError);
    return error.violation;
  }
  return 'none';
};

test('CONNECT carries the exact username, password, clean-session flags and MQTT 3.1.1 level', () => {
  const frame = Buffer.from(encodeConnect({ clientId: 'cid', username: 'bblp', password: Buffer.from('pw12'), keepAliveSeconds: 30 }));
  assert.equal(frame[0], 0x10);
  assert.equal(frame[1], frame.length - 2);
  assert.deepEqual([...frame.subarray(2, 10)], [0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0xc2]);
  assert.equal(frame.readUInt16BE(10), 30);
  assert.equal(frame.subarray(12).toString('latin1'), '\u0000\u0003cid\u0000\u0004bblp\u0000\u0004pw12');
});

test('CONNECT validates client id and keep-alive and bounds long fields', () => {
  const base = { clientId: 'cid', username: 'u', password: Buffer.from('p'), keepAliveSeconds: 30 };
  assert.throws(() => encodeConnect({ ...base, clientId: '' }), /client-id/);
  assert.throws(() => encodeConnect({ ...base, clientId: 'x'.repeat(65) }), /client-id/);
  assert.throws(() => encodeConnect({ ...base, keepAliveSeconds: 0 }), /keep-alive/);
  assert.throws(() => encodeConnect({ ...base, keepAliveSeconds: 70_000 }), /keep-alive/);
  assert.throws(() => encodeConnect({ ...base, keepAliveSeconds: 1.5 }), /keep-alive/);
  assert.throws(() => encodeConnect({ ...base, password: Buffer.alloc(70_000) }), /field-too-long/);
});

test('long frames use multi-byte remaining length encoding', () => {
  const frame = Buffer.from(encodeConnect({ clientId: 'cid', username: 'u', password: Buffer.alloc(300, 0x41), keepAliveSeconds: 30 }));
  assert.equal(frame[1]! & 0x80, 0x80);
  const decodedLength = (frame[1]! & 0x7f) + frame[2]! * 128;
  assert.equal(decodedLength, frame.length - 3);
});

test('SUBSCRIBE requests exactly one literal topic at QoS 0 and refuses wildcards', () => {
  const frame = Buffer.from(encodeSubscribe(1, 'device/X/report'));
  assert.equal(frame[0], 0x82);
  assert.equal(frame.readUInt16BE(2), 1);
  assert.equal(frame.readUInt16BE(4), 15);
  assert.equal(frame.subarray(6, 21).toString('utf8'), 'device/X/report');
  assert.equal(frame.at(-1), 0);
  for (const topic of ['#', 'device/#', 'device/+/report', 'a\u0000b', '']) assert.throws(() => encodeSubscribe(1, topic), /topic/);
  assert.throws(() => encodeSubscribe(1, 'x'.repeat(257)), /topic/);
  assert.throws(() => encodeSubscribe(0, 'a'), /packet-id/);
  assert.throws(() => encodeSubscribe(65_536, 'a'), /packet-id/);
});

test('PINGREQ and DISCONNECT are fixed two-byte frames', () => {
  assert.deepEqual([...encodePingReq()], [0xc0, 0]);
  assert.deepEqual([...encodeDisconnect()], [0xe0, 0]);
});

test('the codec has no way to encode PUBLISH or any other mutating packet', () => {
  const encoders = Object.keys(codec).filter((name) => name.startsWith('encode')).sort();
  assert.deepEqual(encoders, ['encodeConnect', 'encodeDisconnect', 'encodePingReq', 'encodeSubscribe']);
  const frames = [
    encodeConnect({ clientId: 'c', username: 'u', password: Buffer.from('p'), keepAliveSeconds: 1 }),
    encodeSubscribe(1, 't'), encodePingReq(), encodeDisconnect(),
  ];
  assert.deepEqual(frames.map((frame) => classifyOutbound(frame)), ['connect', 'subscribe', 'pingreq', 'disconnect']);
  assert.deepEqual(frames.map((frame) => frame[0]! >> 4), [1, 8, 12, 14]);
  assert.equal('ALLOWED_OUTBOUND_TYPE_NIBBLES' in codec, false, 'no mutable allow-list is exported');
});

test('classifyOutbound accepts exactly one permitted frame by type, flags and length and nothing else', () => {
  const publishFrame = publish('t', 'x');
  assert.equal(classifyOutbound(publishFrame), null);
  assert.equal(classifyOutbound(Buffer.concat([encodePingReq(), publishFrame])), null);
  assert.equal(classifyOutbound(Buffer.concat([encodePingReq(), encodePingReq()])), null);
  assert.equal(classifyOutbound(new Uint8Array()), null);
  assert.equal(classifyOutbound(Buffer.from([0xc0])), null);
  assert.equal(classifyOutbound(Buffer.from([0xc0, 0x01, 0x00])), null);
  assert.equal(classifyOutbound(Buffer.from([0x82, 0x80])), null);
  assert.equal(classifyOutbound(Buffer.from([0x82, 0x80, 0x80, 0x80, 0x80, 0x01])), null);
  assert.equal(classifyOutbound(Buffer.from([0x83, 0x00])), null);
  const long = Buffer.from(encodeConnect({ clientId: 'cid', username: 'u', password: Buffer.alloc(300, 0x41), keepAliveSeconds: 30 }));
  assert.equal(classifyOutbound(long), 'connect', 'multi-byte remaining lengths are accounted for');
  assert.equal(classifyOutbound(long.subarray(0, long.length - 1)), null);
});

test('decoder parses CONNACK, SUBACK, PINGRESP and QoS 0 PUBLISH', () => {
  const decoder = new MqttDecoder(1024);
  const packets = decoder.push(Buffer.concat([connack(0, 1), suback(7, 0), pingresp(), publish('t/x', 'hello', 1)]));
  assert.deepEqual(packets[0], { type: 'connack', sessionPresent: true, returnCode: 0 });
  assert.deepEqual(packets[1], { type: 'suback', packetId: 7, returnCode: 0 });
  assert.deepEqual(packets[2], { type: 'pingresp' });
  assert.equal(packets[3]?.type, 'publish');
  assert.equal(packets[3]?.type === 'publish' && packets[3].topic, 't/x');
  assert.equal(packets[3]?.type === 'publish' && packets[3].payload.toString(), 'hello');
  assert.equal(packets[3]?.type === 'publish' && packets[3].retain, true);
});

test('decoder reassembles arbitrarily fragmented input one byte at a time', () => {
  const decoder = new MqttDecoder(1024);
  const stream = Buffer.concat([connack(), publish('t/x', 'x'.repeat(200)), pingresp()]);
  const collected = [];
  for (const byte of stream) collected.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(collected.map((entry) => entry.type), ['connack', 'publish', 'pingresp']);
});

test('decoder returns nothing for incomplete frames and keeps the remainder', () => {
  const decoder = new MqttDecoder(1024);
  const whole = publish('t/x', 'abc');
  assert.deepEqual(decoder.push(whole.subarray(0, 1)), []);
  assert.deepEqual(decoder.push(whole.subarray(1, 3)), []);
  assert.equal(decoder.push(whole.subarray(3)).length, 1);
});

test('decoder refuses malformed remaining lengths and oversized packets', () => {
  assert.equal(violation(() => new MqttDecoder(1024).push(Buffer.from([0x20, 0x80, 0x80, 0x80, 0x80, 0x01]))), 'malformed-remaining-length');
  assert.equal(violation(() => new MqttDecoder(10).push(packet(0x30, Buffer.alloc(11)))), 'packet-too-large');
  // Size is refused from the header alone, before the body arrives.
  assert.equal(violation(() => new MqttDecoder(10).push(Buffer.from([0x30, 0xff, 0x7f]))), 'packet-too-large');
});

test('decoder rejects unsupported and malformed packets with fixed labels', () => {
  const cases: [string, Buffer][] = [
    ['unsupported-packet-type', packet(0x40, Buffer.from([0, 1]))],
    ['unsupported-packet-type', packet(0x10)],
    ['unsupported-qos', publish('t', 'x', 2)],
    ['unsupported-qos', publish('t', 'x', 4)],
    ['malformed-packet', packet(0x38, Buffer.from([0, 1, 0x74]))],
    ['malformed-packet', packet(0x30, Buffer.from([0]))],
    ['malformed-packet', packet(0x30, Buffer.from([0, 0, 0x78]))],
    ['malformed-packet', packet(0x30, Buffer.from([0, 9, 0x74]))],
    ['invalid-topic', packet(0x30, Buffer.from([0, 1, 0xff]))],
    ['malformed-packet', packet(0x21, Buffer.from([0, 0]))],
    ['malformed-packet', packet(0x20, Buffer.from([0]))],
    ['malformed-packet', packet(0x20, Buffer.from([2, 0]))],
    ['malformed-packet', packet(0x91, Buffer.from([0, 1, 0]))],
    ['malformed-packet', packet(0x90, Buffer.from([0, 1]))],
    ['malformed-packet', packet(0xd1)],
    ['malformed-packet', packet(0xd0, Buffer.from([0]))],
  ];
  for (const [label, bytes] of cases) assert.equal(violation(() => new MqttDecoder(1024).push(bytes)), label, `${label} for ${bytes.toString('hex')}`);
});

test('a failed decoder stays failed and never reveals peer bytes', () => {
  const decoder = new MqttDecoder(1024);
  assert.throws(() => decoder.push(packet(0x40, Buffer.from('PEER-SECRET'))), (error: Error) => {
    assert.equal(error.message, 'unsupported-packet-type');
    return true;
  });
  assert.equal(violation(() => decoder.push(connack())), 'decoder-failed');
});

test('fragmented decoding copies a bounded multiple of the packet size, not a quadratic amount', (t) => {
  const body = Buffer.alloc(200_000, 0x61);
  const stream = publish('t/x', body);
  let concatenated = 0;
  const original = Buffer.concat.bind(Buffer);
  t.mock.method(Buffer, 'concat', (list: readonly Uint8Array[], total?: number) => {
    const out = original(list, total);
    concatenated += out.length;
    return out;
  });
  const decoder = new MqttDecoder(300_000);
  const received: MqttPacket[] = [];
  for (let offset = 0; offset < stream.length; offset += 1) received.push(...decoder.push(stream.subarray(offset, offset + 1)));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type === 'publish' && received[0].payload.length, body.length);
  assert.ok(concatenated <= 2 * stream.length, `joined ${concatenated} bytes for a ${stream.length}-byte packet`);
});

test('decoding is identical for any fragmentation of a mixed stream', () => {
  const stream = Buffer.concat([connack(), publish('a/b', 'x'.repeat(300)), pingresp(), publish('c', 'y'.repeat(130_000)), suback(3, 0)]);
  const whole = new MqttDecoder(200_000).push(stream);
  assert.deepEqual(whole.map((entry) => entry.type), ['connack', 'publish', 'pingresp', 'publish', 'suback']);
  for (const size of [1, 2, 3, 5, 127, 128, 129, 4096, stream.length - 1]) {
    const decoder = new MqttDecoder(200_000);
    const pieces: MqttPacket[] = [];
    for (let offset = 0; offset < stream.length; offset += size) pieces.push(...decoder.push(stream.subarray(offset, offset + size)));
    assert.deepEqual(pieces, whole, `chunk size ${size}`);
  }
});

test('the packet size cap is enforced from a fragmented header, before body bytes accumulate', () => {
  const decoder = new MqttDecoder(10);
  assert.deepEqual(decoder.push(Buffer.from([0x30])), []);
  assert.deepEqual(decoder.push(Buffer.from([0xff])), []);
  assert.equal(violation(() => decoder.push(Buffer.from([0x7f]))), 'packet-too-large');
  assert.equal(violation(() => decoder.push(Buffer.alloc(1))), 'decoder-failed');
  const fifth = new MqttDecoder(1024);
  fifth.push(Buffer.from([0x30, 0x80, 0x80, 0x80]));
  assert.equal(violation(() => fifth.push(Buffer.from([0x80]))), 'malformed-remaining-length');
});

test('empty chunks are ignored and the next chunk continues a pending frame', () => {
  const decoder = new MqttDecoder(1024);
  const whole = publish('t/x', 'abc');
  assert.deepEqual(decoder.push(new Uint8Array()), []);
  assert.deepEqual(decoder.push(whole.subarray(0, 4)), []);
  assert.deepEqual(decoder.push(new Uint8Array()), []);
  assert.equal(decoder.push(whole.subarray(4)).length, 1);
});
