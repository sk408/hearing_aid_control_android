/**
 * ReSound / GN Hearing BLE adapter
 *
 * Protocol reference: SPEC.md §2.4, command_dictionary.md, resound_uuid_reference_master
 *
 * ── CONFIRMED paths ──
 *
 *   ASHA volume:    00e4ca9e-ab14-41e4-8823-f9e70c7e91df
 *                   Signed int8 [-128..0] where 0 = max, -128 = min/mute.
 *                   Property: WRITE_NO_RESP (not WRITE).
 *                   Primary volume control path.
 *
 *   MFi HAP service (7d74f4bd-c74a-4431-862c-cce884371592):
 *     Program name:  7be94a55-8d91-4592-bc0f-ea3664ccd3a9  R/W  — UTF-8 current program name
 *     Program count: 7a62b786-f2ef-4afb-9aa8-81cc62a25862  R/N  — uint8
 *     Ear side:      8d17ac2f-1d54-4742-a49a-ef4b20784eb3  R    — 0=left, 1=right
 *
 *   ReSound service (a53062b9-7dfd-446c-bca5-1e13269560bd):
 *     Battery:       539e6ea0-31e5-485a-a5a2-39fb763f0e08  R/N  — GN_BATTERY enum
 *     Program count: 7a62b786-f2ef-4afb-9aa8-81cc62a25862  R/N  — uint8
 *
 *   GN Battery enum: 1=low(5%), 5=prev_low(30%), 10=OK(100%).
 *   GN Side: 0=left, 1=right.
 *
 * ── GN Handle Protocol (confirmed response format) ──
 *
 *   Success: [0x03, handle, data_len, ...data]
 *   Error:   [0x08, 0x04, handle, 0x81] (0x81 = not permitted)
 *
 *   Confirmed readable handles:
 *     0x02 → 1 byte
 *     0x03 → 7 bytes (obfuscated program list)
 *     0x04 → 7 bytes (obfuscated program list)
 *     0x14 → 1 byte = 0x05
 *     0x1a → 8 bytes
 *
 * ── PARTIAL / UNCONFIRMED paths ──
 *
 *   GN Command:     1959a468-3234-4c18-9e78-8daf8d9dbf61
 *   GN Notify:      8b51a2ca-5bed-418b-b54b-22fe666aadd2
 *
 *   GN command frame protocol (confirmed framing, unconfirmed handle IDs):
 *     write handle:  [0x03, handleLow, payload...]
 *     read handle:   [0x04, handleLow]
 *     read blob:     [0x05, handleLow, 0x00, 0x00]
 *     discover:      [0x06]
 *
 *   Candidate handle IDs (from command_dictionary.md — PARTIAL confidence):
 *     0x05 = GNMicAttenuation      — [0x03, 0x05, program, attenuation]
 *     0x06 = GNStreamAttenuation   — [0x03, 0x06, program, attenuation]
 *     0x08 = GNCurrentActiveProgram — [0x03, 0x08, programIndex]
 *     0x15 = GNStreamStatus (read) — [0x04, 0x15]
 *
 *   Direct characteristic UUIDs (from service description XMLs — whether
 *   these are directly R/W or only accessible via handle tunnel is UNKNOWN):
 *     GNMicAttenuation:       32c9322d-6b17-11cf-0234-6f0da5eafd75  (0=mute, 1..255)
 *     GNStreamAttenuation:    054e99c7-ff34-1c12-59cd-e2c20d2e6743  (0=mute, 1..255)
 *     GNCurrentActiveProgram: dc82f820-63ac-f82f-1e89-372fde4151f4
 *     GNHiState:              8d552f91-15d0-4628-a03f-1a64fc88fa51
 *     GNFeatureSupport:       650c3a00-cb6d-467d-a20b-3544f189d8af  (4-byte bitfield)
 *
 * Status: HA gain uses GN mic attenuation (UUID / handle 0x05) when exposed;
 *         ASHA volume is fallback (streaming-oriented). Program: GNCurrentActiveProgram
 *         direct write or [0x03,0x08,idx]. Official app may encrypt GN command frames —
 *         if writes are rejected, capture plaintext/encrypt boundary (phase3 docs).
 */
