import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LIMITS,
  LIVE_PRINTER_ID,
  LiveSessionError,
  ObservationEngine,
  STAGE_TEXT,
  createElapsedClock,
  resolveLimits,
  writeThroughGate,
} from '../src/lan-engine.js';
import type { LiveFailureStage, SessionStats } from '../src/lan-engine.js';
import { encodeDisconnect, encodePingReq, encodeSubscribe } from '../src/mqtt-codec.js';
import type { OutboundPacket } from '../src/mqtt-codec.js';
import {
  CA_PEM, CODE, HOST, SERIAL, TOPIC, config, connack, harness, observing, packet, pingresp, publish, recordingFactory, status, suback, unavailable, writtenTypes,
} from './lan-helpers.js';

const stageOf = async (promise: Promise<unknown>): Promise<LiveFailureStage | 'resolved'> => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    assert.ok(error instanceof LiveSessionError);
    assert.equal(error.code, 'LIVE_UNAVAILABLE');
    assert.equal(error.message, STAGE_TEXT[error.stage]);
    return error.stage;
  }
};

const emptyStats = (): SessionStats => ({
  messagesReceived: 0, bytesReceived: 0, framesAccepted: 0, ignored: {},
  outboundPackets: { connect: 0, subscribe: 0, pingreq: 0, disconnect: 0 }, blockedOutbound: 0,
});

test('opens exactly one channel to the fixed port with the exact serial as SNI and the supplied CA', async () => {
  const rig = harness();
  await rig.subscribe();
  assert.deepEqual(rig.recorder.targets, [{ host: HOST, port: 8883, serverName: SERIAL, caPem: CA_PEM }]);
  assert.deepEqual(rig.session.descriptor(), { id: LIVE_PRINTER_ID, family: 'X2D', firmware: 'unverified', transport: 'lan-readonly', hardwareValidated: false });
});

test('CONNECT then one exact SUBSCRIBE are the only frames written before telemetry', async () => {
  const rig = harness();
  await rig.subscribe();
  assert.deepEqual(writtenTypes(rig.recorder), [1, 8]);
  const connect = rig.recorder.written[0]!;
  assert.match(connect.toString('latin1'), /\u0004bblp\u0000\u0010synthetic-code-1$/);
  const subscribe = rig.recorder.written[1]!;
  assert.equal(subscribe.subarray(6, 6 + TOPIC.length).toString(), TOPIC);
  assert.equal(subscribe.at(-1), 0);
  assert.equal(subscribe.includes(Buffer.from('#')), false);
  assert.doesNotMatch(subscribe.toString('latin1'), new RegExp(CODE));
});

test('accepts a status frame and exposes only normalized fields', async () => {
  const rig = harness();
  await rig.subscribe();
  assert.deepEqual(rig.session.observation(), { phase: 'observing', freshness: 'none', ageMs: null, acceptedFrames: 0, fields: null, warnings: [] });
  rig.handlers().data(publish(TOPIC, status({ subtask_name: 'CANARY-JOB' })));
  const observed = rig.session.observation();
  assert.equal(observed.phase, 'observing');
  if (observed.phase !== 'observing') return;
  assert.equal(observed.freshness, 'fresh');
  assert.equal(observed.ageMs, 0);
  assert.equal(observed.acceptedFrames, 1);
  assert.deepEqual(observed.fields, { state: 'printing', progressPercent: 42, timeRemainingSeconds: 1800, bedC: 55 });
  assert.doesNotMatch(JSON.stringify([observed, rig.session.report()]), /CANARY|synthetic-code|20P00A|192\.168/);
});

test('handles fragmented and coalesced peer bytes across the whole handshake', async () => {
  const rig = harness();
  const started = rig.session.start();
  rig.handlers().secure();
  const stream = Buffer.concat([connack(), suback(), publish(TOPIC, status()), pingresp()]);
  for (const byte of stream) rig.handlers().data(Buffer.from([byte]));
  await started;
  assert.equal(rig.session.report().stats.framesAccepted, 1);

  const second = harness();
  const secondStarted = second.session.start();
  second.handlers().secure();
  second.handlers().data(Buffer.concat([connack(), suback(), publish(TOPIC, status()), publish(TOPIC, status())]));
  await secondStarted;
  assert.equal(second.session.report().stats.framesAccepted, 2);
});

