/**
 * ReSound / GN Hearing BLE adapter
 *
 * Protocol reference: SPEC.md §2.4, command_dictionary.md, resound_uuid_reference_master
 *
 * ── CONFIRMED paths ──
 *
 *   ASHA volume:    00e4ca9e-ab14-41e4-8823-f9e70c7e91df
 *                   Signed int8 [-128..0] where 0 = max, -128 = min/mute.
 *                   Primary volume control path.
 *
 *   GN Battery:     86e2c601-d90a-2628-19b9-bdb38d5c7cf0
 *                   Enum: 1 = low, 5 = previously low, 10 = OK.
 *
 *   GN Side (L/R):  8d17ac2f-1d54-4742-a49a-ef4b20784eb3
 *                   0 = left, 1 = right.
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
 * Status: ASHA volume is the confirmed primary volume path.
 *         GN proprietary control requires live handle discovery + validation.
 *         Use discover() to enumerate available handles on a connected device.
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

// ── GN direct-read characteristics (resound_uuid_reference_master — confirmed semantics) ──

const GN_BATTERY_CHAR = '86e2c601-d90a-2628-19b9-bdb38d5c7cf0';
const GN_SIDE_CHAR = '8d17ac2f-1d54-4742-a49a-ef4b20784eb3';
const GN_ACTIVE_PROGRAM_CHAR = 'dc82f820-63ac-f82f-1e89-372fde4151f4';

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
    }
  }

  // ── Volume (ASHA path — CONFIRMED) ──
  //
  // ASHA volume characteristic: signed int8 [-128..0]
  //   0    = maximum volume
  //   -128 = minimum / mute
  //
  // Note: ASHA volume controls the streaming audio volume, not the
  // hearing aid microphone gain. Microphone volume requires the GN
  // handle protocol (handle 0x05, unconfirmed). This is the only
  // confirmed volume path for ReSound.

  async setVolume(level: number, _ear?: 'left' | 'right' | 'both'): Promise<void> {
    const dev = this.connected;
    const ashaLevel = Math.round((level / 100) * 128) - 128;
    const clamped = Math.max(-128, Math.min(0, ashaLevel));
    const byte = clamped & 0xff;

    const serviceUUID = this.findService(ASHA_VOLUME_CHAR);
    await withRetry(() =>
      dev.writeCharacteristicWithResponseForService(
        serviceUUID,
        ASHA_VOLUME_CHAR,
        bytesToBase64([byte]),
      ),
    );
  }

  async getVolume(): Promise<number> {
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

  // ── Program (GN handle protocol — NOT CONFIRMED) ──

  /**
   * Set active program via GN handle protocol.
   *
   * NOT IMPLEMENTED — requires confirmed handle ID.
   *
   * Candidate frame (command_dictionary.md, PARTIAL confidence):
   *   [0x03, 0x08, programIndex]
   *   Written to GN Command: 1959a468-3234-4c18-9e78-8daf8d9dbf61
   *
   * To confirm:
   *   1. Run discover() to verify handle 0x08 exists
   *   2. Capture nRF Sniffer trace of ReSound Smart 3D app changing programs
   *   3. Live write test on connected ReSound device
   *
   * Alternative: direct write to GNCurrentActiveProgram characteristic
   *   dc82f820-63ac-f82f-1e89-372fde4151f4 — but whether this is
   *   directly writable (vs tunneled via handle protocol) is unknown.
   */
  async setProgram(_index: number): Promise<void> {
    // TODO: Implement once handle 0x08 is validated via discover() + sniffing
    //
    // Expected implementation:
    //   const serviceUUID = this.findService(GN_COMMAND_CHAR);
    //   await withRetry(() =>
    //     dev.writeCharacteristicWithResponseForService(
    //       serviceUUID, GN_COMMAND_CHAR,
    //       bytesToBase64([0x03, 0x08, index & 0xff]),
    //     ),
    //   );
    throw new Error(
      'ResoundAdapter.setProgram: GN handle protocol opcodes not confirmed. ' +
      'Run discover() to enumerate handles, then validate handle 0x08.',
    );
  }

  async getProgram(): Promise<number> {
    // Try direct read of GNCurrentActiveProgram characteristic
    const serviceUUID = this.charServiceMap.get(GN_ACTIVE_PROGRAM_CHAR);
    if (serviceUUID) {
      try {
        const char = await withRetry(() =>
          this.connected.readCharacteristicForService(
            serviceUUID,
            GN_ACTIVE_PROGRAM_CHAR,
          ),
        );
        if (char.value) {
          return base64ToBytes(char.value)[0];
        }
      } catch {
        // Direct read failed — characteristic may require handle protocol
      }
    }

    // TODO: GN handle protocol read: [0x04, 0x08] to GN Command,
    // response on GN Notify. Handle 0x08 unconfirmed.
    throw new Error(
      'ResoundAdapter.getProgram: direct read failed or unavailable. ' +
      'GN handle read (0x04, 0x08) not yet implemented.',
    );
  }

  async getPrograms(): Promise<Program[]> {
    // TODO: ReSound program enumeration is undocumented.
    // Programs may be configured via the ReSound Smart 3D app.
    // Live testing with discover() should reveal available program count
    // via GNCurrentActiveProgram value range.
    return [
      { index: 0, name: 'Program 1' },
      { index: 1, name: 'Program 2' },
      { index: 2, name: 'Program 3' },
      { index: 3, name: 'Program 4' },
    ];
  }

  // ── Battery ──

  async getBattery(): Promise<number> {
    const dev = this.connected;

    // Try GN battery characteristic (confirmed enum — resound_uuid_reference_master)
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
   * Uses GNLeftRight characteristic (confirmed: 0=left, 1=right).
   */
  async getSide(): Promise<'left' | 'right' | null> {
    const serviceUUID = this.charServiceMap.get(GN_SIDE_CHAR);
    if (!serviceUUID) return null;

    try {
      const char = await withRetry(() =>
        this.connected.readCharacteristicForService(serviceUUID, GN_SIDE_CHAR),
      );
      if (!char.value) return null;
      const raw = base64ToBytes(char.value)[0];
      return raw === 0 ? 'left' : 'right';
    } catch {
      return null;
    }
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
      // Program read not available (expected until GN protocol confirmed)
    }

    const batteryPercent = await this.getBattery().catch(() => undefined);

    let deviceInfo: DeviceInfo | undefined;
    if (this.device) {
      deviceInfo = {
        id: this.deviceId!,
        name: this.device.name ?? 'ReSound Hearing Aid',
        brand: 'resound',
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
    // Conservative — only features with confirmed or emulated paths:
    //   volume:  ASHA confirmed
    //   mute:    ASHA emulation (volume = -128)
    //   battery: GN battery characteristic (confirmed enum)
    //
    // NOT included until GN handle protocol validated:
    //   program:   handle 0x08 unconfirmed
    //   streaming: handle 0x06 unconfirmed
    //   balance, tinnitus, eq: no known path
    return ['volume', 'mute', 'battery'];
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
    return GN_SERVICE;
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
 * Confirmed values (resound_uuid_reference_master):
 *   1  = Low battery    → 10%
 *   5  = Previously low → 50%
 *   10 = Battery OK     → 100%
 */
function gnBatteryToPercent(raw: number): number {
  if (raw <= 1) return 10;
  if (raw <= 5) return 50;
  if (raw >= 10) return 100;
  return Math.round((raw / 10) * 100);
}
