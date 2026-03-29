/**
 * Philips / Oticon (POLARIS platform) BLE adapter
 *
 * Protocol reference: SPEC.md §2.1, command_dictionary.md
 *
 * Primary service: 56772eaf-2153-4f74-acf3-4368d99fbf5a
 * Volume R/W:      50632720-4c0f-4bc4-960a-2404bdfdfbca  [levelByte, muteFlagByte]
 * Program select:  535442f7-0ff7-4fec-9780-742f3eb00eda  [(byte) targetProgram]
 * Program list:    68bfa64e-3209-4172-b117-f7eafce17414  [(byte) command], ready=255
 * Program config:  bba1c7f1-b445-4657-90c3-8dbd97361a0c  read when list not ready
 * Device ID:       5f35c43d-e0f4-4da9-87e6-9719982cd25e  (read)
 * ASHA volume:     00e4ca9e-ab14-41e4-8823-f9e70c7e91df  signed int8 [-128..0]
 */
import type { Device } from 'react-native-ble-plx';
import { getBleManager } from '../ble/BleManager';
import type { HearingAidAdapter, DriverState } from './types';
import type { DeviceInfo, Feature, Program } from '../ble/types';

// ── POLARIS characteristic UUIDs (SPEC.md §2.1) ──

const POLARIS_SERVICE = '56772eaf-2153-4f74-acf3-4368d99fbf5a';

/** Volume + mute: write [levelByte, muteFlagByte], read same (confirmed) */
const VOLUME_CHAR = '50632720-4c0f-4bc4-960a-2404bdfdfbca';

/** Program select: write [(byte) targetProgram] (confirmed) */
const PROGRAM_SELECT_CHAR = '535442f7-0ff7-4fec-9780-742f3eb00eda';

/** Program list ready check: response byte0 == 255 means ready (partial) */
const PROGRAM_LIST_CHAR = '68bfa64e-3209-4172-b117-f7eafce17414';

// TODO: Parse program config format when documented (SPEC.md §2.1 — partial)
// const PROGRAM_CONFIG_CHAR = 'bba1c7f1-b445-4657-90c3-8dbd97361a0c';

/** Device ID — read (confirmed) */
const DEVICE_ID_CHAR = '5f35c43d-e0f4-4da9-87e6-9719982cd25e';

/** ASHA volume fallback — signed int8 [-128..0] (confirmed) */
const ASHA_VOLUME_CHAR = '00e4ca9e-ab14-41e4-8823-f9e70c7e91df';

// ── Standard BLE Battery Service ──

const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';

// ── Retry config (Android BLE is flaky) ──

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// ── Base64 helpers for react-native-ble-plx characteristic values ──

const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: number[]): string {
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

function base64ToBytes(base64: string): number[] {
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
  return bytes;
}

/** Retry wrapper for transient Android BLE failures (GATT errors, timeouts) */
async function withRetry<T>(
  op: () => Promise<T>,
  retries = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await op();
    } catch (err) {
      lastError = err;
      if (i < retries - 1) {
        await new Promise<void>((r) => setTimeout(() => r(), RETRY_DELAY_MS * (i + 1)));
      }
    }
  }
  throw lastError;
}

export class PhilipsAdapter implements HearingAidAdapter {
  readonly brand = 'philips' as const;

  private device: Device | null = null;
  private deviceId: string | null = null;
  private lastKnownMute = false;

  /** Returns connected device or throws */
  private get connected(): Device {
    if (!this.device) {
      throw new Error('PhilipsAdapter: not connected — call connect() first');
    }
    return this.device;
  }

  async connect(deviceId: string): Promise<void> {
    const manager = getBleManager();
    this.deviceId = deviceId;

    this.device = await withRetry(() =>
      manager.connectToDevice(deviceId, { requestMTU: 512 }),
    );

    await this.device.discoverAllServicesAndCharacteristics();
  }

  async disconnect(): Promise<void> {
    if (this.device) {
      try {
        await this.device.cancelConnection();
      } catch {
        // Device may already be disconnected
      }
      this.device = null;
      this.deviceId = null;
    }
  }

