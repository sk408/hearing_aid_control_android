import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * GN bond state machine types + persistence helpers.
 *
 * Source: HandleBasedPlatform.cs bond flow methods from Smart 3D 1.3.0.
 * Reference: docs/resound_gn_encryption_1.3.0_ilspy.md §4–5
 *
 * Bond modes (from HandleBasedPlatform):
 *   Boot     — CreateTrustedBondUsingBoot: two-stage auth (types 1,2), may reboot
 *   Passcode — CreateTrustedBondUsingPasscode: type 3, requires user passcode
 *   DFU      — CreateTrustedBondForDFU: type 5, uses DFU service UUIDs
 *   Reconnect — EstablishTrustedBond: type 4, uses stored SharedAppSecret
 *
 * Persistence: SharedAppSecret + SharedAppIndex stored securely for reconnect.
 */

// ── Bond state types ──

export type BondMode = 'boot' | 'passcode' | 'dfu' | 'reconnect' | 'none';

export type BondPhase =
  | 'idle'
  | 'reading_challenge'
  | 'reading_public_key'
  | 'generating_keys'
  | 'writing_auth'
  | 'awaiting_response'
  | 'verifying'
  | 'trusted'
  | 'failed'
  | 'awaiting_reboot'; // Boot mode: HI reboots between stage1 and stage2

export interface GnBondInfo {
  /** The bond mode used to establish trust */
  mode: BondMode;
  /** Current phase of the bond flow */
  phase: BondPhase;
  /** Protocol version from security capability read (bytes 0–1) */
  version: number;
  /** App key index from security capability read (bytes 2–3) */
  keyIndex: number;
  /** Whether the device is currently in a trusted session */
  trusted: boolean;
}

export interface StoredBondData {
  /** Device ID (BLE peripheral ID) */
  deviceId: string;
  /** Shared app secret — 32 bytes, base64-encoded for storage */
  sharedAppSecret: string;
  /** Shared app index — returned by HI during boot bond */
  sharedAppIndex: number;
  /** Timestamp of last successful bond */
  lastBondTimestamp: number;
}

// ── Bond state factory ──

export function createInitialBondInfo(): GnBondInfo {
  return {
    mode: 'none',
    phase: 'idle',
    version: 0,
    keyIndex: 0,
    trusted: false,
  };
}

// ── Bond data persistence (AsyncStorage + in-memory cache) ──

const BOND_STORAGE_PREFIX = 'gn_bond_';

// Keep in-memory cache for fast sync access during a session
const bondCache = new Map<string, StoredBondData>();

/** Store bond data for reconnect (EstablishTrustedBond). */
export function storeBondData(data: StoredBondData): void {
  bondCache.set(data.deviceId, data);
  // Also persist to storage asynchronously
  AsyncStorage.setItem(BOND_STORAGE_PREFIX + data.deviceId, JSON.stringify(data))
    .catch(e => console.warn('[GnBondState] Failed to persist bond data:', e));
  console.log('[GnBondState] Bond data stored for', data.deviceId);
}

/** Retrieve stored bond data for reconnect. */
export function loadBondData(deviceId: string): StoredBondData | null {
  return bondCache.get(deviceId) ?? null;
}

/** Call once at app startup to restore persisted bonds into the in-memory cache. */
export async function restorePersistedBonds(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const bondKeys = keys.filter(k => k.startsWith(BOND_STORAGE_PREFIX));
    if (bondKeys.length === 0) return;
    const pairs = await AsyncStorage.multiGet(bondKeys);
    for (const [key, value] of pairs) {
      if (value) {
        try {
          const data: StoredBondData = JSON.parse(value);
          bondCache.set(data.deviceId, data);
          console.log('[GnBondState] Restored bond for', data.deviceId);
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[GnBondState] Failed to restore bond data:', e);
  }
}

/** Remove stored bond data for a device. */
export function clearBondData(deviceId: string): void {
  bondCache.delete(deviceId);
  AsyncStorage.removeItem(BOND_STORAGE_PREFIX + deviceId)
    .catch(() => {});
  console.log('[GnBondState] Bond data cleared for', deviceId);
}

// ── Utility: parse security capability response ──

/**
 * Parse security capability bytes into version and key index.
 * Format: [version_lo, version_hi, index_lo, index_hi, ...]
 */
export function parseSecurityCap(data: Uint8Array): { version: number; keyIndex: number } {
  if (data.length < 4) {
    return { version: 0, keyIndex: 0 };
  }
  const version = data[0] | (data[1] << 8);
  const keyIndex = data[2] | (data[3] << 8);
  return { version, keyIndex };
}

// ── Utility: base64 encode/decode for Uint8Array persistence ──

export function uint8ToBase64(bytes: Uint8Array): string {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

export function base64ToUint8(base64: string): Uint8Array {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = base64.replace(/=+$/, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i]);
    const c1 = B64.indexOf(clean[i + 1]);
    const c2 = B64.indexOf(clean[i + 2]);
    const c3 = B64.indexOf(clean[i + 3]);
    bytes.push((c0 << 2) | (c1 >> 4));
    if (i + 2 < clean.length) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
    if (i + 3 < clean.length) bytes.push(((c2 & 3) << 6) | c3);
  }
  return new Uint8Array(bytes);
}
