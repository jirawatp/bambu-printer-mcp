/**
 * Minimal, subscribe-only MQTT 3.1.1 client codec.
 *
 * Structural safety property: this module can ENCODE only CONNECT, SUBSCRIBE (one exact,
 * wildcard-free topic at QoS 0), PINGREQ and DISCONNECT. There is deliberately no PUBLISH,
 * UNSUBSCRIBE or acknowledgement encoder, so no caller can build a control or request message
 * with it. Outbound frames carry a type-level brand so a plain byte array cannot be handed to a
 * channel. The decoder accepts only CONNACK, SUBACK, QoS 0 PUBLISH and PINGRESP and rejects
 * everything else, because acknowledging QoS 1/2 would require additional outbound packets.
 *
 * MQTT version 3.1.1 and QoS 0 are implementation choices, not vendor-verified requirements.
 */

export type OutboundType = 'connect' | 'subscribe' | 'pingreq' | 'disconnect';

declare const outboundBrand: unique symbol;
/** A fully encoded frame produced by this module's four permitted encoders. */
export type OutboundPacket = Uint8Array & { readonly [outboundBrand]: OutboundType };

const OUTBOUND_TYPE_BY_FIRST_BYTE: ReadonlyMap<number, OutboundType> = new Map<number, OutboundType>([
  [0x10, 'connect'],
  [0x82, 'subscribe'],
  [0xc0, 'pingreq'],
  [0xe0, 'disconnect'],
]);

/**
 * Classifies a complete outbound buffer as exactly one CONNECT, SUBSCRIBE, PINGREQ or
 * DISCONNECT frame, or returns null. The first byte must match a permitted type with its fixed
 * flags, the remaining-length header must account for every byte (no trailing bytes, so a
 * permitted prefix cannot smuggle a PUBLISH behind it) and PINGREQ/DISCONNECT must be empty.
 */
export function classifyOutbound(bytes: Uint8Array): OutboundType | null {
  const type = bytes[0] === undefined ? undefined : OUTBOUND_TYPE_BY_FIRST_BYTE.get(bytes[0]);
  if (type === undefined) return null;
  let remaining = 0;
  let multiplier = 1;
  let index = 1;
  for (;;) {
    const digit = bytes[index];
    if (digit === undefined || index > 4) return null;
    remaining += (digit & 0x7f) * multiplier;
    index += 1;
    if ((digit & 0x80) === 0) break;
    multiplier *= 128;
  }
  if (bytes.length !== index + remaining) return null;
  if ((type === 'pingreq' || type === 'disconnect') && remaining !== 0) return null;
  return type;
}

const MAX_REMAINING_LENGTH = 268_435_455;

function brand(bytes: Uint8Array): OutboundPacket {
  return bytes as OutboundPacket;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function lengthPrefixed(bytes: Uint8Array): Buffer {
  if (bytes.length > 0xffff) throw new RangeError('field-too-long');
  return Buffer.concat([u16(bytes.length), bytes]);
}

function remainingLength(length: number): Buffer {
  if (!Number.isInteger(length) || length < 0 || length > MAX_REMAINING_LENGTH) throw new RangeError('remaining-length');
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

function frame(firstByte: number, body: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([firstByte]), remainingLength(body.length), body]);
}

export interface ConnectOptions {
  clientId: string;
  username: string;
  password: Uint8Array;
  keepAliveSeconds: number;
}

/** CONNECT with clean session, username and password flags. */
export function encodeConnect(options: ConnectOptions): OutboundPacket {
  if (options.clientId.length < 1 || options.clientId.length > 64) throw new RangeError('client-id');
  if (!Number.isInteger(options.keepAliveSeconds) || options.keepAliveSeconds < 1 || options.keepAliveSeconds > 0xffff) {
    throw new RangeError('keep-alive');
  }
  const body = Buffer.concat([
    lengthPrefixed(Buffer.from('MQTT', 'utf8')),
    Buffer.from([0x04, 0xc2]),
    u16(options.keepAliveSeconds),
    lengthPrefixed(Buffer.from(options.clientId, 'utf8')),
    lengthPrefixed(Buffer.from(options.username, 'utf8')),
    lengthPrefixed(options.password),
  ]);
  return brand(frame(0x10, body));
}

