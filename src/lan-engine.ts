import { randomBytes } from 'node:crypto';
import { ServiceError } from './domain.js';
import type { PrinterDescriptor } from './domain.js';
import { LAN_PORT, MQTT_USERNAME, reportTopic } from './lan-contract.js';
import { isPrivateIPv4Literal, isX2dSerial } from './lan-config.js';
import type { LiveConfig } from './lan-config.js';
import {
  MqttDecoder,
  classifyOutbound,
  encodeConnect,
  encodeDisconnect,
  encodePingReq,
  encodeSubscribe,
} from './mqtt-codec.js';
import type { MqttPacket, OutboundPacket, OutboundType } from './mqtt-codec.js';
import { DEFAULT_MAX_REPORT_BYTES, parseReportPayload } from './x2d-telemetry.js';
import type { IgnoreReason, LiveFields } from './x2d-telemetry.js';

export type LiveFailureStage =
  | 'cancelled'
  | 'connect'
  | 'tls-verify'
  | 'connect-refused'
  | 'authentication'
  | 'subscription'
  | 'protocol'
  | 'timeout'
  | 'peer-closed';

/** Fixed, bounded, value-free explanations. No peer, payload or exception text is ever included. */
export const STAGE_TEXT: Readonly<Record<LiveFailureStage, string>> = Object.freeze({
  cancelled: 'Live X2D read-only session was cancelled.',
  connect: 'Live X2D read-only session could not open a connection.',
  'tls-verify': 'Live X2D read-only session stopped: TLS certificate chain or hostname verification failed. No retry was made.',
  'connect-refused': 'Live X2D read-only session stopped: the broker refused the connection. No retry was made.',
  authentication: 'Live X2D read-only session stopped: authentication was rejected. No retry was made.',
  subscription: 'Live X2D read-only session stopped: the telemetry subscription was refused. No retry was made.',
  protocol: 'Live X2D read-only session stopped: the peer violated the expected protocol.',
  timeout: 'Live X2D read-only session stopped: a deadline expired.',
  'peer-closed': 'Live X2D read-only session stopped: the peer closed the connection.',
});

export class LiveSessionError extends ServiceError {
  constructor(public readonly stage: LiveFailureStage) {
    super('LIVE_UNAVAILABLE', STAGE_TEXT[stage]);
    this.name = 'LiveSessionError';
  }
}

/** Graceful ends are not failures: a caller close and a reached resource cap. */
export type SessionEnd = 'closed' | 'limit' | LiveFailureStage;

export interface SessionLimits {
  /** Deadline from start until the broker accepts CONNECT. */
  connectTimeoutMs: number;
  /** Deadline from CONNACK until SUBACK. */
  subscribeTimeoutMs: number;
  maxSessionMs: number;
  maxMessages: number;
  maxBytes: number;
  maxPacketBytes: number;
  /** Provisional: no X2D update interval has been measured. */
  staleAfterMs: number;
  keepAliveSeconds: number;
  tickMs: number;
}

export const DEFAULT_LIMITS: Readonly<SessionLimits> = Object.freeze({
  connectTimeoutMs: 10_000,
  subscribeTimeoutMs: 10_000,
  maxSessionMs: 3_600_000,
  maxMessages: 100_000,
  maxBytes: 64 * 1024 * 1024,
  maxPacketBytes: DEFAULT_MAX_REPORT_BYTES,
  staleAfterMs: 60_000,
  keepAliveSeconds: 30,
  tickMs: 1_000,
});

const LIMIT_CEILINGS: Readonly<SessionLimits> = Object.freeze({
  connectTimeoutMs: 60_000,
  subscribeTimeoutMs: 60_000,
  maxSessionMs: 86_400_000,
  maxMessages: 10_000_000,
  maxBytes: 1024 * 1024 * 1024,
  maxPacketBytes: 1024 * 1024,
  staleAfterMs: 3_600_000,
  keepAliveSeconds: 600,
  tickMs: 60_000,
});

export function resolveLimits(partial: Partial<SessionLimits> = {}): SessionLimits {
  const resolved: SessionLimits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof SessionLimits)[]) {
    const value = partial[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1 || value > LIMIT_CEILINGS[key]) throw new ServiceError('INVALID_ARGUMENT', 'Invalid live session limit.');
    resolved[key] = value;
  }
  return resolved;
}

