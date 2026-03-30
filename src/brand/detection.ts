/**
 * Brand detection logic — UUID-based only.
 * Name-based detection is intentionally excluded: users customize their
 * hearing aid device names (e.g. "Steve's Hearing Aids") making names
 * unreliable for brand identification. Brand is determined by connecting
 * and discovering GATT services/characteristics instead.
 * See SPEC.md §2 and §3.3 for protocol details.
 */
import type { Brand } from '../ble/types';

/** FEFE service — primary GN proprietary service on ReSound Smart 3D 1.3.0+ */
const RESOUND_FEFE_SERVICE = '0000fefe-0000-1000-8000-00805f9b34fb';

/** GN characteristics that confirm ReSound identity (when under FEFE service) */
const RESOUND_GN_COMMAND = '1959a468-3234-4c18-9e78-8daf8d9dbf61';
const RESOUND_GN_NOTIFY = '8b51a2ca-5bed-418b-b54b-22fe666aadd2';
const RESOUND_GN_MIC_ATTENUATION = '32c9322d-6b17-11cf-0234-6f0da5eafd75';
const RESOUND_GN_ACTIVE_PROGRAM = 'dc82f820-63ac-f82f-1e89-372fde4151f4';

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
 * Detect brand from GATT service and characteristic UUIDs only.
 * For reliable detection, call after `discoverAllServicesAndCharacteristics()`.
 * No name-based fallback — device names are user-customizable and unreliable.
 */
export function detectBrandFromDiscovery(
  serviceUuids: readonly string[],
  characteristicUuids: readonly string[],
): Brand {
  const services = serviceUuids.map((u) => u.toLowerCase());
  const characteristics = characteristicUuids.map((u) => u.toLowerCase());
  const normServices = services.map((s) => s.replace(/-/g, ''));
  const normChars = characteristics.map((c) => c.replace(/-/g, ''));

  // 1. Starkey — unique service UUID
  if (hasService(normServices, '9a04f079-9840-4286-ab92-e65be0885f95')) {
    return 'starkey';
  }

  // 2. ReSound — e0262760 prefix family (newer stacks)
  if (hasPrefix(normServices, 'e0262760')) {
    return 'resound';
  }

  // 3. ReSound — FEFE service + any GN characteristic (tightened to avoid false positives)
  if (hasService(normServices, RESOUND_FEFE_SERVICE)) {
    if (
      hasCharacteristic(normChars, RESOUND_GN_COMMAND) ||
      hasCharacteristic(normChars, RESOUND_GN_NOTIFY) ||
      hasCharacteristic(normChars, RESOUND_GN_MIC_ATTENUATION) ||
      hasCharacteristic(normChars, RESOUND_GN_ACTIVE_PROGRAM)
    ) {
      return 'resound';
    }
  }

  // 4. Philips / Rexton — shared POLARIS service, differentiated by Terminal IO
  if (hasService(normServices, '56772eaf-2153-4f74-acf3-4368d99fbf5a')) {
    if (normServices.some((s) => s.startsWith('8b82'))) {
      return 'rexton';
    }
    return 'philips';
  }

  return 'unknown';
}