import type { Device } from 'react-native-ble-plx';
import { getBleManager } from '../ble/BleManager';
import type { HearingAidAdapter, DriverState } from './types';
import type { DeviceInfo, Feature, Program } from '../ble/types';

// ── ASHA service + volume (CONFIRMED — SPEC.md §2.4, command_dictionary.md) ──

const ASHA_SERVICE = '0000fdf0-0000-1000-8000-00805f9b34fb';
const ASHA_VOLUME_CHAR = '00e4ca9e-ab14-41e4-8823-f9e70c7e91df';

// ── GN proprietary service (SPEC.md §2.4) ──

const GN_SERVICE = 'e0262760-08c2-11e1-9073-0e8ac72ea010';
const GN_COMMAND_CHAR = '1959a468-3234-4c18-9e78-8daf8d9dbf61';
const GN_NOTIFY_CHAR = '8b51a2ca-5bed-418b-b54b-22fe666aadd2';

// ── MFi HAP service (live BLE discovery — CONFIRMED) ──

const MFIHAP_SERVICE = '7d74f4bd-c74a-4431-862c-cce884371592';
const MFIHAP_PROGRAM_NAME_CHAR = '7be94a55-8d91-4592-bc0f-ea3664ccd3a9';
const MFIHAP_PROGRAM_COUNT_CHAR = '7a62b786-f2ef-4afb-9aa8-81cc62a25862';
const MFIHAP_SIDE_CHAR = '8d17ac2f-1d54-4742-a49a-ef4b20784eb3';

// ── ReSound proprietary service (live BLE discovery — CONFIRMED) ──

const RESOUND_SERVICE = 'a53062b9-7dfd-446c-bca5-1e13269560bd';
const RESOUND_BATTERY_CHAR = '539e6ea0-31e5-485a-a5a2-39fb763f0e08';

// ── GN direct-read characteristics (resound_uuid_reference_master — confirmed semantics) ──

const GN_BATTERY_CHAR = '86e2c601-d90a-2628-19b9-bdb38d5c7cf0';
const GN_SIDE_CHAR = '8d17ac2f-1d54-4742-a49a-ef4b20784eb3';
const GN_ACTIVE_PROGRAM_CHAR = 'dc82f820-63ac-f82f-1e89-372fde4151f4';
/** GN security capability — trust bootstrap per resound_phase2_static.md §5 */
const GN_SECURITY_CAP_CHAR = '12257119-ddcb-4a12-9a08-1cd4df7921bb';
/** Microphone / HA gain (not streaming-only ASHA volume) — Dooku3 handle 0x05 */
const GN_MIC_ATTENUATION_CHAR = '32c9322d-6b17-11cf-0234-6f0da5eafd75';

// ── Standard BLE Battery Service ──

const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';

// ── Retry config ──

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// ── Base64 helpers (from philipsAdapter.ts) ──

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

// ── Adapter ──

export class ResoundAdapter implements HearingAidAdapter {
  readonly brand = 'resound' as const;

  private device: Device | null = null;
  private deviceId: string | null = null;
  private notifySubscription: { remove: () => void } | null = null;
  private preMuteVolume = 50;
  /** GN trust byte sequence written once per connection when the characteristic exists */
  private gnTrustBootstrapDone = false;

  /** Characteristic UUID (lowercase) → parent service UUID, built during connect */
  private charServiceMap = new Map<string, string>();

  /** GN notify data handler — replaced temporarily during discover() */
  private onGnNotify: (data: number[]) => void = () => {};

  private get connected(): Device {
    if (!this.device) {
      throw new Error('ResoundAdapter: not connected — call connect() first');
    }
    return this.device;
  }

  // ── Connection ──

  async connect(deviceId: string): Promise<void> {
    const manager = getBleManager();
    this.deviceId = deviceId;

    this.device = await withRetry(() =>
      manager.connectToDevice(deviceId, { requestMTU: 512 }),
    );

    await this.device.discoverAllServicesAndCharacteristics();
    await this.buildCharacteristicMap();

    // Trigger Android bonding dialog by reading a secured ASHA characteristic.
    // If the device is already bonded this is a no-op; if not, Android will
    // prompt the user to pair.
    try {
      await manager.readCharacteristicForDevice(
        deviceId,
        ASHA_SERVICE,
        '6333651e-c481-4a3e-9169-7c902aad37bb',
      );
      console.log('[ResoundAdapter] Device bonded/trusted');
    } catch (e) {
      console.log('[ResoundAdapter] Bonding may be needed:', e);
    }

    await this.setupGnNotify();
  }