/** Why a received report was not turned into an observation. `retained-report` is never parsed. */
export type SessionIgnoreReason = IgnoreReason | 'retained-report';

export interface SessionStats {
  messagesReceived: number;
  bytesReceived: number;
  framesAccepted: number;
  ignored: Partial<Record<SessionIgnoreReason, number>>;
  /** Counts of frames actually written. The set of keys is closed: there is no publish entry. */
  outboundPackets: Record<OutboundType, number>;
  /** Attempts the outbound gate refused (always 0 unless a non-codec frame was submitted). */
  blockedOutbound: number;
}

export interface SessionReport {
  end: SessionEnd;
  stats: SessionStats;
}

export type LiveObservation =
  | { phase: 'unavailable'; reason: string; stage: LiveFailureStage | null }
  | {
    phase: 'observing';
    freshness: 'none' | 'fresh' | 'stale';
    ageMs: number | null;
    acceptedFrames: number;
    fields: LiveFields | null;
    warnings: string[];
  };

export interface LiveTarget {
  host: string;
  port: number;
  serverName: string;
  caPem: string;
}

export interface ChannelHandlers {
  secure(): void;
  data(chunk: Uint8Array): void;
  closed(): void;
  failed(kind: 'tls-verify' | 'connect' | 'peer-closed'): void;
}

/** The only handle on the network. Its sole writer accepts branded codec frames. */
export interface ByteChannel {
  write(packet: OutboundPacket): void;
  destroy(): void;
}

export type ChannelFactory = (target: LiveTarget, handlers: ChannelHandlers) => ByteChannel;

/**
 * Defense in depth behind the type-level brand: refuses any buffer that is not exactly one
 * CONNECT, SUBSCRIBE, PINGREQ or DISCONNECT frame by type, flags and length (in particular any
 * PUBLISH, and any permitted frame followed by extra bytes) before it can reach the channel. It
 * does not check minimal remaining-length encoding or every packet body; the type-level brand and
 * the encoders carry that. Returns whether the
 * frame was written.
 */
export function writeThroughGate(channel: ByteChannel, packet: OutboundPacket, stats: SessionStats): boolean {
  const type = classifyOutbound(packet);
  if (type === null) {
    stats.blockedOutbound += 1;
    return false;
  }
  channel.write(packet);
  stats.outboundPackets[type] += 1;
  return true;
}

export interface SessionOptions {
  config: LiveConfig;
  channelFactory: ChannelFactory;
  limits?: Partial<SessionLimits>;
  /** Wall-clock seam (default `Date.now`). */
  now?: () => number;
  /**
   * Monotonic-clock seam in ms. With the default wall clock it defaults to `performance.now`; with an
   * injected `now` it is absent (wall only) unless given, so injected-clock tests stay deterministic.
   */
  monotonicNow?: () => number;
  /** Repeating timer seam; returns a cancel function. */
  schedule?: (callback: () => void, intervalMs: number) => () => void;
}

export const LIVE_PRINTER_ID = 'live-x2d';

type Phase = 'idle' | 'connecting' | 'authenticating' | 'subscribing' | 'subscribed' | 'ended';
const GRACEFUL: ReadonlySet<SessionEnd> = new Set<SessionEnd>(['closed', 'limit']);

/**
 * Elapsed-time clock over two sources. Each reading advances by the LARGER non-negative delta of
 * the wall clock and the monotonic clock since the previous reading, so neither a wall-clock
 * rollback (monotonic still advances) nor a suspended monotonic clock (wall still advances, as
 * across a sleep) can make frames look younger or a deadline later than the more advanced source
 * says. A wall-clock forward step only makes data age sooner, the safe direction. The returned
 * value never decreases. With no monotonic source only the wall clock is used.
 */
export function createElapsedClock(wall: () => number, monotonic?: () => number): () => number {
  let wallLast = wall();
  let monotonicLast = monotonic === undefined ? 0 : monotonic();
  let value = wallLast;
  return () => {
    const wallNow = wall();
    let delta = wallNow - wallLast;
    wallLast = wallNow;
    if (monotonic !== undefined) {
      const monotonicNow = monotonic();
      delta = Math.max(delta, monotonicNow - monotonicLast);
      monotonicLast = monotonicNow;
    }
    value += Math.max(0, delta);
    return value;
  };
}