  /**
   * Set volume on connected POLARIS device.
   * Writes [levelByte, muteFlagByte] to volume characteristic (confirmed).
   * Per-ear control requires connecting to each device independently —
   * the ear parameter is accepted for interface conformance only.
   */
  async setVolume(level: number, _ear?: 'left' | 'right' | 'both'): Promise<void> {
    const dev = this.connected;
    const clamped = Math.max(0, Math.min(255, Math.round(level)));
    const muteFlag = this.lastKnownMute ? 0 : 1;

    await withRetry(() =>
      dev.writeCharacteristicWithResponseForService(
        POLARIS_SERVICE,
        VOLUME_CHAR,
        bytesToBase64([clamped, muteFlag]),
      ),
    );
  }

  async getVolume(): Promise<number> {
    const dev = this.connected;
    const char = await withRetry(() =>
      dev.readCharacteristicForService(POLARIS_SERVICE, VOLUME_CHAR),
    );
    if (!char.value) throw new Error('No value from volume characteristic');
    const bytes = base64ToBytes(char.value);
    if (bytes.length >= 2) {
      this.lastKnownMute = bytes[1] === 0;
    }
    return bytes[0];
  }

  /**
   * Set mute state via volume characteristic.
   * byte1: 0 = muted, 1 = unmuted (SPEC.md §2.1, confirmed).
   */
  async setMute(muted: boolean): Promise<void> {
    const dev = this.connected;
    // Read current volume to preserve it when toggling mute
    let currentLevel = 0;
    try {
      currentLevel = await this.getVolume();
    } catch {
      // Fall back to 0 if current volume unreadable
    }
    this.lastKnownMute = muted;
    const muteFlag = muted ? 0 : 1;

    await withRetry(() =>
      dev.writeCharacteristicWithResponseForService(
        POLARIS_SERVICE,
        VOLUME_CHAR,
        bytesToBase64([currentLevel, muteFlag]),
      ),
    );
  }

  async getMute(): Promise<boolean> {
    const dev = this.connected;
    const char = await withRetry(() =>
      dev.readCharacteristicForService(POLARIS_SERVICE, VOLUME_CHAR),
    );
    if (!char.value) throw new Error('No value from volume characteristic');
    const bytes = base64ToBytes(char.value);
    const muted = bytes.length >= 2 ? bytes[1] === 0 : false;
    this.lastKnownMute = muted;
    return muted;
  }

  /** Write [(byte) targetProgram] to program select characteristic (confirmed). */
  async setProgram(index: number): Promise<void> {
    const dev = this.connected;
    await withRetry(() =>
      dev.writeCharacteristicWithResponseForService(
        POLARIS_SERVICE,
        PROGRAM_SELECT_CHAR,
        bytesToBase64([index & 0xff]),
      ),
    );
  }

  async getProgram(): Promise<number> {
    const dev = this.connected;
    const char = await withRetry(() =>
      dev.readCharacteristicForService(POLARIS_SERVICE, PROGRAM_SELECT_CHAR),
    );
    if (!char.value) throw new Error('No value from program characteristic');
    return base64ToBytes(char.value)[0];
  }

  /**
   * Read available programs.
   * TODO: Program list protocol partially mapped (SPEC.md §2.1).
   * Ready check (68bfa64e, byte0==255) is confirmed; config read
   * format (bba1c7f1) is not. Returns placeholder names until
   * protocol is fully reverse-engineered.
   */
  async getPrograms(): Promise<Program[]> {
    const dev = this.connected;

    try {
      const listChar = await withRetry(() =>
        dev.readCharacteristicForService(POLARIS_SERVICE, PROGRAM_LIST_CHAR),
      );
      if (listChar.value) {
        const bytes = base64ToBytes(listChar.value);
        if (bytes[0] === 255) {
          // TODO: Parse program config from bba1c7f1 when format is documented (SPEC.md §2.1)
        }
        // TODO: Use byte data to determine actual number of programs (SPEC.md §2.1)
      }
    } catch {
      // Program list characteristic may not be available on all POLARIS devices
    }

    // TODO: Replace with actual device program list (SPEC.md §2.1 — partial)
    return [
      { index: 0, name: 'Program 1' },
      { index: 1, name: 'Program 2' },
      { index: 2, name: 'Program 3' },
      { index: 3, name: 'Program 4' },
    ];
  }