  async disconnect(): Promise<void> {
    if (this.notifySubscription) {
      this.notifySubscription.remove();
      this.notifySubscription = null;
    }
    if (this.device) {
      try {
        await this.device.cancelConnection();
      } catch {
        // Device may already be disconnected
      }
      this.device = null;
      this.deviceId = null;
      this.charServiceMap.clear();
      this.gnTrustBootstrapDone = false;
    }
  }

  // ── Volume ──
  //
  // Primary: GN mic attenuation (Dooku3 handle 0x05 / UUID 32c9322d…) — HA gain.
  // Fallback: ASHA int8 volume — streaming-oriented; used when GN path is unavailable.

  async setVolume(level: number, _ear?: 'left' | 'right' | 'both'): Promise<void> {
    const clampedLevel = Math.max(0, Math.min(100, level));
    await this.ensureGnTrustBootstrap();

    const attenuation =
      clampedLevel <= 0
        ? 0
        : Math.max(1, Math.min(255, Math.round((clampedLevel / 100) * 255)));

    let program = await this.readRawActiveProgramIndex();
    if (program === null) program = 0;

    const micKey = GN_MIC_ATTENUATION_CHAR.toLowerCase();
    if (this.charServiceMap.has(micKey)) {
      const svc = this.findService(GN_MIC_ATTENUATION_CHAR);
      try {
        await this.writeCharacteristicBothModes(svc, GN_MIC_ATTENUATION_CHAR, [
          program,
          attenuation,
        ]);
        return;
      } catch {
        try {
          await this.writeCharacteristicBothModes(svc, GN_MIC_ATTENUATION_CHAR, [
            attenuation,
          ]);
          return;
        } catch {
          // try command tunnel
        }
      }
    }

    try {
      await this.writeGnCommandFrame([0x03, 0x05, program, attenuation]);
      return;
    } catch {
      // ASHA fallback
    }

    await this.setVolumeAsha(clampedLevel);
  }

  private async setVolumeAsha(level: number): Promise<void> {
    const dev = this.connected;
    const ashaLevel = Math.round((level / 100) * 128) - 128;
    const clamped = Math.max(-128, Math.min(0, ashaLevel));
    const byte = clamped & 0xff;

    const serviceUUID = this.findService(ASHA_VOLUME_CHAR);
    await withRetry(() =>
      dev.writeCharacteristicWithoutResponseForService(
        serviceUUID,
        ASHA_VOLUME_CHAR,
        bytesToBase64([byte]),
      ),
    );
  }

  async getVolume(): Promise<number> {
    const micKey = GN_MIC_ATTENUATION_CHAR.toLowerCase();
    if (this.charServiceMap.has(micKey)) {
      try {
        const char = await withRetry(() =>
          this.connected.readCharacteristicForService(
            this.findService(GN_MIC_ATTENUATION_CHAR),
            GN_MIC_ATTENUATION_CHAR,
          ),
        );
        if (char.value) {
          const b = base64ToBytes(char.value);
          const att = b.length >= 2 ? b[b.length - 1] : b[0];
          if (att === 0) return 0;
          return Math.round((att / 255) * 100);
        }
      } catch {
        // ASHA
      }
    }

    const dev = this.connected;
    const serviceUUID = this.findService(ASHA_VOLUME_CHAR);
    const char = await withRetry(() =>
      dev.readCharacteristicForService(serviceUUID, ASHA_VOLUME_CHAR),
    );
    if (!char.value) throw new Error('No value from ASHA volume characteristic');
    const raw = base64ToBytes(char.value)[0];
    const signed = raw > 127 ? raw - 256 : raw;
    return Math.round(((signed + 128) / 128) * 100);
  }

  // ── Mute (ASHA emulation — volume to -128 for mute) ──

  async setMute(muted: boolean): Promise<void> {
    if (muted) {
      try {
        this.preMuteVolume = await this.getVolume();
      } catch {
        // Keep default pre-mute volume
      }
      await this.setVolume(0);
    } else {
      await this.setVolume(this.preMuteVolume);
    }
  }

