/**
 * Philips / Oticon (POLARIS platform) BLE adapter
 *
 * Supports two proprietary service paths:
 *
 * 1. POLARIS service (56772eaf) — older/current generation (Oticon/Demant stack)
 *    Volume channels (all 2-byte: [level, invMute] where 1=unmuted, 0=muted):
 *      Main volume:     1454e9d6  (write-no-response)
 *      Streaming volume: 50632720 (write-no-response)
 *      Tinnitus/mic:    e5892ebe  (write-no-response)
 *      Volume ranges:   58bbccc5  (read-only, byte pairs min/max)
 *    Program control:
 *      Program select:  535442f7  [(byte) targetProgram]
 *      Available progs: dcbe7a3e  bitset + sentinel(255)
 *      List gate:       68bfa64e  handshake, ready=255
 *      Metadata record: bba1c7f1  [category, nameLen, ...name, flags]
 *
 * 2. HearLink proprietary service (ba50125d) — newer generation (HearLink 9050+)
 *    Discovered via live BLE probe on "GUDNY Hearing Aids" (HearLink 9050, FW rel_7.3_30.0).
 *    Command/response via 43c8465e (WRITE+NOTIFY).
 *    State read via e6c02a45 (READ, 12-byte payload: bytes[8..10] appear to be volume levels).
 *    Wire protocol for ba50125d is not yet fully decoded — command format is inferred.
 *
 * Both paths use standard BLE Battery Service (0x180F) and Device Information (0x180A).
 */
import type { Device, Subscription } from 'react-native-ble-plx';
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

// ── Philips HearLink proprietary service (live probe: HearLink 9050, FW rel_7.3_30.0) ──
// Distinct from POLARIS — found on newer HearLink models alongside LE Audio/ASHA services.

const HEARLINK_SERVICE = 'ba50125d-0806-42ab-8bf1-22e0b954a8fa';

/** Device state/config (READ). Probe returned 12 bytes: 01 01 01 00 00 f4 06 03 80 80 80 00.
 *  Bytes[8..10] = 0x80 each — likely volume/balance/tinnitus at midpoint. */
const HL_STATE_CHAR = 'e6c02a45-a0e5-41f2-9cd1-c1fab9ec0c3e';

/** Primary command/control channel (WRITE, NOTIFY). Used for volume/program control.
 *  Wire protocol not yet fully decoded — command format inferred from POLARIS patterns. */
const HL_COMMAND_CHAR = '43c8465e-ba80-451d-8098-57716b4fdbe5';

/** Write channel A (WRITE, WRITE_NO_RESP). Semantic TBD — may be data/config transport. */
const HL_WRITE_A_CHAR = '855c8579-17b7-40a8-be4f-ad574357f797';

/** Write channel B (WRITE, WRITE_NO_RESP). Semantic TBD. */
const HL_WRITE_B_CHAR = '6d6a8b8f-544e-4ef1-be91-c60db8e70884';

/** Write channel C (WRITE, WRITE_NO_RESP). Semantic TBD. */
const HL_WRITE_C_CHAR = 'f6c47754-8bd2-4cc2-bf0b-fdee78fa812e';

/** Status notification A (NOTIFY only). */
const HL_NOTIFY_A_CHAR = '5eb7ff93-ebeb-479c-85ab-526f25482545';

/** Status notification B (NOTIFY only). */
const HL_NOTIFY_B_CHAR = 'ed5f901b-fb08-452c-8d01-46b6c9c1bcc5';

/** Status notification C (NOTIFY only). */
const HL_NOTIFY_C_CHAR = '80911332-ead5-4da0-9bfa-4d6286032e25';

// ── Standard BLE Device Information Service (0x180A) ──
// All chars confirmed readable without bond on HearLink 9050.

const DIS_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
const DIS_MODEL_CHAR = '00002a24-0000-1000-8000-00805f9b34fb';
const DIS_MANUFACTURER_CHAR = '00002a29-0000-1000-8000-00805f9b34fb';
const DIS_FIRMWARE_CHAR = '00002a26-0000-1000-8000-00805f9b34fb';

