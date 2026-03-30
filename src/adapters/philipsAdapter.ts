/**
 * Philips / Oticon (POLARIS platform) BLE adapter
 *
 * Protocol reference: philips_uuid_dossier docs, SPEC.md §2.1
 *
 * Primary service:   56772eaf-2153-4f74-acf3-4368d99fbf5a
 *
 * Volume channels (all 2-byte: [level, invMute] where 1=unmuted, 0=muted):
 *   Main volume:     1454e9d6-f658-4190-8589-22aa9e3021eb  (write-no-response)
 *   Streaming volume: 50632720-4c0f-4bc4-960a-2404bdfdfbca (write-no-response)
 *   Tinnitus/mic:    e5892ebe-97d0-4f97-8f8e-cb85d16a4cc1  (write-no-response)
 *   Volume ranges:   58bbccc5-5a57-4e00-98d5-18c6a0408dfd  (read-only, byte pairs min/max)
 *
 * Program control:
 *   Program select:  535442f7-0ff7-4fec-9780-742f3eb00eda  [(byte) targetProgram]
 *   Program version: 42e940ef-98c8-4ccd-a557-30425295af89  int32, triggers list refresh
 *   Available progs: dcbe7a3e-a742-4527-aeb5-cd8dee63167f  bitset + sentinel(255)
 *   List gate:       68bfa64e-3209-4172-b117-f7eafce17414  handshake, ready=255
 *   Metadata record: bba1c7f1-b445-4657-90c3-8dbd97361a0c  [category, nameLen, ...name, flags]
 *
 * Other:
 *   Device ID:       5f35c43d-e0f4-4da9-87e6-9719982cd25e  (read)
 *   ASHA volume:     00e4ca9e-ab14-41e4-8823-f9e70c7e91df  signed int8 [-128..0]
 */
import type { Device } from 'react-native-ble-plx';
import { getBleManager } from '../ble/BleManager';
import type { HearingAidAdapter, DriverState } from './types';
import type { DeviceInfo, Feature, Program } from '../ble/types';

// ── POLARIS characteristic UUIDs (from philips_uuid_dossier docs) ──

const POLARIS_SERVICE = '56772eaf-2153-4f74-acf3-4368d99fbf5a';

// ── Volume characteristics — all use 2-byte format [level, invMute] ──

/** Main hearing aid volume (confirmed). This is the primary microphone volume. */
const MAIN_VOLUME_CHAR = '1454e9d6-f658-4190-8589-22aa9e3021eb';

/** Streaming audio volume — controls streamed audio level (confirmed). */
const STREAMING_VOLUME_CHAR = '50632720-4c0f-4bc4-960a-2404bdfdfbca';

/** Tinnitus / masker / microphone volume (confirmed). */
const TINNITUS_VOLUME_CHAR = 'e5892ebe-97d0-4f97-8f8e-cb85d16a4cc1';

/**
 * Volume range limits (read-only, confirmed).
 * Byte pairs: [main_min, main_max, stream_min, stream_max, tinnitus_min, tinnitus_max].
 * Used to clamp volume writes to valid device range.
 */
const VOLUME_RANGES_CHAR = '58bbccc5-5a57-4e00-98d5-18c6a0408dfd';

// ── Program characteristics ──

/** Program select: write [(byte) targetProgram], write-no-response (confirmed). */
const PROGRAM_SELECT_CHAR = '535442f7-0ff7-4fec-9780-742f3eb00eda';

/** Available programs bitset — bytes encode valid program IDs, sentinel 255 (confirmed). */
const AVAILABLE_PROGRAMS_CHAR = 'dcbe7a3e-a742-4527-aeb5-cd8dee63167f';

/** Program list handshake gate: write command byte, byte0==255 means ready (confirmed). */
const PROGRAM_LIST_CHAR = '68bfa64e-3209-4172-b117-f7eafce17414';

/**
 * Program metadata record channel (confirmed structure):
 * [category, nameLen, ...nameBytes, flagsByte].
 */
