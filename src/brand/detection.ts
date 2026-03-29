/**
 * Brand detection logic — ported from web app.
 * Same UUID-based detection, same priority order.
 * See SPEC.md §2 and §3.3 for protocol details.
 */
import type { Brand } from '../ble/types';

/** GN command / notify — present on ReSound when those services are authorized. */
const RESOUND_GN_COMMAND = '1959a468-3234-4c18-9e78-8daf8d9dbf61';
const RESOUND_GN_NOTIFY = '8b51a2ca-5bed-418b-b54b-22fe666aadd2';

const ASHA_SERVICE = '0000fdf0-0000-1000-8000-00805f9b34fb';
const DIS_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
const GAP_SERVICE = '00001800-0000-1000-8000-00805f9b34fb';

export interface DetectBrandOptions {
  /** BLE advertised device name */
  readonly deviceName?: string;
}

function normalizeUuid(uuid: string): string {
  return uuid.toLowerCase().replace(/-/g, '');
}

function hasService(normServicesNoDash: readonly string[], fullUuid: string): boolean {
  const target = normalizeUuid(fullUuid);
  return normServicesNoDash.some((s) => normalizeUuid(s) === target);
}

function hasPrefix(normServicesNoDash: readonly string[], prefix8: string): boolean {
  const p = prefix8.toLowerCase();
  return normServicesNoDash.some((s) => s.startsWith(p));
}

function hasCharacteristic(normCharsNoDash: readonly string[], fullUuid: string): boolean {
  const target = normalizeUuid(fullUuid);
  return normCharsNoDash.some((c) => normalizeUuid(c) === target);
}

/**
 * Detect brand from GATT discovery. Pass `deviceName` when fingerprints are incomplete.
 */
export function detectBrandFromDiscovery(
  serviceUuids: readonly string[],
  characteristicUuids: readonly string[],
  options: DetectBrandOptions = {},
): Brand {
  const services = serviceUuids.map((u) => u.toLowerCase());
  const characteristics = characteristicUuids.map((u) => u.toLowerCase());
  const normServices = services.map((s) => s.replace(/-/g, ''));
  const normChars = characteristics.map((c) => c.replace(/-/g, ''));

  // 1. Starkey — unique service UUID
  if (hasService(normServices, '9a04f079-9840-4286-ab92-e65be0885f95')) {
    return 'starkey';
  }

  // 2. ReSound — e0262760 prefix family
  if (hasPrefix(normServices, 'e0262760')) {
    return 'resound';
  }

  // 3. ReSound — GN command/notify characteristics
  if (
    hasCharacteristic(normChars, RESOUND_GN_COMMAND) ||
    hasCharacteristic(normChars, RESOUND_GN_NOTIFY)
  ) {
    return 'resound';
  }

  // 4. Philips / Rexton — shared POLARIS service, differentiated by Terminal IO
  if (hasService(normServices, '56772eaf-2153-4f74-acf3-4368d99fbf5a')) {
    if (normServices.some((s) => s.startsWith('8b82'))) {
      return 'rexton';
    }
    return 'philips';
  }

  // 5. Name-based fallback for ReSound devices with generic services
  const hasBasicHaContext =
    hasService(normServices, DIS_SERVICE) ||
    hasService(normServices, ASHA_SERVICE) ||
    hasService(normServices, GAP_SERVICE);

  if (options.deviceName && hasBasicHaContext) {
    const n = options.deviceName.toLowerCase();
    if (n.includes('resound')) {
      return 'resound';
    }
    if (
      /\bhearing aids?\b/i.test(options.deviceName) &&
      !hasService(normServices, '9a04f079-9840-4286-ab92-e65be0885f95') &&
      !hasService(normServices, '56772eaf-2153-4f74-acf3-4368d99fbf5a')
    ) {
      return 'resound';
    }
  }

  return 'unknown';
}

/** @deprecated Prefer detectBrandFromDiscovery with characteristics after GATT discovery. */
export function detectBrandFromServices(serviceUuids: readonly string[]): Brand {
  return detectBrandFromDiscovery(serviceUuids, [], {});
}