/** SUBSCRIBE for exactly one literal topic at requested QoS 0. Wildcards are refused. */
export function encodeSubscribe(packetId: number, topic: string): OutboundPacket {
  if (!Number.isInteger(packetId) || packetId < 1 || packetId > 0xffff) throw new RangeError('packet-id');
  const topicBytes = Buffer.from(topic, 'utf8');
  if (topicBytes.length < 1 || topicBytes.length > 256 || /[#+\u0000]/.test(topic)) throw new RangeError('topic');
  const body = Buffer.concat([u16(packetId), lengthPrefixed(topicBytes), Buffer.from([0x00])]);
  return brand(frame(0x82, body));
}

export function encodePingReq(): OutboundPacket {
  return brand(Buffer.from([0xc0, 0x00]));
}

export function encodeDisconnect(): OutboundPacket {
  return brand(Buffer.from([0xe0, 0x00]));
}

export type MqttViolation =
  | 'malformed-remaining-length'
  | 'packet-too-large'
  | 'unsupported-packet-type'
  | 'unsupported-qos'
  | 'malformed-packet'
  | 'invalid-topic'
  | 'decoder-failed';

/** A bounded, secret-free protocol failure; the message is only the violation label. */
export class MqttProtocolError extends Error {
  constructor(public readonly violation: MqttViolation) {
    super(violation);
    this.name = 'MqttProtocolError';
  }
}

export type MqttPacket =
  | { type: 'connack'; sessionPresent: boolean; returnCode: number }
  | { type: 'suback'; packetId: number; returnCode: number }
  | { type: 'publish'; topic: string; payload: Buffer; retain: boolean }
  | { type: 'pingresp' };

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodePacket(firstByte: number, body: Buffer): MqttPacket {
  const type = firstByte >> 4;
  const flags = firstByte & 0x0f;
  if (type === 2) {
    if (flags !== 0 || body.length !== 2 || (body[0]! & 0xfe) !== 0) throw new MqttProtocolError('malformed-packet');
    return { type: 'connack', sessionPresent: (body[0]! & 1) === 1, returnCode: body[1]! };
  }
  if (type === 9) {
    if (flags !== 0 || body.length !== 3) throw new MqttProtocolError('malformed-packet');
    return { type: 'suback', packetId: body.readUInt16BE(0), returnCode: body[2]! };
  }
  if (type === 13) {
    if (flags !== 0 || body.length !== 0) throw new MqttProtocolError('malformed-packet');
    return { type: 'pingresp' };
  }
  if (type === 3) {
    if (((flags >> 1) & 3) !== 0) throw new MqttProtocolError('unsupported-qos');
    if ((flags & 0x08) !== 0 || body.length < 2) throw new MqttProtocolError('malformed-packet');
    const topicLength = body.readUInt16BE(0);
    if (topicLength === 0 || 2 + topicLength > body.length) throw new MqttProtocolError('malformed-packet');
    let topic: string;
    try {
      topic = utf8.decode(body.subarray(2, 2 + topicLength));
    } catch {
      throw new MqttProtocolError('invalid-topic');
    }
    return { type: 'publish', topic, payload: Buffer.from(body.subarray(2 + topicLength)), retain: (flags & 1) === 1 };
  }
  throw new MqttProtocolError('unsupported-packet-type');
}

/**
 * Incremental decoder tolerant of arbitrary TCP/TLS fragmentation and coalescing. After any
 * violation it is permanently failed; the owner must close the connection.
 *
 * Linear work: each incoming chunk is copied once into a pending list; the header is parsed from
 * at most five peeked bytes without joining anything; a packet body is assembled exactly once,
 * when its declared length is fully buffered. Fragmenting a packet into one-byte chunks therefore
 * costs the same copying as sending it whole. The declared length is checked against the cap as
 * soon as the header is complete, before any body byte is awaited.
 */
export class MqttDecoder {
  #chunks: Buffer[] = [];
  #head = 0;
  #pending = 0;
  #failed = false;

  constructor(private readonly maxPacketBytes: number) {}

  push(chunk: Uint8Array): MqttPacket[] {
    if (this.#failed) throw new MqttProtocolError('decoder-failed');
    try {
      if (chunk.length > 0) {
        this.#chunks.push(Buffer.from(chunk));
        this.#pending += chunk.length;
      }
      const packets: MqttPacket[] = [];
      for (;;) {
        const parsed = this.#next();
        if (parsed === null) {
          this.#compact();
          return packets;
        }
        packets.push(parsed);
      }
    } catch (error) {
      this.#failed = true;
      this.#chunks = [];
      this.#head = 0;
      this.#pending = 0;
      throw error;
    }
  }

  /** Copy up to `count` leading pending bytes without consuming them. */
  #peek(count: number): Buffer {
    const out = Buffer.alloc(Math.min(count, this.#pending));
    let filled = 0;
    for (let index = this.#head; filled < out.length; index += 1) {
      filled += this.#chunks[index]!.copy(out, filled, 0, out.length - filled);
    }
    return out;
  }

  /** Remove and return exactly `count` leading bytes (caller guarantees they are pending). */
  #take(count: number): Buffer {
    const first = this.#chunks[this.#head]!;
    this.#pending -= count;
    if (first.length >= count) {
      if (first.length === count) this.#head += 1;
      else this.#chunks[this.#head] = first.subarray(count);
      return first.subarray(0, count);
    }
    const out = Buffer.alloc(count);
    let filled = 0;
    while (filled < count) {
      const part = this.#chunks[this.#head]!;
      const need = count - filled;
      if (part.length <= need) {
        part.copy(out, filled);
        filled += part.length;
        this.#head += 1;
      } else {
        part.copy(out, filled, 0, need);
        this.#chunks[this.#head] = part.subarray(need);
        filled += need;
      }
    }
    return out;
  }

  #compact(): void {
    if (this.#head > 0) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#head = 0;
    }
  }

  #next(): MqttPacket | null {
    if (this.#pending < 2) return null;
    const header = this.#peek(5);
    let remaining = 0;
    let multiplier = 1;
    let index = 1;
    for (;;) {
      if (index > 4) throw new MqttProtocolError('malformed-remaining-length');
      if (index >= header.length) return null;
      const digit = header[index]!;
      remaining += (digit & 0x7f) * multiplier;
      index += 1;
      if ((digit & 0x80) === 0) break;
      multiplier *= 128;
    }
    if (remaining > this.maxPacketBytes) throw new MqttProtocolError('packet-too-large');
    const total = index + remaining;
    if (this.#pending < total) return null;
    const whole = this.#take(total);
    return decodePacket(whole[0]!, whole.subarray(index));
  }
}
