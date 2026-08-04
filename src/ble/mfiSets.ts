/**
 * MFi device filtering + binaural set grouping (TASK14).
 *
 * Two concerns, both brand-agnostic and MFi-adapter-scoped:
 *
 * 1. MFi-only device filter. MFI_SPEC.md §4.4: whether the 128-bit LEA
 *    service UUID appears in the adv packet or scan response is UNCONFIRMED,
 *    so a single-stage adv filter is not reliable. Two-stage approach:
 *      Stage 1 — devices that DO advertise the LEA UUID pass immediately.
 *      Stage 2 — candidates that don't are verified in the background:
 *                brief connect + service discovery; devices without the LEA
 *                service are rejected and hidden from the list. Verdicts are
 *                cached for the app session so re-scans don't re-verify.
 *
 * 2. Binaural set grouping. Verified MFi devices are grouped into sets by:
 *      - normalized device name with L/R side markers stripped
 *        ("Steve's Aids L" + "Steve's Aids R" → one set "Steve's Aids L+R")
 *      - RSSI proximity (paired aids sit next to each other on the same head)
 *      - MAC OUI prefix match as a weak corroborator
 *    No brand-specific logic: side detection is name-based; an opportunistic
 *    read of the HAP side characteristic happens later at connect time in
 *    DeviceScreen (not here).
 */
import { getBleManager } from './BleManager';
import type { DiscoveredDevice } from './types';

/** Standardized MFi / LEA hearing-aid control service (MFI_SPEC.md §1.1) */
export const LEA_SERVICE_UUID = '7d74f4bd-c74a-4431-862c-cce884371592';

const DIS_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
const DIS_MANUFACTURER_NAME = '00002a29-0000-1000-8000-00805f9b34fb';

const CONNECT_TIMEOUT_MS = 6000;
const DISCOVERY_TIMEOUT_MS = 8000;

/** Candidates weaker than this are not worth a verification connection. */
const MIN_VERIFY_RSSI = -85;

/** Max background verifications per scan session (bounded BLE churn). */
export const MAX_VERIFICATIONS_PER_SCAN = 10;

// ── Stage 1: advertised LEA check ──

export function advertisesLeaService(serviceUUIDs: readonly string[]): boolean {
  const target = LEA_SERVICE_UUID.replace(/-/g, '');
  return serviceUUIDs.some((u) => u.toLowerCase().replace(/-/g, '') === target);
}

// ── Stage 2: connect + verify ──

type Verdict = 'verified' | 'rejected';
const verdictCache = new Map<string, Verdict>();

export function getCachedVerdict(deviceId: string): Verdict | undefined {
  return verdictCache.get(deviceId.toUpperCase());
}

export interface MfiVerification {
  ok: boolean;
  manufacturer: string | null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToUtf8(base64: string): string {
  const clean = base64.replace(/=+$/, '');
  let bits = 0;
  let collected = 0;
  let out = '';
  for (const ch of clean) {
    const val = B64.indexOf(ch);
    if (val < 0) continue;
    bits = (bits << 6) | val;
    collected += 6;
    if (collected >= 8) {
      collected -= 8;
      const b = (bits >> collected) & 0xff;
      if (b === 0) break;
      out += String.fromCharCode(b);
    }
  }
  try {
    return decodeURIComponent(escape(out)).trim();
  } catch {
    return out.trim();
  }
}

/**
 * Stage-2 verification: briefly connect and check for the LEA service.
 * Safe on already-connected devices (never tears down an active connection).
 * Result is cached for the app session.
 */
export async function verifyMfiDevice(deviceId: string): Promise<MfiVerification> {
  const id = deviceId.toUpperCase();
  const cached = verdictCache.get(id);
  if (cached) return { ok: cached === 'verified', manufacturer: null };

  const manager = getBleManager();
  let ok = false;
  let manufacturer: string | null = null;
  let wasConnected = false;

  try {
    wasConnected = await manager.isDeviceConnected(id).catch(() => false);
    const device = await withTimeout(
      manager.connectToDevice(id),
      CONNECT_TIMEOUT_MS,
      'verify connect',
    );
    await withTimeout(
      device.discoverAllServicesAndCharacteristics(),
      DISCOVERY_TIMEOUT_MS,
      'verify discovery',
    );
    const services = await device.services();
    ok = services.some((s) => s.uuid.toLowerCase() === LEA_SERVICE_UUID);

    if (ok) {
      try {
        const char = await device.readCharacteristicForService(
          DIS_SERVICE,
          DIS_MANUFACTURER_NAME,
        );
        if (char.value) manufacturer = base64ToUtf8(char.value) || null;
      } catch {
        // DIS is optional
      }
    }
  } catch {
    ok = false;
  } finally {
    if (!wasConnected) {
      try {
        await manager.cancelDeviceConnection(id);
      } catch {
        // already gone
      }
    }
  }

  verdictCache.set(id, ok ? 'verified' : 'rejected');
  return { ok, manufacturer };
}

/** True if a scanned device is worth a stage-2 verification attempt. */
export function isVerificationCandidate(device: DiscoveredDevice): boolean {
  if (getCachedVerdict(device.id)) return false;
  if (device.serviceUUIDs.length > 0 && advertisesLeaService(device.serviceUUIDs)) {
    return false; // already passes stage 1
  }
  if (device.rssi != null && device.rssi < MIN_VERIFY_RSSI) return false;
  return true;
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
