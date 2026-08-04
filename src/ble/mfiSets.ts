/**
 * MFi device filtering + binaural set grouping (TASK14, reworked TASK16).
 *
 * Two concerns, both brand-agnostic and MFi-adapter-scoped:
 *
 * 1. MFi-only fast list (TASK16). A scanned device appears in the list
 *    IMMEDIATELY when:
 *      (a) its advertised service UUIDs include the LEA service UUID, OR
 *      (b) its device id is in the persisted verified-MFi set (AsyncStorage
 *          `@mfi_verified`), populated after any successful LEA-service
 *          confirmation during an actual connect flow (DeviceScreen).
 *    Unknown candidates are NEVER connected-to during scanning — they simply
 *    do not appear. There is no standalone verification probe.
 *
 * 2. Binaural set grouping. Verified MFi devices are grouped into sets by:
 *      - normalized device name with L/R side markers stripped
 *        ("Steve's Aids L" + "Steve's Aids R" → one set "Steve's Aids L+R")
 *      - RSSI proximity (paired aids sit next to each other on the same head)
 *      - MAC OUI prefix match as a weak corroborator
 *    No brand-specific logic: side detection is name-based; an opportunistic
 *    read of the HAP side characteristic happens later at connect time in
 *    DeviceScreen (not here). The same heuristics back the lazy sibling
 *    window (findSetSibling) used when a single device is tapped.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DiscoveredDevice } from './types';

/** Standardized MFi / LEA hearing-aid control service (MFI_SPEC.md §1.1) */
export const LEA_SERVICE_UUID = '7d74f4bd-c74a-4431-862c-cce884371592';

/** AsyncStorage key for the persisted set of LEA-verified device ids. */
const VERIFIED_STORAGE_KEY = '@mfi_verified';

// ── Fast-list criteria ──

export function advertisesLeaService(serviceUUIDs: readonly string[]): boolean {
  const target = LEA_SERVICE_UUID.replace(/-/g, '');
  return serviceUUIDs.some((u) => u.toLowerCase().replace(/-/g, '') === target);
}

// ── Persisted verified-MFi set ──

/** Session cache of verified ids, hydrated from AsyncStorage. */
const verifiedIds = new Set<string>();
let verifiedLoaded = false;

/**
 * Load the persisted verified-MFi set into the session cache.
 * Safe to call repeatedly; only reads storage once.
 */
export async function initVerifiedMfiSet(): Promise<void> {
  if (verifiedLoaded) return;
  verifiedLoaded = true;
  try {
    const raw = await AsyncStorage.getItem(VERIFIED_STORAGE_KEY);
    if (raw) {
      const ids = JSON.parse(raw) as string[];
      for (const id of ids) verifiedIds.add(id.toUpperCase());
    }
  } catch {
    // Corrupt/missing storage — start empty
  }
}

/** True if this device id was previously confirmed to expose the LEA service. */
export function isVerifiedMfi(deviceId: string): boolean {
  return verifiedIds.has(deviceId.toUpperCase());
}

/**
 * Record a successful LEA-service confirmation (piggybacked on a real connect
 * flow). Updates the session cache and persists to AsyncStorage.
 */
export function markVerifiedMfi(deviceId: string): void {
  const id = deviceId.toUpperCase();
  if (verifiedIds.has(id)) return;
  verifiedIds.add(id);
  void AsyncStorage.setItem(
    VERIFIED_STORAGE_KEY,
    JSON.stringify(Array.from(verifiedIds)),
  ).catch(() => {
    // persistence failure is non-fatal — session cache still holds it
  });
}

// ── Binaural set grouping ──

export type EarSide = 'left' | 'right';

interface NameParts {
  base: string;
  side: EarSide | null;
}

/**
 * Strip a trailing L/R side marker from a device name.
 * Handles: "X L", "X R", "X-L", "X_R", "X (L)", "X Left", "X LE", "X RE",
 * and a bare trailing "L"/"R" after whitespace/punctuation.
 * Brand-agnostic: purely lexical.
 */
export function splitNameAndSide(name: string): NameParts {
  const trimmed = name.trim();
  const patterns: Array<[RegExp, EarSide]> = [
    [/[\s_\-\(]+(left|l|le)\)?$/i, 'left'],
    [/[\s_\-\(]+(right|r|re)\)?$/i, 'right'],
  ];
  for (const [re, side] of patterns) {
    const m = trimmed.match(re);
    if (m && trimmed.length > m[0].length) {
      return { base: trimmed.slice(0, trimmed.length - m[0].length).trim(), side };
    }
  }
  return { base: trimmed, side: null };
}

function macOui(id: string): string {
  return id.replace(/[:-]/g, '').toUpperCase().slice(0, 6);
}

/** Paired aids are worn on the same head — RSSI should be close. */
const MAX_SET_RSSI_DELTA = 15;

