/**
 * Philips / Oticon (POLARIS platform) BLE adapter
 *
 * Supports two proprietary service paths:
 *
 * 1. POLARIS service (56772eaf) — older/current generation (Oticon/Demant stack)
 *    Volume channels (all 4-byte: UINT16 level LE + UINT16 mute LE, 0=muted):
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
import { getBondState, createBond, BOND_BONDED } from '../ble/bleBond';
import type { HearingAidAdapter, DriverState } from './types';
import type { DeviceInfo, Feature, Program } from '../ble/types';

// ── POLARIS characteristic UUIDs (from philips_uuid_dossier docs) ──

const POLARIS_SERVICE = '56772eaf-2153-4f74-acf3-4368d99fbf5a';
const SECONDARY_SERVICE = '14293049-77d7-4244-ae6a-d3873e4a3184';
const SCAN_FILTER_SERVICE = '7d74f4bd-c74a-4431-862c-cce884371592';

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
  private lastKnownVolume = 0;
  private lastKnownProgram = 0;

  /** True when HearLink proprietary service (ba50125d) is used instead of POLARIS */
  private useHearLink = false;

  /** Subscription for HearLink command channel notifications (43c8465e) */
  private hlCommandSub: Subscription | null = null;

  /** Subscription for POLARIS main volume notifications (1454e9d6) */
  private volumeNotifySub: Subscription | null = null;

  /** Subscription for POLARIS program select notifications (535442f7) */
  private programNotifySub: Subscription | null = null;

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
    console.log(`[PhilipsAdapter] Connecting to ${deviceId}...`);

    this.device = await withRetry(() =>
      manager.connectToDevice(deviceId, { requestMTU: 255 }),
    );
    console.log('[PhilipsAdapter] GATT connected, discovering services...');

    await this.device.discoverAllServicesAndCharacteristics();
    console.log('[PhilipsAdapter] Service discovery complete');

    // Ensure Android-level BLE bond before any secured characteristic access.
    // Without this, writes to proprietary characteristics fail with
    // "Operation was rejected" on Android 6+.
    const bondState = await getBondState(deviceId);
    if (bondState !== BOND_BONDED) {
      console.log('[PhilipsAdapter] Initiating Android BLE bond...');
      await createBond(deviceId);
      console.log('[PhilipsAdapter] Android bond complete');
    } else {
      console.log('[PhilipsAdapter] Already Android-bonded');
    }

    // Detect which proprietary service is available.
    // HearLink 9050+ uses ba50125d; older models use POLARIS (56772eaf).
    const services = await this.device.services();
    const serviceUuids = services.map((s) => s.uuid.toLowerCase());
    this.useHearLink = serviceUuids.some(
      (u) => u.replace(/-/g, '') === HEARLINK_SERVICE.replace(/-/g, ''),
    );
    console.log(`[PhilipsAdapter] Service path: ${this.useHearLink ? 'HearLink (ba50125d)' : 'POLARIS (56772eaf)'}`);

    if (this.useHearLink) {
      // Subscribe to HearLink command channel notifications for command responses
      this.hlCommandSub = this.device.monitorCharacteristicForService(
        HEARLINK_SERVICE,
        HL_COMMAND_CHAR,
        (error, char) => {
          if (error) {
            console.log('[PhilipsAdapter] HearLink command notify error:', error.message);
            return;
          }
          if (!char?.value) return;
          const bytes = base64ToBytes(char.value);
          console.log(`[PhilipsAdapter] HearLink command notify: [${bytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
          // TODO: Parse response payload once wire protocol is decoded.
        },
      );
      console.log('[PhilipsAdapter] Subscribed to HearLink command notifications');
    } else {
      // POLARIS path: read volume ranges so we can clamp writes to valid device limits
      try {
        const rangeChar = await withRetry(() =>
          this.device!.readCharacteristicForService(POLARIS_SERVICE, VOLUME_RANGES_CHAR),
        );
        if (rangeChar.value) {
          const rawBytes = base64ToBytes(rangeChar.value);
          // Parse as UINT16 LE pairs: [mainMin, mainMax, streamMin, streamMax, ...]
          const ranges: number[] = [];
          for (let i = 0; i + 1 < rawBytes.length; i += 2) {
            ranges.push(rawBytes[i] | (rawBytes[i + 1] << 8));
          }
          this.volumeRanges = ranges;
          console.log(`[PhilipsAdapter] Volume ranges: [${this.volumeRanges.join(', ')}]`);
        }
      } catch {
        console.log('[PhilipsAdapter] Volume ranges char not available — skipping clamp');
      }

      // Subscribe to POLARIS main volume char (1454e9d6) for real-time volume state.
      // Format: [level, invMute] where invMute 1=unmuted, 0=muted.
      try {
        this.volumeNotifySub = this.device.monitorCharacteristicForService(
          POLARIS_SERVICE,
          MAIN_VOLUME_CHAR,
          (error, char) => {
            if (error || !char?.value) return;
            const bytes = base64ToBytes(char.value);
            if (bytes.length >= 2) {
              this.lastKnownVolume = bytes[0] | (bytes[1] << 8);
            }
            if (bytes.length >= 4) {
              this.lastKnownMute = (bytes[2] | (bytes[3] << 8)) === 0;
            }
            console.log(`[PhilipsAdapter] Volume notify: level=${this.lastKnownVolume}, mute=${this.lastKnownMute}`);
          },
        );
        console.log('[PhilipsAdapter] Subscribed to POLARIS volume notifications');
      } catch {
        console.log('[PhilipsAdapter] POLARIS volume subscription not available');
      }

      // Subscribe to POLARIS program select char (535442f7) for real-time program state.
      // Notify returns byte[0] = active program index.
      try {
        this.programNotifySub = this.device.monitorCharacteristicForService(
          POLARIS_SERVICE,
          PROGRAM_SELECT_CHAR,
          (error, char) => {
            if (error || !char?.value) return;
            const bytes = base64ToBytes(char.value);
            if (bytes.length >= 1) {
              this.lastKnownProgram = bytes[0];
              console.log(`[PhilipsAdapter] Program notify: program=${bytes[0]}`);
            }
          },
        );
        console.log('[PhilipsAdapter] Subscribed to POLARIS program notifications');
      } catch {
        console.log('[PhilipsAdapter] POLARIS program subscription not available');
      }

      // Subscribe to volume ranges (58bbccc5) for limit updates
      try {
        this.device.monitorCharacteristicForService(
          POLARIS_SERVICE,
          VOLUME_RANGES_CHAR,
          (error, char) => {
            if (error || !char?.value) return;
            const rawBytes = base64ToBytes(char.value);
            const ranges: number[] = [];
            for (let i = 0; i + 1 < rawBytes.length; i += 2) {
              ranges.push(rawBytes[i] | (rawBytes[i + 1] << 8));
            }
            this.volumeRanges = ranges;
            console.log(`[PhilipsAdapter] Volume ranges notify: [${ranges.join(', ')}]`);
          },
        );
        console.log('[PhilipsAdapter] Subscribed to POLARIS volume ranges notifications');
      } catch {
        console.log('[PhilipsAdapter] POLARIS volume ranges subscription not available');
      }

      // Subscribe to streaming volume (50632720) for state tracking
      try {
        this.device.monitorCharacteristicForService(
          POLARIS_SERVICE,
          STREAMING_VOLUME_CHAR,
          (error, char) => {
            if (error || !char?.value) return;
            const bytes = base64ToBytes(char.value);
            console.log(`[PhilipsAdapter] Streaming volume notify: [${bytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
          },
        );
        console.log('[PhilipsAdapter] Subscribed to POLARIS streaming volume notifications');
      } catch {
        console.log('[PhilipsAdapter] POLARIS streaming volume subscription not available');
      }
    }

    console.log('[PhilipsAdapter] Connection setup complete');
  }

  async disconnect(): Promise<void> {
    console.log('[PhilipsAdapter] Disconnecting...');
    if (this.hlCommandSub) {
      this.hlCommandSub.remove();
      this.hlCommandSub = null;
    }
    if (this.volumeNotifySub) {
      this.volumeNotifySub.remove();
      this.volumeNotifySub = null;
    }
    if (this.programNotifySub) {
      this.programNotifySub.remove();
      this.programNotifySub = null;
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
    console.log('[PhilipsAdapter] Disconnected');
  }

  /** Clamp a volume level to the device's reported UINT16 range (if known). */
  private clampVolume(level: number, channel: 'main' | 'streaming' | 'tinnitus'): number {
    const rounded = Math.max(0, Math.min(100, Math.round(level)));
    if (!this.volumeRanges) return rounded;
    // volumeRanges layout (UINT16 LE pairs): [mainMin, mainMax, streamMin, streamMax, tinnitusMin, tinnitusMax]
    const offset = channel === 'main' ? 0 : channel === 'streaming' ? 2 : 4;
    if (this.volumeRanges.length > offset + 1) {
      return Math.max(this.volumeRanges[offset], Math.min(this.volumeRanges[offset + 1], rounded));
    }
    return rounded;
  }

  /**
   * Set main hearing aid volume.
   * POLARIS path: writes UINT16 level (LE) + UINT16 mute=1 (LE) to 1454e9d6.
   * HearLink path: writes same format to command char (43c8465e) — inferred.
   * Per-ear control requires connecting to each device independently.
   */
  async setVolume(level: number, _ear?: 'left' | 'right' | 'both'): Promise<void> {
    const dev = this.connected;
    const clamped = this.clampVolume(level, 'main');
    // 4 bytes: UINT16 level LE + UINT16 mute LE (1=unmuted)
    const payload = [clamped & 0xFF, (clamped >> 8) & 0xFF, 1, 0];
    console.log(`[PhilipsAdapter] setVolume(${clamped}) -> [${payload.join(', ')}]`);

    if (this.useHearLink) {
      await withRetry(() =>
        dev.writeCharacteristicWithResponseForService(
          HEARLINK_SERVICE,
          HL_COMMAND_CHAR,
          bytesToBase64(payload),
        ),
      );
    } else {
      await withRetry(() =>
        dev.writeCharacteristicWithoutResponseForService(
          POLARIS_SERVICE,
          MAIN_VOLUME_CHAR,
          bytesToBase64(payload),
        ),
      );
    }
    this.lastKnownVolume = clamped;
  }

  async getVolume(): Promise<number> {
    const dev = this.connected;

    if (this.useHearLink) {
      // HearLink: read state char (e6c02a45). Bytes[8..10] appear to be volume levels
      // based on probe data (all 0x80 = midpoint on fresh device).
      try {
        const char = await withRetry(() =>
          dev.readCharacteristicForService(HEARLINK_SERVICE, HL_STATE_CHAR),
        );
        if (char.value) {
          const bytes = base64ToBytes(char.value);
          const vol = bytes.length > 8 ? bytes[8] : 0;
          console.log(`[PhilipsAdapter] HearLink getVolume: ${vol} (from state char)`);
          this.lastKnownVolume = vol;
          return vol;
        }
      } catch {
        console.log('[PhilipsAdapter] HearLink state read failed, using lastKnownVolume');
      }
      return this.lastKnownVolume;
    }

    try {
      const char = await withRetry(() =>
        dev.readCharacteristicForService(POLARIS_SERVICE, MAIN_VOLUME_CHAR),
      );
      if (char.value) {
        const bytes = base64ToBytes(char.value);
        if (bytes.length >= 2) {
          this.lastKnownVolume = bytes[0] | (bytes[1] << 8);
        }
        if (bytes.length >= 4) {
          this.lastKnownMute = (bytes[2] | (bytes[3] << 8)) === 0;
        }
        console.log(`[PhilipsAdapter] POLARIS getVolume: level=${this.lastKnownVolume}, mute=${this.lastKnownMute}`);
        return this.lastKnownVolume;
      }
    } catch {
      console.log('[PhilipsAdapter] POLARIS volume read failed, using lastKnownVolume');
    }
    return this.lastKnownVolume;
  }

  /**
   * Set mute state.
   * Mute: write [0, 0, 0, 0] (UINT16 level=0 + UINT16 mute=0).
   * Unmute: write [level_lo, level_hi, 1, 0] (restore volume, mute=1).
   */
  async setMute(muted: boolean): Promise<void> {
    const dev = this.connected;
    console.log(`[PhilipsAdapter] setMute(${muted})`);
    this.lastKnownMute = muted;

    let payload: number[];
    if (muted) {
      payload = [0, 0, 0, 0];
    } else {
      const currentLevel = this.lastKnownVolume > 0 ? this.lastKnownVolume : 50;
      payload = [currentLevel & 0xFF, (currentLevel >> 8) & 0xFF, 1, 0];
    }

    if (this.useHearLink) {
      await withRetry(() =>
        dev.writeCharacteristicWithResponseForService(
          HEARLINK_SERVICE,
          HL_COMMAND_CHAR,
          bytesToBase64(payload),
        ),
      );
    } else {
      await withRetry(() =>
        dev.writeCharacteristicWithoutResponseForService(
          POLARIS_SERVICE,
          MAIN_VOLUME_CHAR,
          bytesToBase64(payload),
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

    try {
      const char = await withRetry(() =>
        dev.readCharacteristicForService(POLARIS_SERVICE, MAIN_VOLUME_CHAR),
      );
      if (char.value) {
        const bytes = base64ToBytes(char.value);
        const muted = bytes.length >= 4 ? (bytes[2] | (bytes[3] << 8)) === 0 : false;
        this.lastKnownMute = muted;
        console.log(`[PhilipsAdapter] getMute: ${muted}`);
        return muted;
      }
    } catch {
      console.log('[PhilipsAdapter] POLARIS mute read failed, using lastKnownMute');
    }
    return this.lastKnownMute;
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
    console.log(`[PhilipsAdapter] setProgram(${index})`);

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
    this.lastKnownProgram = index;
  }

  async getProgram(): Promise<number> {
    const dev = this.connected;

    if (this.useHearLink) {
      // HearLink: program index not yet mapped in state char — return tracked state.
      // TODO: Identify which byte in HL_STATE_CHAR encodes active program.
      return this.lastKnownProgram;
    }

    try {
      const char = await withRetry(() =>
        dev.readCharacteristicForService(POLARIS_SERVICE, PROGRAM_SELECT_CHAR),
      );
      if (char.value) {
        const prog = base64ToBytes(char.value)[0];
        this.lastKnownProgram = prog;
        console.log(`[PhilipsAdapter] getProgram: ${prog}`);
        return prog;
      }
    } catch {
      console.log('[PhilipsAdapter] POLARIS program read failed, using lastKnownProgram');
    }
    return this.lastKnownProgram;
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
      const level = base64ToBytes(char.value)[0]; // BAS: single byte 0-100
      console.log(`[PhilipsAdapter] Battery: ${level}%`);
      return level;
    } catch {
      console.log('[PhilipsAdapter] Battery read failed');
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
   * Same 4-byte format as main volume: UINT16 level LE + UINT16 mute LE.
   */
  async setStreamingVolume(level: number): Promise<void> {
    const dev = this.connected;
    const clamped = this.clampVolume(level, 'streaming');
    const payload = [clamped & 0xFF, (clamped >> 8) & 0xFF, 1, 0];
    console.log(`[PhilipsAdapter] setStreamingVolume(${clamped}) -> [${payload.join(', ')}]`);

    await withRetry(() =>
      dev.writeCharacteristicWithoutResponseForService(
        POLARIS_SERVICE,
        STREAMING_VOLUME_CHAR,
        bytesToBase64(payload),
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
    console.log(`[PhilipsAdapter] setTinnitusVolume(${clamped})`);

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
      // POLARIS: read main volume + mute (4-byte UINT16 LE format)
      try {
        const volChar = await withRetry(() =>
          dev.readCharacteristicForService(POLARIS_SERVICE, MAIN_VOLUME_CHAR),
        );
        if (volChar.value) {
          const bytes = base64ToBytes(volChar.value);
          if (bytes.length >= 2) {
            volume = bytes[0] | (bytes[1] << 8);
          }
          if (bytes.length >= 4) {
            muted = (bytes[2] | (bytes[3] << 8)) === 0;
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
