import { ServiceError } from './domain.js';

/**
 * Evidence ledger for the optional X2D LAN read-only observation path.
 *
 * Labels are deliberately coarse and honest:
 * - `official-documentation`: stated on an official Bambu Lab page or model definition.
 * - `first-party-source`: present in the public bambulab/BambuStudio source (the networking
 *   plugin itself is closed, so this is Studio-side evidence, not an X2D firmware guarantee).
 * - `implementation-choice`: chosen by this project; NOT vendor-verified.
 * - `unverified`: no first-party evidence was found.
 */
export type EvidenceLabel = 'official-documentation' | 'first-party-source' | 'implementation-choice' | 'unverified';

export interface ContractItem {
  readonly id: string;
  readonly value: string;
  readonly evidence: EvidenceLabel;
  readonly source: string;
}

function deepFreeze(items: ContractItem[]): readonly ContractItem[] {
  for (const item of items) Object.freeze(item);
  return Object.freeze(items);
}

export const LAN_PORT = 8883;
export const MQTT_USERNAME = 'bblp';
export const X2D_SERIAL_PREFIX = '20P';

export const LAN_CONTRACT: readonly ContractItem[] = deepFreeze([
  { id: 'lan-mqtt-port', value: '8883/tcp, TLS', evidence: 'official-documentation', source: 'wiki.bambulab.com printer-network-ports; N6.json support_ssl_for_mqtt' },
  { id: 'x2d-model-identity', value: 'N6, serial prefix 20P', evidence: 'official-documentation', source: 'BambuStudio resources/printers/N6.json' },
  { id: 'mqtt-username', value: MQTT_USERNAME, evidence: 'first-party-source', source: 'BambuStudio DeviceManager.cpp MachineObject::connect' },
  { id: 'mqtt-password', value: 'printer access code', evidence: 'first-party-source', source: 'BambuStudio DeviceManager.cpp MachineObject::connect; wiki.bambulab.com bbl-security' },
  { id: 'status-envelope', value: 'JSON {"print":{"command":"push_status","msg":0|1|absent}}; msg 1 is a diff', evidence: 'first-party-source', source: 'BambuStudio DeviceManager.cpp MachineObject::parse_json' },
  { id: 'status-fields', value: 'gcode_state, mc_percent, mc_remaining_time (minutes), bed_temper, device.bed_temp (packed)', evidence: 'first-party-source', source: 'BambuStudio DeviceManager.cpp, DeviceCore/DevBed.cpp' },
  { id: 'report-topic', value: 'device/<serial>/report', evidence: 'implementation-choice', source: 'no vendor-authored definition found' },
  { id: 'mqtt-protocol-version', value: '3.1.1', evidence: 'implementation-choice', source: 'no vendor-authored definition found' },
  { id: 'subscription-qos', value: '0', evidence: 'implementation-choice', source: 'no vendor-authored definition found' },
  { id: 'x2d-firmware-and-schema', value: 'unknown', evidence: 'unverified', source: 'installed firmware and emitted schema never observed' },
  { id: 'extruder-id-mapping', value: 'unknown; nozzle temperatures stay null', evidence: 'unverified', source: 'logical/physical extruder mapping not established for this printer' },
]);

/**
 * Items that must carry vendor-verified evidence before any live session may exist. Each must
 * appear in the ledger above. The installed-firmware item can only ever be established from the
 * device itself, so it cannot be cleared by code alone.
 */
export const UNRESOLVED_CONTRACT_ITEMS: readonly string[] = Object.freeze([
  'report-topic',
  'mqtt-protocol-version',
  'subscription-qos',
  'x2d-firmware-and-schema',
]);

export function reportTopic(serial: string): string {
  return `device/${serial}/report`;
}

export type Admission = { admitted: true } | { admitted: false; reason: string };

const VERIFIED_LABELS: ReadonlySet<EvidenceLabel> = new Set<EvidenceLabel>(['official-documentation', 'first-party-source']);

/**
 * Pure admission rule: every required item must be present in the ledger with vendor-verified
 * evidence. There is deliberately no acknowledgement, flag, environment variable or option that
 * can substitute for evidence: a guess, an operator's say-so or a successful TLS handshake is
 * never `official-documentation` or `first-party-source`. Exported so the rule itself can be
 * tested against synthetic ledgers; production uses only `requireAdmission`, which evaluates the
 * module's own frozen ledger.
 */
export function evaluateAdmission(ledger: readonly ContractItem[]): Admission {
  const blocking = UNRESOLVED_CONTRACT_ITEMS.map((id) => ({ id, item: ledger.find((candidate) => candidate.id === id) }))
    .filter(({ item }) => item === undefined || !VERIFIED_LABELS.has(item.evidence));
  if (blocking.length === 0) return { admitted: true };
  const listed = blocking.map(({ id, item }) => `${id} [${item?.evidence ?? 'missing'}]`).join(', ');
  return {
    admitted: false,
    reason: `Live X2D read-only path is not admitted: required contract items are not vendor-verified (${listed}). `
      + 'There is no operator override; admission opens only when first-party evidence is recorded in src/lan-contract.ts and reviewed. See docs/hardware-validation.md.',
  };
}

/** Admission for the real ledger. Evaluated by `LanReadOnlySession`, the only public session type. */
export function admitContract(): Admission {
  return evaluateAdmission(LAN_CONTRACT);
}

export function requireAdmission(): void {
  const admission = admitContract();
  if (!admission.admitted) throw new ServiceError('CONTRACT_UNVERIFIED', admission.reason);
}