test('later frames fully replace earlier ones and ignored frames are counted by reason only', async () => {
  const rig = harness();
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status()));
  rig.handlers().data(publish(TOPIC, JSON.stringify({ print: { command: 'push_status', msg: 1, mc_percent: 99 } })));
  rig.handlers().data(publish(TOPIC, '{broken PEER-SECRET'));
  rig.handlers().data(publish(TOPIC, JSON.stringify({ print: { command: 'push_status', gcode_state: 'IDLE' } })));
  const observed = rig.session.observation();
  assert.equal(observed.phase === 'observing' && observed.acceptedFrames, 2);
  assert.deepEqual(observed.phase === 'observing' && observed.fields, { state: 'idle', progressPercent: null, timeRemainingSeconds: null, bedC: null });
  const report = rig.session.report();
  assert.deepEqual(report.stats.ignored, { 'diff-message': 1, 'malformed-json': 1 });
  assert.equal(report.stats.messagesReceived, 4);
  assert.doesNotMatch(JSON.stringify(report), /PEER-SECRET/);
});

test('freshness: values go stale after the configured age and recover only with a new frame', async () => {
  const rig = harness({ limits: { staleAfterMs: 5_000 } });
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status()));
  rig.setNow(rig.now() + 5_000);
  assert.equal(observing(rig.session).freshness, 'fresh');
  rig.setNow(rig.now() + 1);
  const stale = rig.session.observation();
  assert.equal(stale.phase === 'observing' && stale.freshness, 'stale');
  assert.equal(stale.phase === 'observing' && stale.ageMs, 5_001);
  rig.handlers().data(publish(TOPIC, status()));
  assert.equal(observing(rig.session).freshness, 'fresh');
});

test('observation is unavailable before subscription', async () => {
  const rig = harness();
  assert.deepEqual(rig.session.observation(), { phase: 'unavailable', reason: 'Live X2D read-only session is not subscribed yet.', stage: null });
  rig.session.start();
  assert.equal(rig.session.observation().phase, 'unavailable');
  rig.handlers().secure();
  assert.equal(rig.session.observation().phase, 'unavailable');
});

test('authentication rejection stops at once without retry, DISCONNECT or a second connect', async () => {
  for (const code of [4, 5]) {
    const rig = harness();
    const started = rig.session.start();
    rig.handlers().secure();
    rig.handlers().data(connack(code));
    assert.equal(await stageOf(started), 'authentication');
    assert.equal(rig.recorder.targets.length, 1);
    assert.deepEqual(writtenTypes(rig.recorder), [1]);
    assert.equal(rig.recorder.destroyed, 1);
    const report = await rig.session.finished;
    assert.equal(report.end, 'authentication');
    rig.advance(120_000);
    assert.equal(rig.recorder.targets.length, 1, 'no reconnect after the end');
  }
});

test('other CONNACK refusals, TLS verification and connection failures are distinct and write nothing', async () => {
  const refused = harness();
  const refusedStart = refused.session.start();
  refused.handlers().secure();
  refused.handlers().data(connack(3));
  assert.equal(await stageOf(refusedStart), 'connect-refused');

  for (const stage of ['tls-verify', 'connect', 'peer-closed'] as const) {
    const rig = harness();
    const started = rig.session.start();
    rig.handlers().failed(stage);
    assert.equal(await stageOf(started), stage);
    assert.deepEqual(rig.recorder.written, []);
    assert.equal(rig.recorder.destroyed, 1);
    assert.equal(unavailable(rig.session).stage, stage);
  }
});