  /**
   * Read battery via standard BLE Battery Service (0x180F).
   * Returns 0-100 on success, -1 on failure.
   * TODO: Confirm whether Philips uses standard BAS or a proprietary
   * battery characteristic (SPEC.md §2.1 — battery confirmed but
   * specific UUID not documented).
   */
  async getBattery(): Promise<number> {
    const dev = this.connected;
    try {
      const char = await withRetry(() =>
        dev.readCharacteristicForService(BATTERY_SERVICE, BATTERY_LEVEL_CHAR),
      );
      if (!char.value) return -1;
      return base64ToBytes(char.value)[0]; // BAS: single byte 0-100
    } catch {
      // TODO: Try proprietary battery characteristic if BAS unavailable (SPEC.md §2.1)
      return -1;
    }
  }

  /**
   * ASHA streaming volume — writes signed int8 [-128..0] where
   * 0 = max volume, -128 = minimum/mute (confirmed).
   * Input: level 0..100 mapped to -128..0.
   * TODO: Verify service UUID — may be under ASHA service 0000fdf0
   * instead of POLARIS (SPEC.md §2.1).
   */
  async setStreamingVolume(level: number): Promise<void> {
    const dev = this.connected;
    // Map 0..100 → -128..0
    const ashaLevel = Math.round((level / 100) * 128) - 128;
    const clamped = Math.max(-128, Math.min(0, ashaLevel));
    // Encode signed int8 as unsigned byte (two's complement)
    const byte = clamped & 0xff;

    await withRetry(() =>
      dev.writeCharacteristicWithResponseForService(
        POLARIS_SERVICE, // TODO: May be under ASHA service 0000fdf0 instead (SPEC.md §2.1)
        ASHA_VOLUME_CHAR,
        bytesToBase64([byte]),
      ),
    );
  }

  async refreshState(): Promise<DriverState> {
    const dev = this.connected;

    // Read volume + mute from single characteristic to avoid duplicate reads
    let volume: number | undefined;
    let muted: boolean | undefined;
    try {
      const volChar = await withRetry(() =>
        dev.readCharacteristicForService(POLARIS_SERVICE, VOLUME_CHAR),
      );
      if (volChar.value) {
        const bytes = base64ToBytes(volChar.value);
        volume = bytes[0];
        if (bytes.length >= 2) {
          muted = bytes[1] === 0;
          this.lastKnownMute = muted;
        }
      }
    } catch {
      // Volume characteristic read failed
    }

    const [activeProgram, batteryPercent] = await Promise.all([
      this.getProgram().catch(() => undefined),
      this.getBattery().catch(() => undefined),
    ]);

    let deviceInfo: DeviceInfo | undefined;
    try {
      const idChar = await withRetry(() =>
        dev.readCharacteristicForService(POLARIS_SERVICE, DEVICE_ID_CHAR),
      );
      if (idChar.value) {
        deviceInfo = {
          id: this.deviceId!,
          name: dev.name ?? 'Philips Hearing Aid',
          brand: 'philips',
          firmwareVersion: String.fromCharCode(...base64ToBytes(idChar.value)),
        };
      }
    } catch {
      // Device ID read failed
    }

    return {
      volume,
      muted,
      activeProgram,
      batteryPercent:
        batteryPercent !== undefined && batteryPercent >= 0
          ? batteryPercent
          : undefined,
      deviceInfo,
    };
  }

  getSupportedFeatures(): Feature[] {
    return ['volume', 'mute', 'program', 'battery', 'streaming'];
  }
}
