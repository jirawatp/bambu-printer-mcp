import assert from 'node:assert/strict';
import { ObservationEngine } from '../src/lan-engine.js';
import type { ByteChannel, ChannelFactory, ChannelHandlers, LiveObservation, LiveTarget, SessionLimits } from '../src/lan-engine.js';
import type { LiveConfig } from '../src/lan-config.js';

/** Synthetic values only: nothing here identifies a real printer or credential. */
export const SERIAL = '20P00A000000000';
export const HOST = '192.168.1.50';
export const CODE = 'synthetic-code-1';
export const TOPIC = `device/${SERIAL}/report`;
export const CA_PEM = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';

export const config = (): LiveConfig => ({ host: HOST, serial: SERIAL, accessCode: CODE, caPem: CA_PEM });

export const operatorInput = (): Record<string, string> => ({ host: HOST, serial: SERIAL, accessCode: CODE });

function varint(length: number): Buffer {
  const bytes: number[] = [];
  let rest = length;
  do {
    let digit = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) digit |= 0x80;
    bytes.push(digit);
  } while (rest > 0);
  return Buffer.from(bytes);
}

export function packet(firstByte: number, body: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from([firstByte]), varint(body.length), body]);
}

/** Broker-to-client frames, built independently of the production codec. */
export const connack = (code = 0, sessionPresent = 0): Buffer => packet(0x20, Buffer.from([sessionPresent, code]));
export const suback = (id = 1, code = 0): Buffer => packet(0x90, Buffer.from([id >> 8, id & 0xff, code]));
export const pingresp = (): Buffer => packet(0xd0);
export function publish(topic: string, payload: string | Buffer, flags = 0): Buffer {
  const topicBytes = Buffer.from(topic, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(topicBytes.length);
  return packet(0x30 | flags, Buffer.concat([length, topicBytes, Buffer.from(payload)]));
}

export const status = (extra: Record<string, unknown> = {}): string => JSON.stringify({
  print: {
    command: 'push_status', msg: 0, gcode_state: 'RUNNING', mc_percent: 42, mc_remaining_time: 30,
    device: { bed_temp: (60 << 16) | 55 }, ...extra,
  },
});

export interface Recorder {
  handlers: ChannelHandlers | undefined;
  targets: LiveTarget[];
  written: Buffer[];
  destroyed: number;
}

export function recordingFactory(behavior: { onCreate?: (handlers: ChannelHandlers) => void; writeThrows?: boolean; destroyThrows?: boolean } = {}): { factory: ChannelFactory; recorder: Recorder } {
  const recorder: Recorder = { handlers: undefined, targets: [], written: [], destroyed: 0 };
  const factory: ChannelFactory = (target, handlers) => {
    recorder.targets.push(target);
    recorder.handlers = handlers;
    behavior.onCreate?.(handlers);
    const channel: ByteChannel = {
      write: (frame) => {
        if (behavior.writeThrows === true) throw new Error('SECRET write failure');
        recorder.written.push(Buffer.from(frame));
      },
      destroy: () => {
        recorder.destroyed += 1;
        if (behavior.destroyThrows === true) throw new Error('SECRET destroy failure');
      },
    };
    return channel;
  };
  return { factory, recorder };
}

export interface Harness {
  session: ObservationEngine;
  recorder: Recorder;
  /** Advance the injected clock, then run one scheduler tick. */
  advance(ms: number): void;
  setNow(value: number): void;
  /** Move the injected monotonic clock (only present when the harness was created with `monotonic`). */
  setMonotonic(value: number): void;
  tick(): void;
  now(): number;
  handlers(): ChannelHandlers;
  /** Drive the session to a confirmed subscription. */
  subscribe(): Promise<void>;
}

export function harness(options: { limits?: Partial<SessionLimits>; factory?: ReturnType<typeof recordingFactory>; monotonic?: boolean } = {}): Harness {
  const rig = options.factory ?? recordingFactory();
  let time = 1_000_000;
  let mono = 5_000;
  const callbacks: (() => void)[] = [];
  const session = new ObservationEngine({
    config: config(),
    channelFactory: rig.factory,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    now: () => time,
    ...(options.monotonic === true ? { monotonicNow: () => mono } : {}),
    schedule: (callback) => { callbacks.push(callback); return () => { callbacks.length = 0; }; },
  });
  const tick = (): void => { for (const callback of [...callbacks]) callback(); };
  const handlers = (): ChannelHandlers => {
    if (rig.recorder.handlers === undefined) throw new Error('channel not created');
    return rig.recorder.handlers;
  };
  return {
    session,
    recorder: rig.recorder,
    advance: (ms) => { time += ms; tick(); },
    setNow: (value) => { time = value; },
    setMonotonic: (value) => { mono = value; },
    tick,
    now: () => time,
    handlers,
    subscribe: async () => {
      const started = session.start();
      handlers().secure();
      handlers().data(connack());
      handlers().data(suback());
      await started;
    },
  };
}

/** Control-packet type nibbles of every frame written to a recorder. */
export const writtenTypes = (recorder: Recorder): number[] => recorder.written.map((frame) => frame[0]! >> 4);

type Observing = Extract<LiveObservation, { phase: 'observing' }>;
type Unavailable = Extract<LiveObservation, { phase: 'unavailable' }>;

export function observing(session: ObservationEngine): Observing {
  const observation = session.observation();
  assert.equal(observation.phase, 'observing');
  return observation as Observing;
}

export function unavailable(session: ObservationEngine): Unavailable {
  const observation = session.observation();
  assert.equal(observation.phase, 'unavailable');
  return observation as Unavailable;
}