test('a channel factory that throws ends the session with a fixed connect failure', async () => {
  const session = new ObservationEngine({
    config: config(),
    channelFactory: () => { throw new Error(`boom ${CODE} ${SERIAL}`); },
  });
  const stage = await stageOf(session.start());
  assert.equal(stage, 'connect');
  assert.equal((await session.finished).end, 'connect');
});

test('subscription refusal, granted QoS above 0, wrong ids and out-of-order packets are protocol-bounded', async () => {
  const run = async (script: (rig: ReturnType<typeof harness>) => void, secure = true): Promise<LiveFailureStage | 'resolved'> => {
    const rig = harness();
    const started = rig.session.start();
    if (secure) rig.handlers().secure();
    script(rig);
    return stageOf(started);
  };
  assert.equal(await run((rig) => { rig.handlers().data(connack()); rig.handlers().data(suback(1, 0x80)); }), 'subscription');
  assert.equal(await run((rig) => { rig.handlers().data(connack()); rig.handlers().data(suback(1, 1)); }), 'protocol');
  assert.equal(await run((rig) => { rig.handlers().data(connack()); rig.handlers().data(suback(2, 0)); }), 'protocol');
  assert.equal(await run((rig) => { rig.handlers().data(suback(1, 0)); }), 'protocol');
  assert.equal(await run((rig) => { rig.handlers().data(connack()); rig.handlers().data(connack()); }), 'protocol');
  assert.equal(await run((rig) => { rig.handlers().data(pingresp()); }), 'protocol');
  assert.equal(await run((rig) => { rig.handlers().data(connack()); rig.handlers().data(pingresp()); }), 'protocol');
  assert.equal(await run((rig) => { rig.handlers().data(connack()); rig.handlers().data(publish(TOPIC, status())); }), 'protocol');
  assert.equal(await run((rig) => { rig.handlers().data(connack()); rig.handlers().data(suback()); rig.handlers().data(suback()); }), 'resolved');
});

test('a second SUBACK or CONNACK after subscription, a foreign topic or QoS 1 ends the session', async () => {
  const cases: [string, Buffer][] = [
    ['suback', suback()],
    ['connack', connack()],
    ['foreign topic', publish('device/OTHER/report', status())],
    ['wildcard-like topic', publish('device/+/report', status())],
    ['qos 1', publish(TOPIC, status(), 2)],
    ['unsupported type', packet(0x40, Buffer.from([0, 9]))],
  ];
  for (const [label, bytes] of cases) {
    const rig = harness();
    await rig.subscribe();
    rig.handlers().data(bytes);
    assert.equal((await rig.session.finished).end, 'protocol', label);
    assert.deepEqual(writtenTypes(rig.recorder), [1, 8], `${label}: a protocol failure writes nothing further, no PUBLISH or acknowledgement`);
  }
});

test('oversized and malformed frames fail closed with protocol', async () => {
  const rig = harness({ limits: { maxPacketBytes: 32 } });
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, 'x'.repeat(200)));
  assert.equal((await rig.session.finished).end, 'protocol');
  rig.handlers().data(pingresp());
  assert.equal(rig.session.report().stats.messagesReceived, 0);
});

test('connect, subscribe and keep-alive deadlines end the session with a timeout', async () => {
  const connectRig = harness({ limits: { connectTimeoutMs: 5_000 } });
  const connectStart = connectRig.session.start();
  connectRig.advance(4_999);
  connectRig.advance(1);
  assert.equal(await stageOf(connectStart), 'timeout');
  assert.deepEqual(connectRig.recorder.written, []);

  const subscribeRig = harness({ limits: { subscribeTimeoutMs: 3_000 } });
  const subscribeStart = subscribeRig.session.start();
  subscribeRig.handlers().secure();
  subscribeRig.handlers().data(connack());
  subscribeRig.advance(3_000);
  assert.equal(await stageOf(subscribeStart), 'timeout');
  assert.deepEqual(writtenTypes(subscribeRig.recorder), [1, 8], 'no DISCONNECT is claimed for an unconfirmed subscription');
});