/**
 * Group verified MFi devices into binaural set entries.
 * Devices with no pairing partner pass through unchanged (single-sided use).
 * Input should contain ONLY MFi devices (post-filter).
 */
export function buildMfiSetEntries(devices: DiscoveredDevice[]): DiscoveredDevice[] {
  const groups = new Map<string, DiscoveredDevice[]>();

  for (const d of devices) {
    const name = d.name ?? '';
    const { base } = splitNameAndSide(name);
    // Devices with no usable name can't be grouped safely — keep singletons
    const key = base.length >= 2 ? base.toLowerCase() : `\0single:${d.id}`;
    const arr = groups.get(key) ?? [];
    arr.push(d);
    groups.set(key, arr);
  }

  const out: DiscoveredDevice[] = [];

  for (const members of groups.values()) {
    if (members.length === 1) {
      out.push(members[0]);
      continue;
    }

    // Pair up members: prefer explicit L+R side match, then closest RSSI
    // with a matching MAC OUI prefix as corroboration.
    const remaining = [...members];
    while (remaining.length >= 2) {
      let bestI = 0;
      let bestJ = 1;
      let bestScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        for (let j = i + 1; j < remaining.length; j++) {
          const a = remaining[i];
          const b = remaining[j];
          const sideA = splitNameAndSide(a.name ?? '').side;
          const sideB = splitNameAndSide(b.name ?? '').side;

          // Same explicit side → not a pair
          if (sideA && sideB && sideA === sideB) continue;

          let score = 0;
          if (sideA && sideB && sideA !== sideB) score += 100; // explicit L+R
          if (a.rssi != null && b.rssi != null) {
            const delta = Math.abs(a.rssi - b.rssi);
            if (delta > MAX_SET_RSSI_DELTA && score === 0) continue;
            score += MAX_SET_RSSI_DELTA - delta;
          }
          if (macOui(a.id) === macOui(b.id)) score += 5;

          if (score > bestScore) {
            bestScore = score;
            bestI = i;
            bestJ = j;
          }
        }
      }

      if (bestScore < 0) {
        // No pairable combination — emit leftovers as singletons
        out.push(...remaining);
        break;
      }

      const a = remaining[bestI];
      const b = remaining[bestJ];
      remaining.splice(bestJ, 1);
      remaining.splice(bestI, 1);
      out.push(makeSetEntry(a, b));
    }
    if (remaining.length === 1) out.push(remaining[0]);
  }

  return out;
}

/**
 * Merge two members into one set list entry.
 * Primary (entry id, write target): the RIGHT member when sides are known,
 * otherwise the stronger-RSSI member.
 */
function makeSetEntry(a: DiscoveredDevice, b: DiscoveredDevice): DiscoveredDevice {
  const partsA = splitNameAndSide(a.name ?? '');
  const partsB = splitNameAndSide(b.name ?? '');

  const memberSides: { [id: string]: EarSide } = {};
  if (partsA.side) memberSides[a.id] = partsA.side;
  if (partsB.side) memberSides[b.id] = partsB.side;

  const sideOf = (d: DiscoveredDevice) => memberSides[d.id];
  let primary: DiscoveredDevice;
  if (sideOf(a) === 'right' || sideOf(b) === 'left') {
    primary = a;
  } else if (sideOf(b) === 'right' || sideOf(a) === 'left') {
    primary = b;
  } else {
    primary = (b.rssi ?? -999) > (a.rssi ?? -999) ? b : a;
  }
  const secondary = primary === a ? b : a;

  const base = splitNameAndSide(primary.name ?? '').base || 'MFi hearing aid';

  return {
    id: primary.id,
    name: `${base} L+R`,
    rssi:
      primary.rssi != null && secondary.rssi != null
        ? Math.max(primary.rssi, secondary.rssi)
        : (primary.rssi ?? secondary.rssi),
    brand: 'mfi',
    serviceUUIDs: primary.serviceUUIDs,
    bonded: primary.bonded || secondary.bonded,
    setMemberIds: [primary.id, secondary.id],
    memberSides,
    memberNames: {
      [a.id]: a.name,
      [b.id]: b.name,
    },
  };
}

/**
 * Lazy sibling window (TASK16): given a tapped single device and raw scan
 * results collected during the post-tap window, find its binaural sibling
 * using the same grouping heuristics as buildMfiSetEntries.
 * Returns a merged set entry (ready for the dual connect flow) or null.
 */
export function findSetSibling(
  device: DiscoveredDevice,
  candidates: DiscoveredDevice[],
): DiscoveredDevice | null {
  const pool = candidates.filter((c) => c.id !== device.id);
  if (pool.length === 0) return null;
  const set = buildMfiSetEntries([device, ...pool]).find(
    (e) => e.setMemberIds?.length === 2 && e.setMemberIds.includes(device.id),
  );
  return set ?? null;
}