  async getMute(): Promise<boolean> {
    const volume = await this.getVolume();
    return volume === 0;
  }

  // ── Program (GN — resound_phase2_static.md §6.3) ──
  //
  // Try direct GNCurrentActiveProgram GATT write, then command frame [0x03, 0x08, idx].

  async setProgram(index: number): Promise<void> {
    const idx = ((Math.floor(index) % 256) + 256) % 256;
    await this.ensureGnTrustBootstrap();

    const progKey = GN_ACTIVE_PROGRAM_CHAR.toLowerCase();
    if (this.charServiceMap.has(progKey)) {
      const svc = this.findService(GN_ACTIVE_PROGRAM_CHAR);
      try {
        await this.writeCharacteristicBothModes(svc, GN_ACTIVE_PROGRAM_CHAR, [idx]);
        return;
      } catch {
        // command tunnel
      }
    }

    await this.writeGnCommandFrame([0x03, 0x08, idx]);
  }

  async getProgram(): Promise<number> {
    const raw = await this.readRawActiveProgramIndex();
    if (raw !== null) return raw;

    const programs = await this.getPrograms();
    const currentName = await this.getCurrentProgramName();
    if (currentName) {
      const match = programs.find((p) => p.name === currentName);
      if (match) return match.index;
    }
    return 0;
  }

  /**
   * Read the current active program name from MFi HAP service.
   * Returns UTF-8 string (e.g. "All-Around") or null if unavailable.
   */
  async getCurrentProgramName(): Promise<string | null> {
    const serviceUUID = this.findService(MFIHAP_PROGRAM_NAME_CHAR);
    try {
      const char = await withRetry(() =>
        this.connected.readCharacteristicForService(
          serviceUUID,
          MFIHAP_PROGRAM_NAME_CHAR,
        ),
      );
      if (!char.value) return null;
      const bytes = base64ToBytes(char.value);
      return String.fromCharCode(...bytes);
    } catch {
      return null;
    }
  }

  async getPrograms(): Promise<Program[]> {
    // Read program count from MFi HAP service (confirmed via live BLE discovery).
    // Individual program names are not enumerable — only the current program
    // name is readable via MFIHAP_PROGRAM_NAME_CHAR. Return generic names.
    let count = 4; // default
    const serviceUUID = this.findService(MFIHAP_PROGRAM_COUNT_CHAR);
    try {
      const char = await withRetry(() =>
        this.connected.readCharacteristicForService(
          serviceUUID,
          MFIHAP_PROGRAM_COUNT_CHAR,
        ),
      );
      if (char.value) {
        count = base64ToBytes(char.value)[0];
      }
    } catch {
      // Use default count
    }

    const currentName = await this.getCurrentProgramName();
    const currentIndex = (await this.readRawActiveProgramIndex()) ?? 0;

    const programs: Program[] = [];
    for (let i = 0; i < count; i++) {
      programs.push({
        index: i,
        name: i === currentIndex && currentName ? currentName : `Program ${i + 1}`,
      });
    }
    return programs;
  }

  // ── Battery ──

  async getBattery(): Promise<number> {
    const dev = this.connected;

    // Primary: ReSound service battery characteristic (confirmed via live BLE discovery)
    const resoundBatteryService = this.findService(RESOUND_BATTERY_CHAR);
    try {
      const char = await withRetry(() =>
        dev.readCharacteristicForService(resoundBatteryService, RESOUND_BATTERY_CHAR),
      );
      if (char.value) {
        const raw = base64ToBytes(char.value)[0];
        return gnBatteryToPercent(raw);
      }
    } catch {
      // ReSound battery not readable — try legacy GN battery
    }

    // Fallback: legacy GN battery characteristic
    const gnBatteryService = this.charServiceMap.get(GN_BATTERY_CHAR);
    if (gnBatteryService) {
      try {
        const char = await withRetry(() =>
          dev.readCharacteristicForService(gnBatteryService, GN_BATTERY_CHAR),
        );
        if (char.value) {
          const raw = base64ToBytes(char.value)[0];
          return gnBatteryToPercent(raw);
        }
      } catch {
        // GN battery not readable — try standard BAS
      }
    }

    // Fallback: standard BLE Battery Service (0x180F)
    try {
      const char = await withRetry(() =>
        dev.readCharacteristicForService(BATTERY_SERVICE, BATTERY_LEVEL_CHAR),
      );
      if (!char.value) return -1;
      return base64ToBytes(char.value)[0];
    } catch {
      return -1;
    }
  }