test('keep-alive sends PINGREQ at half the interval and times out when the peer is silent', async () => {
  const rig = harness({ limits: { keepAliveSeconds: 10 } });
  await rig.subscribe();
  rig.advance(4_999);
  assert.deepEqual(writtenTypes(rig.recorder), [1, 8]);
  rig.advance(1);
  assert.deepEqual(writtenTypes(rig.recorder), [1, 8, 12]);
  rig.handlers().data(pingresp());
  rig.advance(10_000);
  assert.equal(writtenTypes(rig.recorder).filter((type) => type === 12).length, 2);
  rig.advance(10_000);
  assert.equal((await rig.session.finished).end, 'timeout');
  assert.equal(writtenTypes(rig.recorder).at(-1), 12, 'timeout does not claim a graceful DISCONNECT');
});

test('inbound traffic keeps a session alive past the silence threshold', async () => {
  const rig = harness({ limits: { keepAliveSeconds: 10 } });
  await rig.subscribe();
  for (let index = 0; index < 20; index += 1) {
    rig.setNow(rig.now() + 5_000);
    rig.handlers().data(pingresp());
    rig.tick();
  }
  assert.equal(rig.session.observation().phase, 'observing');
});

test('message, byte and duration caps end gracefully with DISCONNECT', async () => {
  const messages = harness({ limits: { maxMessages: 2 } });
  await messages.subscribe();
  messages.handlers().data(publish(TOPIC, status()));
  assert.equal(messages.session.observation().phase, 'observing');
  messages.handlers().data(publish(TOPIC, status()));
  const messageReport = await messages.session.finished;
  assert.equal(messageReport.end, 'limit');
  assert.deepEqual(writtenTypes(messages.recorder), [1, 8, 14]);
  assert.match(unavailable(messages.session).reason, /resource limit/);

  const bytes = harness({ limits: { maxBytes: 200 } });
  await bytes.subscribe();
  bytes.handlers().data(publish(TOPIC, status()));
  bytes.handlers().data(publish(TOPIC, status()));
  assert.equal((await bytes.session.finished).end, 'limit');
  bytes.handlers().data(publish(TOPIC, status()));
  assert.equal(bytes.session.report().stats.bytesReceived <= 400, true);

  const time = harness({ limits: { maxSessionMs: 10_000 } });
  await time.subscribe();
  time.advance(10_000);
  assert.equal((await time.session.finished).end, 'limit');
});

test('caller close is graceful, idempotent and sends one DISCONNECT only after the broker accepted', async () => {
  const early = harness();
  const earlyStart = early.session.start();
  early.handlers().secure();
  const earlyReport = await early.session.close();
  assert.equal(earlyReport.end, 'closed');
  assert.equal(await stageOf(earlyStart), 'cancelled');
  assert.deepEqual(writtenTypes(early.recorder), [1]);

  const rig = harness();
  await rig.subscribe();
  const first = await rig.session.close();
  const second = await rig.session.close();
  assert.equal(first.end, 'closed');
  assert.equal(second.end, 'closed');
  assert.deepEqual(writtenTypes(rig.recorder), [1, 8, 14]);
  assert.equal(rig.recorder.destroyed, 1);
  assert.equal(unavailable(rig.session).stage, null);
  assert.match(unavailable(rig.session).reason, /closed/);
  rig.handlers().data(publish(TOPIC, status()));
  assert.equal(rig.session.report().stats.messagesReceived, 0, 'data after the end is discarded');
  rig.handlers().secure();
  assert.deepEqual(writtenTypes(rig.recorder), [1, 8, 14]);
});

test('close before start never opens a channel and later start does nothing', async () => {
  const rig = harness();
  const report = await rig.session.close();
  assert.equal(report.end, 'closed');
  rig.session.start();
  assert.equal(rig.recorder.targets.length, 0);
});