function defaultSchedule(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); };
}

/** The latest accepted frame with how old it is at the moment of the call (not at receipt). */
export interface AcceptedSnapshot {
  fields: LiveFields;
  warnings: string[];
  ageMs: number;
  freshness: 'fresh' | 'stale';
  staleAfterMs: number;
}

/** The surface the service, CLI and smoke launcher need from a live session. */
export type LiveSession = Pick<ObservationEngine, 'descriptor' | 'observation' | 'start' | 'close' | 'finished' | 'lastAccepted'>;

/**
 * Observation mechanics for one exact X2D, WITHOUT contract admission. Production code reaches it
 * only through `LanReadOnlySession` (src/lan-session.ts), which refuses construction while the
 * wire contract is unverified; nothing else under src/ imports this module (a test enforces
 * that). It is exported so the mechanics can be tested offline against injected fakes.
 *
 * One bounded, subscribe-only observation of one exact X2D. It never retries, reconnects,
 * discovers, publishes or exposes the network handle. Authentication, TLS verification,
 * subscription and protocol failures end the session at once with a fixed-text stage.
 */
export class ObservationEngine {
  readonly #target: LiveTarget;
  readonly #topic: string;
  readonly #factory: ChannelFactory;
  readonly #limits: SessionLimits;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, intervalMs: number) => () => void;
  readonly #decoder: MqttDecoder;
  readonly #stats: SessionStats = {
    messagesReceived: 0,
    bytesReceived: 0,
    framesAccepted: 0,
    ignored: {},
    outboundPackets: { connect: 0, subscribe: 0, pingreq: 0, disconnect: 0 },
    blockedOutbound: 0,
  };
  readonly #started: Promise<void>;
  readonly #finished: Promise<SessionReport>;
  #resolveStarted!: () => void;
  #rejectStarted!: (error: LiveSessionError) => void;
  #resolveFinished!: (report: SessionReport) => void;
  #secret: string | null;
  #phase: Phase = 'idle';
  #channel: ByteChannel | null = null;
  #connected = false;
  #end: SessionEnd | null = null;
  #deadline: number | null = null;
  #startedAt = 0;
  #lastInbound = 0;
  #lastPing = 0;
  #cancelTimer: (() => void) | null = null;
  #abortCleanup: (() => void) | null = null;
  #latest: { fields: LiveFields; warnings: string[]; receivedAt: number } | null = null;

  constructor(options: SessionOptions) {
    const { config } = options;
    if (!isPrivateIPv4Literal(config.host) || !isX2dSerial(config.serial)
      || typeof config.accessCode !== 'string' || config.accessCode.length === 0 || typeof config.caPem !== 'string') {
      throw new ServiceError('LIVE_CONFIG_INVALID', 'Invalid live session configuration.');
    }
    this.#limits = resolveLimits(options.limits);
    this.#target = { host: config.host, port: LAN_PORT, serverName: config.serial, caPem: config.caPem };
    this.#topic = reportTopic(config.serial);
    this.#secret = config.accessCode;
    this.#factory = options.channelFactory;
    this.#now = createElapsedClock(
      options.now ?? Date.now,
      options.monotonicNow ?? (options.now === undefined ? () => performance.now() : undefined),
    );
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#decoder = new MqttDecoder(this.#limits.maxPacketBytes);
    this.#started = new Promise<void>((resolve, reject) => { this.#resolveStarted = resolve; this.#rejectStarted = reject; });
    this.#started.catch(() => undefined);
    this.#finished = new Promise<SessionReport>((resolve) => { this.#resolveFinished = resolve; });
  }

  descriptor(): PrinterDescriptor {
    return { id: LIVE_PRINTER_ID, family: 'X2D', firmware: 'unverified', transport: 'lan-readonly', hardwareValidated: false };
  }

  /** Resolves after the broker confirms the subscription; rejects with a fixed-text stage. */
  get started(): Promise<void> { return this.#started; }

  /** Always resolves, once, when the session ends for any reason. */
  get finished(): Promise<SessionReport> { return this.#finished; }

  start(signal?: AbortSignal): Promise<void> {
    if (this.#phase !== 'idle') return this.#started;
    this.#phase = 'connecting';
    this.#startedAt = this.#now();
    this.#lastInbound = this.#startedAt;
    this.#deadline = this.#startedAt + this.#limits.connectTimeoutMs;
    if (signal !== undefined) {
      if (signal.aborted) {
        this.#finish('cancelled');
        return this.#started;
      }
      const onAbort = (): void => { this.#finish('cancelled'); };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#abortCleanup = () => { signal.removeEventListener('abort', onAbort); };
    }
    this.#cancelTimer = this.#schedule(() => { this.#tick(); }, this.#limits.tickMs);
    try {
      this.#channel = this.#factory(this.#target, {
        secure: () => { this.#onSecure(); },
        data: (chunk) => { this.#onData(chunk); },
        closed: () => { this.#finish('peer-closed'); },
        failed: (kind) => { this.#finish(kind); },
      });
      // The factory may have signalled (and ended the session) before it returned its handle.
      if (this.#hasEnded()) this.#channel.destroy();
    } catch {
      this.#finish('connect');
    }
    return this.#started;
  }

  /** Graceful local close; sends DISCONNECT only if the broker had accepted the connection. */
  close(): Promise<SessionReport> {
    this.#finish('closed');
    return this.#finished;
  }

  report(): SessionReport {
    return { end: this.#end ?? 'closed', stats: structuredClone(this.#stats) };
  }

  observation(): LiveObservation {
    if (this.#phase === 'ended') {
      if (this.#end === 'closed') return { phase: 'unavailable', reason: 'Live X2D read-only session was closed.', stage: null };
      if (this.#end === 'limit') {
        return { phase: 'unavailable', reason: 'Live X2D read-only session reached its resource limit; restart the operator-enabled session to observe again.', stage: null };
      }
      const stage = this.#end as LiveFailureStage;
      return { phase: 'unavailable', reason: STAGE_TEXT[stage], stage };
    }
    if (this.#phase !== 'subscribed') {
      return { phase: 'unavailable', reason: 'Live X2D read-only session is not subscribed yet.', stage: null };
    }
    if (this.#latest === null) {
      return { phase: 'observing', freshness: 'none', ageMs: null, acceptedFrames: 0, fields: null, warnings: [] };
    }
    const ageMs = Math.max(0, this.#now() - this.#latest.receivedAt);
    return {
      phase: 'observing',
      freshness: ageMs > this.#limits.staleAfterMs ? 'stale' : 'fresh',
      ageMs,
      acceptedFrames: this.#stats.framesAccepted,
      fields: { ...this.#latest.fields },
      warnings: [...this.#latest.warnings],
    };
  }

  /** Normalized whitelist fields of the most recent accepted frame, retained after the session ends. */
  lastAccepted(): AcceptedSnapshot | null {
    if (this.#latest === null) return null;
    const ageMs = Math.max(0, this.#now() - this.#latest.receivedAt);
    return {
      fields: { ...this.#latest.fields },
      warnings: [...this.#latest.warnings],
      ageMs,
      freshness: ageMs > this.#limits.staleAfterMs ? 'stale' : 'fresh',
      staleAfterMs: this.#limits.staleAfterMs,
    };
  }

  #write(packet: OutboundPacket): void {
    let written = false;
    try {
      written = this.#channel !== null && writeThroughGate(this.#channel, packet, this.#stats);
    } catch {
      // A failing socket write must end the session; it must never escape into an event listener.
      this.#finish('peer-closed');
      return;
    }
    if (!written) this.#finish('protocol');
  }

  #onSecure(): void {
    if (this.#phase !== 'connecting') return;
    this.#phase = 'authenticating';
    const password = Buffer.from(this.#secret ?? '', 'utf8');
    this.#secret = null;
    try {
      const packet = encodeConnect({
        clientId: `bambu-mcp-ro-${randomBytes(6).toString('hex')}`,
        username: MQTT_USERNAME,
        password,
        keepAliveSeconds: this.#limits.keepAliveSeconds,
      });
      this.#write(packet);
    } finally {
      password.fill(0);
    }
  }

  #onData(chunk: Uint8Array): void {
    if (this.#phase === 'ended') return;
    this.#stats.bytesReceived += chunk.length;
    if (this.#stats.bytesReceived > this.#limits.maxBytes) {
      this.#finish('limit');
      return;
    }
    this.#lastInbound = this.#now();
    let packets: MqttPacket[];
    try {
      packets = this.#decoder.push(chunk);
    } catch {
      this.#finish('protocol');
      return;
    }
    for (const packet of packets) {
      if (this.#hasEnded()) return;
      this.#onPacket(packet);
    }
  }

  /** A method call defeats TypeScript's stale narrowing of `#phase` across re-entrant finishes. */
  #hasEnded(): boolean {
    return this.#phase === 'ended';
  }

  #onPacket(packet: MqttPacket): void {
    switch (packet.type) {
      case 'connack':
        if (this.#phase !== 'authenticating') return this.#finish('protocol');
        if (packet.returnCode === 4 || packet.returnCode === 5) return this.#finish('authentication');
        if (packet.returnCode !== 0) return this.#finish('connect-refused');
        this.#connected = true;
        this.#phase = 'subscribing';
        this.#deadline = this.#now() + this.#limits.subscribeTimeoutMs;
        return this.#write(encodeSubscribe(1, this.#topic));
      case 'suback':
        if (this.#phase !== 'subscribing' || packet.packetId !== 1) return this.#finish('protocol');
        if (packet.returnCode === 0x80) return this.#finish('subscription');
        // A grant above the requested QoS 0 would require acknowledgements this client never sends.
        if (packet.returnCode !== 0) return this.#finish('protocol');
        this.#phase = 'subscribed';
        this.#deadline = null;
        this.#lastPing = this.#now();
        return this.#resolveStarted();
      case 'pingresp':
        if (this.#phase !== 'subscribed') this.#finish('protocol');
        return;
      case 'publish': {
        if (this.#phase !== 'subscribed' || packet.topic !== this.#topic) return this.#finish('protocol');
        this.#stats.messagesReceived += 1;
        // A retained report is a broker-stored snapshot of unknown age. Receipt time says nothing about
        // when the printer produced it, so it is counted, never parsed and never becomes an observation.
        const outcome = packet.retain ? null : parseReportPayload(packet.payload, this.#limits.maxPacketBytes);
        if (outcome === null) {
          this.#stats.ignored['retained-report'] = (this.#stats.ignored['retained-report'] ?? 0) + 1;
        } else if (outcome.kind === 'status') {
          this.#stats.framesAccepted += 1;
          this.#latest = { fields: outcome.fields, warnings: outcome.warnings, receivedAt: this.#now() };
        } else {
          this.#stats.ignored[outcome.reason] = (this.#stats.ignored[outcome.reason] ?? 0) + 1;
        }
        if (this.#stats.messagesReceived >= this.#limits.maxMessages) this.#finish('limit');
        return;
      }
    }
  }

  #tick(): void {
    if (this.#phase === 'ended') return;
    const now = this.#now();
    if (this.#deadline !== null && now >= this.#deadline) return this.#finish('timeout');
    if (now - this.#startedAt >= this.#limits.maxSessionMs) return this.#finish('limit');
    if (this.#phase !== 'subscribed') return;
    const keepAliveMs = this.#limits.keepAliveSeconds * 1_000;
    if (now - this.#lastInbound >= keepAliveMs * 1.5) return this.#finish('timeout');
    if (now - this.#lastPing >= keepAliveMs / 2) {
      this.#lastPing = now;
      this.#write(encodePingReq());
    }
  }

  #finish(end: SessionEnd): void {
    if (this.#phase === 'ended') return;
    this.#phase = 'ended';
    this.#end = end;
    this.#secret = null;
    this.#cancelTimer?.();
    this.#abortCleanup?.();
    const channel = this.#channel;
    if (channel !== null) {
      if (this.#connected && (GRACEFUL.has(end) || end === 'cancelled')) {
        try { writeThroughGate(channel, encodeDisconnect(), this.#stats); } catch { /* best effort */ }
      }
      try { channel.destroy(); } catch { /* best effort */ }
    }
    // No-op if the subscription was already confirmed; otherwise a graceful end before that is a cancellation.
    this.#rejectStarted(new LiveSessionError(GRACEFUL.has(end) ? 'cancelled' : end as LiveFailureStage));
    this.#resolveFinished({ end, stats: structuredClone(this.#stats) });
  }
}