  // ── Streaming volume (ASHA = streaming volume) ──

  async setStreamingVolume(level: number): Promise<void> {
    await this.setVolume(level);
  }

  // ── GN Discover ──

  /**
   * Send the GN discover frame [0x06] and log the response.
   *
   * This is the critical first step for mapping the proprietary protocol:
   *   connect → discover() → log response → correlate handles with known
   *   characteristic UUIDs from service description XMLs.
   *
   * The response (on GN Notify) should enumerate available handle IDs
   * that can then be read/written via [0x03, handle, ...] and [0x04, handle].
   *
   * Returns the raw response bytes for analysis.
   */
  async discover(): Promise<number[]> {
    const dev = this.connected;
    const commandService = this.findService(GN_COMMAND_CHAR);

    await this.setupGnNotify();

    const responses: number[][] = [];

    const collectPromise = new Promise<void>((resolve) => {
      let settled = false;
      let packetTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (settled) return;
        settled = true;
        this.onGnNotify = () => {};
        resolve();
      };

      // Overall timeout — resolve even if no response arrives
      setTimeout(finish, 3000);

      this.onGnNotify = (data: number[]) => {
        responses.push(data);
        if (packetTimer !== undefined) clearTimeout(packetTimer);
        packetTimer = setTimeout(finish, 500);
      };
    });

    // Send discover frame
    await withRetry(() =>
      dev.writeCharacteristicWithResponseForService(
        commandService,
        GN_COMMAND_CHAR,
        bytesToBase64([0x06]),
      ),
    );

    await collectPromise;

    const allBytes = responses.flat();
    const hex = (b: number) => '0x' + b.toString(16).padStart(2, '0');

    console.log(
      '[ResoundAdapter] discover() response:',
      allBytes.map(hex).join(' '),
    );
    for (let i = 0; i < responses.length; i++) {
      console.log(
        `[ResoundAdapter]   packet ${i}:`,
        responses[i].map(hex).join(' '),
      );
    }