test('abort signal cancels before and during a session', async () => {
  const before = harness();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await stageOf(before.session.start(controller.signal)), 'cancelled');
  assert.equal(before.recorder.targets.length, 0);
  assert.equal((await before.session.finished).end, 'cancelled');

  const during = harness();
  const live = new AbortController();
  await (async () => { const started = during.session.start(live.signal); during.handlers().secure(); during.handlers().data(connack()); during.handlers().data(suback()); await started; })();
  live.abort();
  assert.equal((await during.session.finished).end, 'cancelled');
  assert.deepEqual(writtenTypes(during.recorder), [1, 8, 14]);
  assert.equal(unavailable(during.session).stage, 'cancelled');

  const finishedFirst = harness();
  const unused = new AbortController();
  const removed: string[] = [];
  const original = unused.signal.removeEventListener.bind(unused.signal);
  unused.signal.removeEventListener = ((...args: Parameters<typeof original>) => { removed.push(args[0]); return original(...args); }) as typeof original;
  finishedFirst.session.start(unused.signal);
  await finishedFirst.session.close();
  assert.deepEqual(removed, ['abort']);
});

test('a second start returns the same promise and does not open another channel', async () => {
  const rig = harness();
  const first = rig.session.start();
  assert.equal(rig.session.start(), first);
  assert.equal(first, rig.session.started);
  assert.equal(rig.recorder.targets.length, 1);
});

test('channel write and destroy failures never escape and end the session safely', async () => {
  const writeFails = harness({ factory: recordingFactory({ writeThrows: true }) });
  const started = writeFails.session.start();
  assert.doesNotThrow(() => writeFails.handlers().secure());
  assert.equal(await stageOf(started), 'peer-closed');

  const destroyFails = harness({ factory: recordingFactory({ destroyThrows: true }) });
  await destroyFails.subscribe();
  const report = await destroyFails.session.close();
  assert.equal(report.end, 'closed');
});

test('a factory that signals before returning its channel is refused as protocol', async () => {
  const created = { destroyed: 0 };
  const session = new ObservationEngine({
    config: config(),
    channelFactory: (_target, handlers) => {
      handlers.secure();
      return { write: () => undefined, destroy: () => { created.destroyed += 1; } };
    },
  });
  assert.equal(await stageOf(session.start()), 'protocol');
  assert.equal(created.destroyed, 1, 'the late channel is destroyed rather than leaked');
});

test('the outbound gate blocks PUBLISH, trailing bytes and any frame that is not a permitted type before the channel', () => {
  const written: Uint8Array[] = [];
  const channel = { write: (frame: Uint8Array) => { written.push(frame); }, destroy: () => undefined };
  const stats = emptyStats();
  const publishFrame = publish(TOPIC, 'x');
  const forgeries = [
    Buffer.from([0x30, 0x03, 0, 1, 0x74]), Buffer.from([0x32, 0x00]), Buffer.from([0xa0, 0x00]), Buffer.from([0x40, 0x02, 0, 1]), Buffer.alloc(0),
    // A permitted prefix must not carry a PUBLISH behind it.
    Buffer.concat([encodePingReq(), publishFrame]), Buffer.concat([encodeDisconnect(), publishFrame]),
    Buffer.concat([encodeSubscribe(1, 'a/b'), publishFrame]), Buffer.concat([encodeSubscribe(1, 'a/b'), encodePingReq()]),
    // Right type with wrong flags, non-empty PINGREQ/DISCONNECT, truncated and over-long headers.
    Buffer.from([0x11, 0x00]), Buffer.from([0x80, 0x00]), Buffer.from([0xc0, 0x02, 0x30, 0x00]), Buffer.from([0xe0, 0x01, 0x00]),
    Buffer.from([0xc0]), Buffer.from([0x10, 0x80]), Buffer.from([0x10, 0x80, 0x80, 0x80, 0x80, 0x01]),
  ];
  for (const forged of forgeries) assert.equal(writeThroughGate(channel, forged as unknown as OutboundPacket, stats), false, forged.toString('hex'));
  assert.equal(stats.blockedOutbound, forgeries.length);
  assert.deepEqual(written, []);
  assert.equal(writeThroughGate(channel, encodePingReq(), stats), true);
  assert.equal(writeThroughGate(channel, encodeDisconnect(), stats), true);
  assert.equal(stats.outboundPackets.pingreq, 1);
  assert.equal(stats.outboundPackets.disconnect, 1);
  assert.equal(written.length, 2);
});