const PROGRAM_CONFIG_CHAR = 'bba1c7f1-b445-4657-90c3-8dbd97361a0c';

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

  /** Cached volume ranges from device: [mainMin, mainMax, streamMin, streamMax, ...] */
  private volumeRanges: number[] | null = null;

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

    // Read volume ranges so we can clamp writes to valid device limits
    try {
      const rangeChar = await withRetry(() =>
        this.device!.readCharacteristicForService(POLARIS_SERVICE, VOLUME_RANGES_CHAR),
      );
      if (rangeChar.value) {
        this.volumeRanges = base64ToBytes(rangeChar.value);
      }
    } catch {
      // Volume ranges char may not be present on all POLARIS firmware versions
    }
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

  /** Clamp a volume level to the device's reported range (if known). */
  private clampVolume(level: number, channel: 'main' | 'streaming' | 'tinnitus'): number {
    const rounded = Math.max(0, Math.min(255, Math.round(level)));
    if (!this.volumeRanges) return rounded;
    // volumeRanges layout: [main_min, main_max, stream_min, stream_max, tinnitus_min, tinnitus_max]
    const offset = channel === 'main' ? 0 : channel === 'streaming' ? 2 : 4;
    if (this.volumeRanges.length > offset + 1) {
      return Math.max(this.volumeRanges[offset], Math.min(this.volumeRanges[offset + 1], rounded));
    }
    return rounded;
  }

  /**
   * Set main hearing aid volume.
   * Writes [levelByte, invMuteByte] to main volume characteristic (1454e9d6).
   * Per-ear control requires connecting to each device independently —
   * the ear parameter is accepted for interface conformance only.
   */
  async setVolume(level: number, _ear?: 'left' | 'right' | 'both'): Promise<void> {
    const dev = this.connected;
    const clamped = this.clampVolume(level, 'main');
    const muteFlag = this.lastKnownMute ? 0 : 1;

    await withRetry(() =>
      dev.writeCharacteristicWithoutResponseForService(
        POLARIS_SERVICE,
        MAIN_VOLUME_CHAR,
        bytesToBase64([clamped, muteFlag]),
      ),
    );
  }

  async getVolume(): Promise<number> {
    const dev = this.connected;
    const char = await withRetry(() =>
      dev.readCharacteristicForService(POLARIS_SERVICE, MAIN_VOLUME_CHAR),
    );
    if (!char.value) throw new Error('No value from volume characteristic');
    const bytes = base64ToBytes(char.value);
    if (bytes.length >= 2) {
      this.lastKnownMute = bytes[1] === 0;
    }
    return bytes[0];
  }

  /**
   * Set mute state via main volume characteristic.
   * byte1: 0 = muted, 1 = unmuted (confirmed via philips_uuid_dossier).
   */
  async setMute(muted: boolean): Promise<void> {
    const dev = this.connected;
    let currentLevel = 0;
    try {
      currentLevel = await this.getVolume();
    } catch {
      // Fall back to 0 if current volume unreadable
    }
    this.lastKnownMute = muted;
    const muteFlag = muted ? 0 : 1;

    await withRetry(() =>
      dev.writeCharacteristicWithoutResponseForService(
        POLARIS_SERVICE,
        MAIN_VOLUME_CHAR,
        bytesToBase64([currentLevel, muteFlag]),
      ),
    );
  }

  async getMute(): Promise<boolean> {
    const dev = this.connected;
    const char = await withRetry(() =>
      dev.readCharacteristicForService(POLARIS_SERVICE, MAIN_VOLUME_CHAR),
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
      dev.writeCharacteristicWithoutResponseForService(
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
   * Read available programs from the device.
   *
   * Discovery pipeline (from philips_uuid_dossier):
   * 1. Read available programs bitset (dcbe7a3e) — bytes are valid program IDs, 255 = sentinel
   * 2. For each program ID, write it to handshake gate (68bfa64e), wait for ready (byte0==255)
   * 3. Read program metadata (bba1c7f1): [category, nameLen, ...nameBytes, flags]
   *
   * Falls back to placeholder names if any step fails.
   */
  async getPrograms(): Promise<Program[]> {
    const dev = this.connected;

    // Step 1: Read available program IDs from bitset characteristic
    let programIds: number[] = [];
    try {
      const bitsetChar = await withRetry(() =>
        dev.readCharacteristicForService(POLARIS_SERVICE, AVAILABLE_PROGRAMS_CHAR),
      );
      if (bitsetChar.value) {
        const bytes = base64ToBytes(bitsetChar.value);
        // Bytes are program IDs; 255 is the sentinel marking end of list
        programIds = bytes.filter((b) => b !== 255);
      }
    } catch {
      // Bitset char may not be available on all POLARIS firmware
    }

    if (programIds.length === 0) {
      return [
        { index: 0, name: 'Program 1' },
        { index: 1, name: 'Program 2' },
        { index: 2, name: 'Program 3' },
        { index: 3, name: 'Program 4' },
      ];
    }

    // Step 2+3: For each program ID, use handshake gate + metadata to get name
    const programs: Program[] = [];
    for (const id of programIds) {
      let name = `Program ${id + 1}`;

      try {
        // Write program ID to handshake gate (write-with-response)
        await withRetry(() =>
          dev.writeCharacteristicWithResponseForService(
            POLARIS_SERVICE,
            PROGRAM_LIST_CHAR,
            bytesToBase64([id]),
          ),
        );

        // Read metadata record: [category, nameLen, ...nameBytes, flags]
        const metaChar = await withRetry(() =>
          dev.readCharacteristicForService(POLARIS_SERVICE, PROGRAM_CONFIG_CHAR),
        );
        if (metaChar.value) {
          const meta = base64ToBytes(metaChar.value);
          if (meta.length >= 3) {
            const nameLen = meta[1];
            if (meta.length >= 2 + nameLen) {
              const nameBytes = meta.slice(2, 2 + nameLen);
              const decoded = String.fromCharCode(...nameBytes);
              if (decoded.length > 0) {
                name = decoded;
              }
            }
          }
        }
      } catch {
        // Metadata fetch failed for this program — keep placeholder name
      }

      programs.push({ index: id, name });
    }

    // Signal handshake completion by writing sentinel
    try {
      await dev.writeCharacteristicWithResponseForService(
        POLARIS_SERVICE,
        PROGRAM_LIST_CHAR,
        bytesToBase64([255]),
      );
    } catch {
      // Non-critical
    }

    return programs;
  }

  /**
   * Read battery via standard BLE Battery Service (0x180F).
   * Returns 0-100 on success, -1 on failure.
   * Philips HearLink uses the standard BAS (confirmed via dossier docs).
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
      return -1;
    }
  }

  /**
   * Set streaming audio volume via POLARIS streaming volume characteristic (50632720).
   * Same 2-byte format as main volume: [level, invMute].
   */
  async setStreamingVolume(level: number): Promise<void> {
    const dev = this.connected;
    const clamped = this.clampVolume(level, 'streaming');
    const muteFlag = this.lastKnownMute ? 0 : 1;

    await withRetry(() =>
      dev.writeCharacteristicWithoutResponseForService(
        POLARIS_SERVICE,
        STREAMING_VOLUME_CHAR,
        bytesToBase64([clamped, muteFlag]),
      ),
    );
  }

  /**
   * Set tinnitus masker / microphone volume (e5892ebe).
   * Same 2-byte format: [level, invMute].
   */
  async setTinnitusVolume(level: number): Promise<void> {
    const dev = this.connected;
    const clamped = this.clampVolume(level, 'tinnitus');
    const muteFlag = 1; // tinnitus masker unmuted when active

    await withRetry(() =>
      dev.writeCharacteristicWithoutResponseForService(
        POLARIS_SERVICE,
        TINNITUS_VOLUME_CHAR,
        bytesToBase64([clamped, muteFlag]),
      ),
    );
  }

  async refreshState(): Promise<DriverState> {
    const dev = this.connected;

    // Read main volume + mute from single characteristic
    let volume: number | undefined;
    let muted: boolean | undefined;
    try {
      const volChar = await withRetry(() =>
        dev.readCharacteristicForService(POLARIS_SERVICE, MAIN_VOLUME_CHAR),
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
      // Main volume characteristic read failed
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
    return ['volume', 'mute', 'program', 'battery', 'streaming', 'tinnitus'];
  }
}