    return allBytes;
  }

  // ── GN Proprietary Stubs ──

  /**
   * Write microphone volume via GN handle protocol.
   *
   * NOT IMPLEMENTED — handle 0x05 (GNMicAttenuation) unconfirmed.
   *
   * Candidate frame: [0x03, 0x05, currentProgram, attenuation]
   *   attenuation: 0 = mute, 1..255 = volume level
   *
   * Requires:
   *   1. discover() to verify handle 0x05 exists
   *   2. Determine whether currentProgram byte is needed (profile-dependent:
   *      1-byte in Palpatine6, 2-byte in Dooku/Mystique — see uuid_reference)
   *   3. nRF Sniffer capture to confirm frame shape
   *
   * Use setVolume() (ASHA path) as confirmed alternative.
   */
  async setVolumeGnProprietary(
    _level: number,
    _currentProgram: number,
  ): Promise<void> {
    throw new Error(
      'ResoundAdapter.setVolumeGnProprietary: handle 0x05 not confirmed. ' +
      'Use setVolume() for ASHA path.',
    );
  }

  /**
   * Write streaming volume via GN handle protocol.
   *
   * NOT IMPLEMENTED — handle 0x06 (GNStreamAttenuation) unconfirmed.
   *
   * Candidate frame: [0x03, 0x06, currentProgram, attenuation]
   *
   * Use setStreamingVolume() (ASHA path) as confirmed alternative.
   */
  async setStreamingVolumeGnProprietary(
    _level: number,
    _currentProgram: number,
  ): Promise<void> {
    throw new Error(
      'ResoundAdapter.setStreamingVolumeGnProprietary: handle 0x06 not confirmed. ' +
      'Use setStreamingVolume() for ASHA path.',
    );
  }

  /**
   * Read which side (left/right) this device is.
   * Uses MFi HAP side characteristic (confirmed via live BLE discovery: 0=left, 1=right).
   * Falls back to GN service if MFi HAP is unavailable.
   */
  async getSide(): Promise<'left' | 'right' | null> {
    // Primary: MFi HAP service (confirmed via live BLE discovery)
    const mfihapService = this.findService(MFIHAP_SIDE_CHAR);
    try {
      const char = await withRetry(() =>
        this.connected.readCharacteristicForService(mfihapService, MFIHAP_SIDE_CHAR),
      );
      if (char.value) {
        const raw = base64ToBytes(char.value)[0];
        return raw === 0 ? 'left' : 'right';
      }
    } catch {
      // MFi HAP side not readable — try legacy GN service
    }

    // Fallback: legacy GN service (same UUID, different service)
    const gnSideService = this.charServiceMap.get(GN_SIDE_CHAR);
    if (gnSideService && gnSideService !== mfihapService) {
      try {
        const char = await withRetry(() =>
          this.connected.readCharacteristicForService(gnSideService, GN_SIDE_CHAR),
        );
        if (char.value) {
          const raw = base64ToBytes(char.value)[0];
          return raw === 0 ? 'left' : 'right';
        }
      } catch {
        // Side read failed
      }
    }

    return null;
  }

  // ── State ──

  async refreshState(): Promise<DriverState> {
    let volume: number | undefined;
    let muted: boolean | undefined;
    try {
      volume = await this.getVolume();
      muted = volume === 0;
    } catch {
      // ASHA volume read failed
    }

    let activeProgram: number | undefined;
    try {
      activeProgram = await this.getProgram();
    } catch {
      // Program read failed
    }

    const batteryPercent = await this.getBattery().catch(() => undefined);
    const side = await this.getSide().catch(() => null);

    let deviceInfo: DeviceInfo | undefined;
    if (this.device) {
      deviceInfo = {
        id: this.deviceId!,
        name: this.device.name ?? 'ReSound Hearing Aid',
        brand: 'resound',
        side: side ?? undefined,
      };
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
    // Confirmed features:
    //   volume:  GN mic attenuation + ASHA fallback
    //   mute:    GN attenuation 0 + ASHA min
    //   battery: ReSound service battery (confirmed via live BLE discovery)
    //   program: GN active program + MFi HAP metadata
    //
    // NOT included until validated on hardware:
    //   streaming: dedicated stream attenuation handle 0x06
    //   balance, tinnitus, eq: no known path
    return ['volume', 'mute', 'battery', 'program'];
  }

  // ── Private helpers ──

  /**
   * Build characteristic UUID → parent service UUID map.
   * Called once during connect after full service/characteristic discovery.
   * This lets us dynamically resolve which service owns each characteristic,
   * since the ASHA volume char and GN chars may live under different services.
   */
  private async buildCharacteristicMap(): Promise<void> {
    const dev = this.connected;
    try {
      const services = await dev.services();
      for (const service of services) {
        try {
          const chars = await service.characteristics();
          for (const char of chars) {
            this.charServiceMap.set(char.uuid.toLowerCase(), service.uuid);
          }
        } catch {
          // Some services may not expose readable characteristics
        }
      }
    } catch {
      // Service enumeration failed — will rely on hardcoded service UUIDs
    }
  }

  /**
   * Find the parent service UUID for a characteristic.
   * Uses discovery cache, falls back to known service UUIDs.
   */
  private findService(charUUID: string): string {
    const cached = this.charServiceMap.get(charUUID.toLowerCase());
    if (cached) return cached;

    if (charUUID === ASHA_VOLUME_CHAR) return ASHA_SERVICE;
    if (charUUID === BATTERY_LEVEL_CHAR) return BATTERY_SERVICE;
    if (charUUID === RESOUND_BATTERY_CHAR) return RESOUND_SERVICE;
    if (
      charUUID === MFIHAP_PROGRAM_NAME_CHAR ||
      charUUID === MFIHAP_PROGRAM_COUNT_CHAR ||
      charUUID === MFIHAP_SIDE_CHAR
    ) {
      return MFIHAP_SERVICE;
    }
    return GN_SERVICE;
  }

  private async readRawActiveProgramIndex(): Promise<number | null> {
    const key = GN_ACTIVE_PROGRAM_CHAR.toLowerCase();
    if (!this.charServiceMap.has(key)) return null;
    try {
      const char = await withRetry(() =>
        this.connected.readCharacteristicForService(
          this.findService(GN_ACTIVE_PROGRAM_CHAR),
          GN_ACTIVE_PROGRAM_CHAR,
        ),
      );
      if (!char.value) return null;
      return base64ToBytes(char.value)[0];
    } catch {
      return null;
    }
  }

  /**
   * GN trust bootstrap from resound_phase2_static.md §5 + protocol_frames §7.
   * Best-effort; required for some firmware builds before handle writes succeed.
   */
  private async ensureGnTrustBootstrap(): Promise<void> {
    if (this.gnTrustBootstrapDone) return;
    this.gnTrustBootstrapDone = true;

    const key = GN_SECURITY_CAP_CHAR.toLowerCase();
    if (!this.charServiceMap.has(key)) return;

    const svc = this.findService(GN_SECURITY_CAP_CHAR);
    const payload = bytesToBase64([4, 0, 0, 0, 0]);
    try {
      await withRetry(async () => {
        try {
          await this.connected.writeCharacteristicWithResponseForService(
            svc,
            GN_SECURITY_CAP_CHAR,
            payload,
          );
        } catch {
          await this.connected.writeCharacteristicWithoutResponseForService(
            svc,
            GN_SECURITY_CAP_CHAR,
            payload,
          );
        }
      });
    } catch (e) {
      console.log('[ResoundAdapter] GN trust bootstrap skipped:', e);
    }
  }

  private async writeCharacteristicBothModes(
    serviceUUID: string,
    charUUID: string,
    bytes: number[],
  ): Promise<void> {
    const b64 = bytesToBase64(bytes);
    const dev = this.connected;
    try {
      await withRetry(() =>
        dev.writeCharacteristicWithResponseForService(
          serviceUUID,
          charUUID,
          b64,
        ),
      );
      return;
    } catch {
      await withRetry(() =>
        dev.writeCharacteristicWithoutResponseForService(
          serviceUUID,
          charUUID,
          b64,
        ),
      );
    }
  }

  private async writeGnCommandFrame(frame: number[]): Promise<void> {
    const cmdSvc = this.findService(GN_COMMAND_CHAR);
    const b64 = bytesToBase64(frame);
    const dev = this.connected;
    try {
      await withRetry(() =>
        dev.writeCharacteristicWithResponseForService(
          cmdSvc,
          GN_COMMAND_CHAR,
          b64,
        ),
      );
    } catch {
      await withRetry(() =>
        dev.writeCharacteristicWithoutResponseForService(
          cmdSvc,
          GN_COMMAND_CHAR,
          b64,
        ),
      );
    }
  }

  /**
   * Subscribe to GN Notify for handle-based response data.
   * Idempotent — will not double-subscribe.
   */
  private async setupGnNotify(): Promise<void> {
    if (this.notifySubscription) return;

    const dev = this.connected;
    const serviceUUID = this.findService(GN_NOTIFY_CHAR);

    try {
      this.notifySubscription = dev.monitorCharacteristicForService(
        serviceUUID,
        GN_NOTIFY_CHAR,
        (error, characteristic) => {
          if (error) {
            console.warn('[ResoundAdapter] GN notify error:', error.message);
            return;
          }
          if (characteristic?.value) {
            const data = base64ToBytes(characteristic.value);
            console.log(
              '[ResoundAdapter] GN notify:',
              data.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' '),
            );
            this.onGnNotify(data);
          }
        },
      );
    } catch {
      console.warn(
        '[ResoundAdapter] GN notify subscription failed — handle protocol unavailable',
      );
    }
  }
}

// ── Utility ──

/**
 * Map GN battery enum to 0-100 percentage.
 * Confirmed values (live BLE discovery + resound_uuid_reference_master):
 *   1  = Low battery        →  5%
 *   5  = Previously low     → 30%
 *   10 = Battery OK         → 100%
 */
function gnBatteryToPercent(raw: number): number {
  if (raw <= 1) return 5;
  if (raw <= 5) return 30;
  if (raw >= 10) return 100;
  return Math.round((raw / 10) * 100);
}