test('a retained report arriving after SUBACK is never presented as current telemetry', async () => {
  const rig = harness();
  await rig.subscribe();
  // Old stored snapshot delivered immediately after subscribing; no live frame follows.
  rig.handlers().data(publish(TOPIC, status(), 1));
  const observation = observing(rig.session);
  assert.equal(observation.freshness, 'none');
  assert.equal(observation.fields, null);
  assert.equal(observation.ageMs, null);
  assert.equal(observation.acceptedFrames, 0);
  assert.equal(rig.session.lastAccepted(), null);
  rig.advance(1_000);
  assert.equal(observing(rig.session).freshness, 'none', 'waiting does not turn it into data');
  const report = rig.session.report();
  assert.deepEqual(report.stats.ignored, { 'retained-report': 1 });
  assert.equal(report.stats.framesAccepted, 0);
  assert.equal(report.stats.messagesReceived, 1, 'still counted against the message cap');
});

test('a retained frame is not parsed at all, does not replace live data and does not refresh age', async () => {
  const rig = harness({ limits: { staleAfterMs: 5_000 } });
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status()));
  rig.setNow(rig.now() + 4_000);
  rig.handlers().data(publish(TOPIC, status({ mc_percent: 99 }), 1));
  rig.handlers().data(publish(TOPIC, '{broken retained PEER-SECRET', 1));
  rig.setNow(rig.now() + 2_000);
  const observation = observing(rig.session);
  assert.equal(observation.freshness, 'stale', 'age counts from the last NON-retained frame (6 s > 5 s)');
  assert.equal(observation.fields?.progressPercent, 42);
  const ignored = rig.session.report().stats.ignored;
  assert.deepEqual(ignored, { 'retained-report': 2 });
  assert.doesNotMatch(JSON.stringify(rig.session.report()), /PEER-SECRET/);
});

test('a live non-retained frame after a retained one becomes the first accepted observation', async () => {
  const rig = harness();
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status({ mc_percent: 7 }), 1));
  rig.handlers().data(publish(TOPIC, status({ mc_percent: 8 })));
  const observation = observing(rig.session);
  assert.equal(observation.freshness, 'fresh');
  assert.equal(observation.acceptedFrames, 1);
  assert.equal(observation.fields?.progressPercent, 8);
});

test('retained reports still count toward the message cap so a retained flood is bounded', async () => {
  const rig = harness({ limits: { maxMessages: 3 } });
  await rig.subscribe();
  for (let index = 0; index < 3; index += 1) rig.handlers().data(publish(TOPIC, status(), 1));
  assert.equal((await rig.session.finished).end, 'limit');
});

test('across a full lifecycle every written frame is CONNECT, SUBSCRIBE, PINGREQ or DISCONNECT only', async () => {
  const rig = harness({ limits: { keepAliveSeconds: 10 } });
  await rig.subscribe();
  for (let index = 0; index < 10; index += 1) {
    rig.handlers().data(publish(TOPIC, status()));
    rig.advance(5_000);
    rig.handlers().data(pingresp());
  }
  await rig.session.close();
  for (const type of writtenTypes(rig.recorder)) assert.ok([1, 8, 12, 14].includes(type), `type ${type}`);
  const stats = rig.session.report().stats;
  assert.deepEqual(Object.keys(stats.outboundPackets).sort(), ['connect', 'disconnect', 'pingreq', 'subscribe']);
  assert.equal(stats.blockedOutbound, 0);
  assert.equal(stats.outboundPackets.connect, 1);
  assert.equal(stats.outboundPackets.subscribe, 1);
  assert.equal(stats.outboundPackets.disconnect, 1);
});

