import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type tls from 'node:tls';
import { createTlsChannelFactory } from '../src/lan-tls.js';
import type { ChannelHandlers } from '../src/lan-session.js';
import { CA_PEM, HOST, SERIAL, connack } from './lan-helpers.js';
import { encodePingReq } from '../src/mqtt-codec.js';

class FakeSocket extends EventEmitter {
  written: Uint8Array[] = [];
  destroyed = 0;
  write(chunk: Uint8Array): boolean { this.written.push(chunk); return true; }
  destroy(): void { this.destroyed += 1; }
}

function rig() {
  const socket = new FakeSocket();
  const calls: unknown[] = [];
  const events: string[] = [];
  const chunks: Uint8Array[] = [];
  const handlers: ChannelHandlers = {
    secure: () => { events.push('secure'); },
    data: (chunk) => { chunks.push(chunk); },
    closed: () => { events.push('closed'); },
    failed: (kind) => { events.push(`failed:${kind}`); },
  };
  const factory = createTlsChannelFactory(((options: unknown) => { calls.push(options); return socket; }) as unknown as typeof tls.connect);
  const channel = factory({ host: HOST, port: 8883, serverName: SERIAL, caPem: CA_PEM }, handlers);
  return { socket, calls, events, chunks, channel };
}

test('TLS options pin the vendor CA, the exact serial as SNI, the fixed port and full verification', () => {
  const { calls } = rig();
  assert.deepEqual(calls, [{
    host: HOST, port: 8883, servername: SERIAL, ca: [CA_PEM], rejectUnauthorized: true, minVersion: 'TLSv1.2',
  }]);
  const options = calls[0] as Record<string, unknown>;
  for (const relaxed of ['checkServerIdentity', 'secureContext', 'secureOptions', 'ciphers', 'pskCallback', 'allowPartialTrustChain']) {
    assert.equal(Object.hasOwn(options, relaxed), false, relaxed);
  }
});

test('secure connect, data, writes and destroy are forwarded; nothing else is exposed', () => {
  const { socket, events, chunks, channel } = rig();
  socket.emit('secureConnect');
  socket.emit('data', connack());
  assert.deepEqual(events, ['secure']);
  assert.equal(chunks.length, 1);
  const frame = encodePingReq();
  channel.write(frame);
  assert.deepEqual(socket.written, [frame]);
  channel.destroy();
  assert.equal(socket.destroyed, 1);
  assert.deepEqual(Object.keys(channel).sort(), ['destroy', 'write']);
  socket.emit('close');
  assert.deepEqual(events, ['secure', 'closed']);
});

test('certificate and hostname failures map to tls-verify; other pre-connect errors to connect', () => {
  for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'HOSTNAME_MISMATCH', 'SELF_SIGNED_CERT_IN_CHAIN']) {
    const { socket, events } = rig();
    socket.emit('error', Object.assign(new Error(`peer detail ${HOST} ${SERIAL}`), { code }));
    assert.deepEqual(events, ['failed:tls-verify'], code);
  }
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', undefined]) {
    const { socket, events } = rig();
    socket.emit('error', Object.assign(new Error('x'), code === undefined ? {} : { code }));
    assert.deepEqual(events, ['failed:connect'], String(code));
  }
});

test('an error after the secure channel is established is a peer close, never a verification claim', () => {
  const { socket, events } = rig();
  socket.emit('secureConnect');
  socket.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
  socket.emit('error', Object.assign(new Error('late'), { code: 'CERT_HAS_EXPIRED' }));
  assert.deepEqual(events, ['secure', 'failed:peer-closed', 'failed:peer-closed']);
});