// ── Standard BLE Battery Service (0x180F) ──
// Confirmed readable without bond on HearLink 9050 (returned 0x64 = 100%).

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

  /** True when HearLink proprietary service (ba50125d) is used instead of POLARIS */
  private useHearLink = false;

  /** Subscription for HearLink command channel notifications (43c8465e) */
  private hlCommandSub: Subscription | null = null;

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

    // Detect which proprietary service is available.
    // HearLink 9050+ uses ba50125d; older models use POLARIS (56772eaf).
    const services = await this.device.services();
    const serviceUuids = services.map((s) => s.uuid.toLowerCase());
    this.useHearLink = serviceUuids.some(
      (u) => u.replace(/-/g, '') === HEARLINK_SERVICE.replace(/-/g, ''),
    );

    if (this.useHearLink) {
      // Subscribe to HearLink command channel notifications for command responses
      this.hlCommandSub = this.device.monitorCharacteristicForService(
        HEARLINK_SERVICE,
        HL_COMMAND_CHAR,
        (_error, _char) => {
          // Command response handler — captures acknowledge/state updates.
          // TODO: Parse response payload once wire protocol is decoded.
        },
      );
    } else {
      // POLARIS path: read volume ranges so we can clamp writes to valid device limits
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
  }

  async disconnect(): Promise<void> {
    if (this.hlCommandSub) {
      this.hlCommandSub.remove();
      this.hlCommandSub = null;
    }
    if (this.device) {
      try {
        await this.device.cancelConnection();
      } catch {
        // Device may already be disconnected
      }
      this.device = null;
      this.deviceId = null;
      this.useHearLink = false;
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
   * POLARIS path: writes [levelByte, invMuteByte] to main volume char (1454e9d6).
   * HearLink path: writes [levelByte, invMuteByte] to command char (43c8465e).
   *   HearLink wire format is inferred from POLARIS pattern — not yet runtime-validated.
   * Per-ear control requires connecting to each device independently.
   */
  async setVolume(level: number, _ear?: 'left' | 'right' | 'both'): Promise<void> {
    const dev = this.connected;
    const clamped = this.clampVolume(level, 'main');
    const muteFlag = this.lastKnownMute ? 0 : 1;

    if (this.useHearLink) {
      // HearLink: use command channel. Format inferred — [level, muteFlag] per POLARIS pattern.
      await withRetry(() =>
        dev.writeCharacteristicWithResponseForService(
          HEARLINK_SERVICE,
          HL_COMMAND_CHAR,
          bytesToBase64([clamped, muteFlag]),
        ),
      );
    } else {
      await withRetry(() =>
        dev.writeCharacteristicWithoutResponseForService(
          POLARIS_SERVICE,
          MAIN_VOLUME_CHAR,
          bytesToBase64([clamped, muteFlag]),
        ),
      );
    }
  }

  async getVolume(): Promise<number> {
    const dev = this.connected;

    if (this.useHearLink) {
      // HearLink: read state char (e6c02a45). Bytes[8..10] appear to be volume levels
      // based on probe data (all 0x80 = midpoint on fresh device).
      const char = await withRetry(() =>
        dev.readCharacteristicForService(HEARLINK_SERVICE, HL_STATE_CHAR),
      );
      if (!char.value) throw new Error('No value from HearLink state characteristic');
      const bytes = base64ToBytes(char.value);
      // byte[8] = main volume (inferred from probe: 0x80 = midpoint)
      return bytes.length > 8 ? bytes[8] : 0;
    }

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
   * Set mute state.
   * POLARIS: byte1 of volume char — 0 = muted, 1 = unmuted (confirmed).
   * HearLink: writes [currentLevel, muteFlag] to command char (inferred).
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

    if (this.useHearLink) {
      await withRetry(() =>
        dev.writeCharacteristicWithResponseForService(
          HEARLINK_SERVICE,
          HL_COMMAND_CHAR,
          bytesToBase64([currentLevel, muteFlag]),
        ),
      );
    } else {
      await withRetry(() =>
        dev.writeCharacteristicWithoutResponseForService(
          POLARIS_SERVICE,
          MAIN_VOLUME_CHAR,
          bytesToBase64([currentLevel, muteFlag]),
        ),
      );
    }
  }

  async getMute(): Promise<boolean> {
    const dev = this.connected;

    if (this.useHearLink) {
      // HearLink: mute state not yet mapped in state char — return tracked state
      return this.lastKnownMute;
    }

    const char = await withRetry(() =>
      dev.readCharacteristicForService(POLARIS_SERVICE, MAIN_VOLUME_CHAR),
    );
    if (!char.value) throw new Error('No value from volume characteristic');
    const bytes = base64ToBytes(char.value);
    const muted = bytes.length >= 2 ? bytes[1] === 0 : false;
    this.lastKnownMute = muted;
    return muted;
  }

  /**
   * Select program.
   * POLARIS: write [(byte) targetProgram] to 535442f7 (confirmed).
   * HearLink: write [(byte) programId] to command char 43c8465e (inferred).
   *   The command char likely multiplexes volume and program commands;
   *   the exact discriminator byte is TBD pending wire protocol decode.
   */
  async setProgram(index: number): Promise<void> {
    const dev = this.connected;

    if (this.useHearLink) {
      // HearLink: write program index to command channel.
      // Single-byte write inferred from POLARIS pattern.
      await withRetry(() =>
        dev.writeCharacteristicWithResponseForService(
          HEARLINK_SERVICE,
          HL_COMMAND_CHAR,
          bytesToBase64([index & 0xff]),
        ),
      );
    } else {
      await withRetry(() =>
        dev.writeCharacteristicWithoutResponseForService(
          POLARIS_SERVICE,
          PROGRAM_SELECT_CHAR,
          bytesToBase64([index & 0xff]),
        ),
      );
    }
  }

  async getProgram(): Promise<number> {
    const dev = this.connected;

    if (this.useHearLink) {
      // HearLink: program index not yet mapped in state char — return 0 as default.
      // TODO: Identify which byte in HL_STATE_CHAR encodes active program.
      return 0;
    }

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
   * Confirmed readable without bond on HearLink 9050 (probe returned 0x64 = 100%).
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
   * Read device info via standard BLE Device Information Service (0x180A).
   * All chars confirmed readable without bond on HearLink 9050:
   *   Manufacturer: "SBO Hearing", Model: "HearLink 9050", FW: "rel_7.3_30.0"
   */
  async getDeviceInfo(): Promise<DeviceInfo> {
    const dev = this.connected;
    const info: DeviceInfo = {
      id: this.deviceId!,
      name: dev.name ?? 'Philips Hearing Aid',
      brand: 'philips',
    };

    try {
      const fwChar = await withRetry(() =>
        dev.readCharacteristicForService(DIS_SERVICE, DIS_FIRMWARE_CHAR),
      );
      if (fwChar.value) {
        info.firmwareVersion = String.fromCharCode(...base64ToBytes(fwChar.value));
      }
    } catch {
      // DIS firmware char may not be readable on all models
    }

    return info;
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

    let volume: number | undefined;
    let muted: boolean | undefined;

    if (this.useHearLink) {
      // HearLink: read state from e6c02a45. Bytes[8..10] inferred as volume levels.
      try {
        const stateChar = await withRetry(() =>
          dev.readCharacteristicForService(HEARLINK_SERVICE, HL_STATE_CHAR),
        );
        if (stateChar.value) {
          const bytes = base64ToBytes(stateChar.value);
          volume = bytes.length > 8 ? bytes[8] : undefined;
        }
      } catch {
        // HearLink state read failed
      }
      muted = this.lastKnownMute;
    } else {
      // POLARIS: read main volume + mute from single characteristic
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
    }

    const [activeProgram, batteryPercent, deviceInfo] = await Promise.all([
      this.getProgram().catch(() => undefined),
      this.getBattery().catch(() => undefined),
      this.getDeviceInfo().catch(() => undefined),
    ]);

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