test('failures reveal no host, serial, code, topic or peer text anywhere', async () => {
  const canary = 'PEER-CANARY-9';
  const rig = harness();
  const started = rig.session.start();
  rig.handlers().secure();
  rig.handlers().data(Buffer.concat([connack(), packet(0x40, Buffer.from(canary))]));
  let message = '';
  try { await started; } catch (error) { message = (error as Error).message; }
  const everything = JSON.stringify([message, rig.session.observation(), rig.session.report(), await rig.session.finished]);
  for (const secret of [HOST, SERIAL, CODE, TOPIC, canary, 'bblp']) assert.equal(everything.includes(secret), false, secret);
});

test('lastAccepted survives the end and is a defensive copy', async () => {
  const rig = harness();
  await rig.subscribe();
  assert.equal(rig.session.lastAccepted(), null);
  rig.handlers().data(publish(TOPIC, status()));
  await rig.session.close();
  const first = rig.session.lastAccepted();
  assert.deepEqual(first?.fields, { state: 'printing', progressPercent: 42, timeRemainingSeconds: 1800, bedC: 55 });
  first!.fields.progressPercent = 1;
  assert.equal(rig.session.lastAccepted()?.fields.progressPercent, 42);
});

test('configuration and limits are validated again inside the session', () => {
  const bad: Partial<ReturnType<typeof config>>[] = [
    { host: 'printer.local' }, { host: '8.8.8.8' }, { host: '192.168.1.256' }, { serial: '01P00A000000000' },
    { serial: '20Pa' }, { accessCode: '' }, { accessCode: 5 as unknown as string }, { caPem: 5 as unknown as string },
  ];
  for (const override of bad) {
    assert.throws(() => new ObservationEngine({ config: { ...config(), ...override }, channelFactory: recordingFactory().factory }), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'LIVE_CONFIG_INVALID');
      assert.doesNotMatch(error.message, /192|20P|printer\.local/);
      return true;
    });
  }
  for (const limits of [{ maxMessages: 0 }, { maxBytes: 1.5 }, { staleAfterMs: -1 }, { maxSessionMs: 86_400_001 }, { keepAliveSeconds: 601 }]) {
    assert.throws(() => resolveLimits(limits), /Invalid live session limit/);
  }
  assert.deepEqual(resolveLimits(), DEFAULT_LIMITS);
  assert.equal(resolveLimits({ maxMessages: 7 }).maxMessages, 7);
});

test('the default timer is a real interval that is cleared when the session ends', async () => {
  const rig = recordingFactory();
  const session = new ObservationEngine({ config: config(), channelFactory: rig.factory, limits: { tickMs: 5, connectTimeoutMs: 20 } });
  const keepLoopAlive = setTimeout(() => undefined, 2_000);
  try {
    assert.equal(await stageOf(session.start()), 'timeout');
    assert.equal((await session.finished).end, 'timeout');
  } finally {
    clearTimeout(keepLoopAlive);
  }
});

test('a batch of frames stops being processed the moment the message cap ends the session', async () => {
  const rig = harness({ limits: { maxMessages: 2 } });
  await rig.subscribe();
  const batch = Buffer.concat(Array.from({ length: 5 }, () => publish(TOPIC, status())));
  rig.handlers().data(batch);
  const report = await rig.session.finished;
  assert.equal(report.end, 'limit');
  assert.equal(report.stats.messagesReceived, 2);
  assert.equal(report.stats.framesAccepted, 2);
  assert.deepEqual(writtenTypes(rig.recorder), [1, 8, 14]);
  assert.equal(rig.recorder.destroyed, 1);
  // Later bytes are ignored and change nothing.
  rig.handlers().data(publish(TOPIC, status()));
  assert.equal(rig.session.report().stats.messagesReceived, 2);
});

test('createElapsedClock advances by the larger non-negative delta of the wall and monotonic clocks', () => {
  let wall = 1_000;
  let mono = 50;
  const clock = createElapsedClock(() => wall, () => mono);
  assert.equal(clock(), 1_000);
  wall += 10; mono += 10;
  assert.equal(clock(), 1_010);
  wall -= 3_600_000; mono += 5_000; // wall rolled back one hour while monotonic advanced
  assert.equal(clock(), 6_010);
  wall += 100; mono += 120_000; // wall barely moves after the rollback; monotonic dominates
  assert.equal(clock(), 126_010);
  wall += 300_000; // sleep: the monotonic clock is suspended while wall time advances
  assert.equal(clock(), 426_010);
  mono -= 1; wall -= 1; // both regress: time never goes backwards
  assert.equal(clock(), 426_010);
  assert.equal(clock(), 426_010);
});

test('createElapsedClock with only a wall clock never goes backwards', () => {
  let wall = 10_000;
  const clock = createElapsedClock(() => wall);
  wall -= 4_000;
  assert.equal(clock(), 10_000);
  wall += 500;
  assert.equal(clock(), 10_500);
});

test('freshness ages by the monotonic clock when the wall clock is rolled back', async () => {
  const rig = harness({ monotonic: true });
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status()));
  assert.equal(observing(rig.session).freshness, 'fresh');
  rig.setNow(rig.now() - 3_600_000);
  rig.setMonotonic(5_000 + 61_000);
  const aged = observing(rig.session);
  assert.equal(aged.freshness, 'stale');
  assert.equal(aged.ageMs, 61_000);
  assert.equal(rig.session.lastAccepted()?.freshness, 'stale');
});

test('freshness ages by the wall clock across a sleep that suspends the monotonic clock', async () => {
  const rig = harness({ monotonic: true });
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status()));
  rig.setNow(rig.now() + 120_000);
  const aged = observing(rig.session);
  assert.equal(aged.freshness, 'stale');
  assert.equal(aged.ageMs, 120_000);
});

test('with a wall clock that goes backwards and no monotonic movement, age cannot shrink or go negative', async () => {
  const rig = harness({ monotonic: true });
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status()));
  rig.setNow(rig.now() - 10_000);
  assert.equal(observing(rig.session).ageMs, 0);
});

test('the connect deadline and session cap use the larger elapsed time of the two clocks', async () => {
  const connecting = harness({ monotonic: true, limits: { connectTimeoutMs: 1_000 } });
  const started = connecting.session.start();
  connecting.setNow(connecting.now() - 3_600_000);
  connecting.setMonotonic(5_000 + 1_500);
  connecting.tick();
  assert.equal(await stageOf(started), 'timeout');

  const capped = harness({ monotonic: true, limits: { maxSessionMs: 10_000 } });
  await capped.subscribe();
  capped.setNow(capped.now() - 3_600_000);
  capped.setMonotonic(5_000 + 10_001);
  capped.tick();
  assert.equal((await capped.session.finished).end, 'limit');

  const slept = harness({ monotonic: true, limits: { maxSessionMs: 10_000 } });
  await slept.subscribe();
  slept.setNow(slept.now() + 10_001);
  slept.tick();
  assert.equal((await slept.session.finished).end, 'limit');
});

test('lastAccepted reports its age and freshness at the moment of the call', async () => {
  const rig = harness();
  await rig.subscribe();
  rig.handlers().data(publish(TOPIC, status()));
  rig.setNow(rig.now() + 5_000);
  const early = rig.session.lastAccepted();
  assert.equal(early?.ageMs, 5_000);
  assert.equal(early?.freshness, 'fresh');
  assert.equal(early?.staleAfterMs, DEFAULT_LIMITS.staleAfterMs);
  await rig.session.close();
  rig.setNow(rig.now() + 120_000);
  const late = rig.session.lastAccepted();
  assert.equal(late?.ageMs, 125_000);
  assert.equal(late?.freshness, 'stale');
});
