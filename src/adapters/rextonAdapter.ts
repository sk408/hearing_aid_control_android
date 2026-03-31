/**
 * Rexton / WS Audiology BLE adapter
 *
 * Protocol reference: rexton.md, rexton_uuid_dossier docs
 *
 * Rexton (Sivantos / WS Audiology) shares significant BLE infrastructure with
 * Philips/Oticon (Demant). The shared POLARIS service (56772eaf) confirms
 * WS Audiology licenses or shares the Demant BLE hearing instrument platform.
 *
 * Live BLE probe on "JOHN's hearing aid" (6C:6D:44:BF:F5:38) confirmed:
 *   - Battery service 0x180F readable (0x64 = 100%)
 *   - Service 7d74f4bd present (MFi HAP / Apple) — same as Philips/ReSound.
 *     This indicates a GN-platform trust bond model where iOS MFi pairing
 *     may be required for full characteristic access.
 *   - Most proprietary characteristics reject reads/writes without bonding.
 *
 * Terminal IO service:  8b82105d-0f0c-40bb-b422-3770fa72a864
 * Control/FAPI service: c8f7a831-21b2-45b8-87f8-bd49a13eff49
 *
 * Terminal IO Basic Control (8b8276e8):
 *   Volume:       [0x04, volumePosition]   confirmed
 *   Program:      [0x05, program_index]     confirmed
 *   Balance:      [0x06, value]             confirmed
 *   Tinnitus vol: [0x07, value]             confirmed
 *   CROS volume:  [0x08, value]             confirmed
 *   TV stream:    [0x09, (15-slider)]       confirmed
 *
 * Program notify: 8b8225e0 (subscribe for active program changes)
 *
 * Control Request:  c8f75466 (write [commandId, payload...])
 * Control Response: c8f70447 (subscribe)
 *   Command IDs: 0x00=start, 0x02=stop, 0x04=hi-perf-start,
 *     0x06=hi-perf-stop, 0x08=conn-param, 0x0A=priority, 0x0C=version
 *
 * Shared POLARIS UUIDs with Philips: 56772eaf (Hi Service), 5f35c43d (HI ID),
 *   353ecc73 (Partner ID), 50632720 (OBLE volume), 34dfc7cb, 6efab52e.
 *
 * Bonding service: 0a23ae62 (same as Philips ASHA UUID)
 *   Battery Level: ebee6f69 (bonding service battery — separate from 0x180F)
 *   Pairing State:  8e467a33
 */
import type { Device, Subscription } from 'react-native-ble-plx';
import { getBleManager } from '../ble/BleManager';
import { getBondState, createBond, BOND_BONDED } from '../ble/bleBond';
import type { HearingAidAdapter, DriverState } from './types';
import type { DeviceInfo, Feature, Program } from '../ble/types';

// ── Terminal IO service + characteristics (SPEC.md §2.2) ──

const TERMINAL_IO_SERVICE = '8b82105d-0f0c-40bb-b422-3770fa72a864';

/** Basic Control: write [opcode, value] for volume/program/balance/tinnitus/CROS (confirmed) */
const BASIC_CONTROL_CHAR = '8b8276e8-0f0c-40bb-b422-3770fa72a864';

/** Program notify: subscribe for active program changes (confirmed) */
const PROGRAM_NOTIFY_CHAR = '8b8225e0-0f0c-40bb-b422-3770fa72a864';

// ── Control/FAPI service + characteristics (rexton_uuid_dossier_01) ──

const CONTROL_SERVICE = 'c8f7a831-21b2-45b8-87f8-bd49a13eff49';

/** Control Request: write [commandId, payload...] (confirmed) */
const CONTROL_REQUEST_CHAR = 'c8f75466-21b2-45b8-87f8-bd49a13eff49';

/** Control Response: subscribe for command responses (confirmed) */
const CONTROL_RESPONSE_CHAR = 'c8f70447-21b2-45b8-87f8-bd49a13eff49';

/** Data Request: raw/chunked programming payloads (confirmed) */
const DATA_REQUEST_CHAR = 'c8f72804-21b2-45b8-87f8-bd49a13eff49';

/** Data Response: chunk reassembly (confirmed) */
const DATA_RESPONSE_CHAR = 'c8f72fef-21b2-45b8-87f8-bd49a13eff49';

/** FAPI Request: fitting API serializer output (confirmed transport) */
const FAPI_REQUEST_CHAR = 'c8f723da-21b2-45b8-87f8-bd49a13eff49';

/** FAPI Response: fitting API raw response (confirmed transport) */
const FAPI_RESPONSE_CHAR = 'c8f7690c-21b2-45b8-87f8-bd49a13eff49';

// ── Shared POLARIS service (licensed/shared Demant platform) ──

const POLARIS_SERVICE = '56772eaf-2153-4f74-acf3-4368d99fbf5a';

/** HI ID: hearing instrument identifier string (partial — shared with Philips) */
const HI_ID_CHAR = '5f35c43d-e0f4-4da9-87e6-9719982cd25e';

/** Partner ID: paired hearing instrument identifier (partial — shared with Philips) */
const PARTNER_ID_CHAR = '353ecc73-4d2c-421b-ac1c-8dcb35cd4477';

/** OBLE streaming volume: legacy path [(slider-1),0x01] or [0x00,0x00] for zero (confirmed) */
const OBLE_VOLUME_CHAR = '50632720-4c0f-4bc4-960a-2404bdfdfbca';

/** Hi State: hearing instrument state (partial) */
const HI_STATE_CHAR = '83e28ff3-25ad-4bfe-aaf0-5a95dba4b56b';

/** Ear side identifier (partial) */
const EAR_CHAR = 'd28617fe-0ad5-40c5-a04a-bc89051ff755';

/**
 * Shared POLARIS main volume char (same UUID as Philips 1454e9d6).
 * Format: [level, invMute] where invMute: 1=unmuted, 0=muted.
 * Rexton firmware exposes this on the shared POLARIS service (56772eaf)
 * alongside the Terminal IO Basic Control path.
 * Used for reading current volume state (notify/read).
 */
const MAIN_VOLUME_CHAR = '1454e9d6-f658-4190-8589-22aa9e3021eb';

/**
 * Shared POLARIS program select char (same UUID as Philips 535442f7).
 * Write [(byte) programId], notify returns active program index.
 * Alternative to Terminal IO Basic Control [0x05, prog] for program switching.
 */
const POLARIS_PROGRAM_CHAR = '535442f7-0ff7-4fec-9780-742f3eb00eda';

// ── Bonding service (0a23ae62 — same UUID as Philips ASHA bonding) ──
// Live probe: most characteristics reject reads without bonding.
// Service 7d74f4bd (MFi HAP) was also present, indicating a GN-platform trust bond
// model similar to ReSound/Philips where iOS MFi pairing bootstraps trust.

const BONDING_SERVICE = '0a23ae62-c4c2-43d1-87b1-e8c83839a063';

/** Battery level within bonding service (separate from 0x180F BAS) */
const BONDING_BATTERY_CHAR = 'ebee6f69-70b6-4bb9-b13b-9ba84953c233';

/** Pairing state (partial) */
const PAIRING_STATE_CHAR = '8e467a33-820e-40fa-8759-4cd7a197384d';

// ── Standard BLE Device Information Service (0x180A) ──

const DIS_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
const DIS_MODEL_CHAR = '00002a24-0000-1000-8000-00805f9b34fb';
const DIS_MANUFACTURER_CHAR = '00002a29-0000-1000-8000-00805f9b34fb';
const DIS_FIRMWARE_CHAR = '00002a26-0000-1000-8000-00805f9b34fb';

// ── Standard BLE Battery Service (0x180F) ──
// Confirmed readable on live probe (returned 0x64 = 100%).

const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';

// ── Basic Control opcodes (confirmed) ──

const OP_VOLUME = 0x04;
const OP_PROGRAM = 0x05;
const OP_BALANCE = 0x06;
const OP_TINNITUS = 0x07;
const OP_CROS_VOLUME = 0x08;
const OP_TV_STREAM_VOLUME = 0x09; // maps as (15 - sliderValue)

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

export class RextonAdapter implements HearingAidAdapter {
  readonly brand = 'rexton' as const;

  private device: Device | null = null;
  private deviceId: string | null = null;
  private lastKnownVolume = 0;
  private lastKnownMute = false;
  private lastKnownProgram = 0;
  private programNotifySub: Subscription | null = null;
  private volumeNotifySub: Subscription | null = null;

  /** Returns connected device or throws */
  private get connected(): Device {
    if (!this.device) {
      throw new Error('RextonAdapter: not connected — call connect() first');
    }
    return this.device;
  }

  async connect(deviceId: string): Promise<void> {
    const manager = getBleManager();
    this.deviceId = deviceId;
    console.log(`[RextonAdapter] Connecting to ${deviceId}...`);

    this.device = await withRetry(() =>
      manager.connectToDevice(deviceId, { requestMTU: 512 }),
    );
    console.log('[RextonAdapter] GATT connected, discovering services...');

    await this.device.discoverAllServicesAndCharacteristics();
    console.log('[RextonAdapter] Service discovery complete');

    // Ensure Android-level BLE bond before any secured characteristic access.
    // Without this, writes to Terminal IO / POLARIS characteristics fail with
    // "Operation was rejected" on Android 6+.
    const bondState = await getBondState(deviceId);
    if (bondState !== BOND_BONDED) {
      console.log('[RextonAdapter] Initiating Android BLE bond...');
      await createBond(deviceId);
      console.log('[RextonAdapter] Android bond complete');
    } else {
      console.log('[RextonAdapter] Already Android-bonded');
    }

    // Subscribe to Terminal IO program change notifications (8b8225e0)
    this.programNotifySub = this.device.monitorCharacteristicForService(
      TERMINAL_IO_SERVICE,
      PROGRAM_NOTIFY_CHAR,
      (error, char) => {
        if (error) {
          console.log('[RextonAdapter] Program notify error:', error.message);
          return;
        }
        if (!char?.value) return;
        const bytes = base64ToBytes(char.value);
        if (bytes.length >= 1) {
          this.lastKnownProgram = bytes[0];
          console.log(`[RextonAdapter] Program notify: program=${bytes[0]}`);
        }
      },
    );

    // Subscribe to shared POLARIS main volume char (1454e9d6) for volume state tracking.
    // Rexton shares this UUID with Philips/Oticon on the POLARIS service.
    // Format: [level, invMute] where invMute 1=unmuted, 0=muted.
    try {
      this.volumeNotifySub = this.device.monitorCharacteristicForService(
        POLARIS_SERVICE,
        MAIN_VOLUME_CHAR,
        (error, char) => {
          if (error || !char?.value) return;
          const bytes = base64ToBytes(char.value);
          if (bytes.length >= 1) {
            this.lastKnownVolume = bytes[0];
            console.log(`[RextonAdapter] Volume notify: level=${bytes[0]}${bytes.length >= 2 ? `, mute=${bytes[1] === 0}` : ''}`);
          }
          if (bytes.length >= 2) {
            this.lastKnownMute = bytes[1] === 0;
          }
        },
      );
      console.log('[RextonAdapter] Subscribed to POLARIS volume notifications');
    } catch {
      // POLARIS main volume char may not be available on all Rexton firmware versions.
      // Volume tracking will rely on lastKnownVolume from setVolume() calls.
      console.log('[RextonAdapter] POLARIS volume subscription not available — using local tracking');
    }

    console.log('[RextonAdapter] Connection setup complete');
  }

  async disconnect(): Promise<void> {
    console.log('[RextonAdapter] Disconnecting...');
    if (this.programNotifySub) {
      this.programNotifySub.remove();
      this.programNotifySub = null;
    }
    if (this.volumeNotifySub) {
      this.volumeNotifySub.remove();
      this.volumeNotifySub = null;
    }
    if (this.device) {
      try {
        await this.device.cancelConnection();
      } catch {
        // Device may already be disconnected
      }
      this.device = null;
      this.deviceId = null;
    }
    console.log('[RextonAdapter] Disconnected');
  }

  /** Write [opcode, value] to Terminal IO Basic Control characteristic (8b8276e8) */
  private async writeBasicControl(opcode: number, value: number): Promise<void> {
    const dev = this.connected;
    console.log(`[RextonAdapter] BasicControl write: [0x${opcode.toString(16).padStart(2, '0')}, ${value}]`);
    await withRetry(() =>
      dev.writeCharacteristicWithResponseForService(
        TERMINAL_IO_SERVICE,
        BASIC_CONTROL_CHAR,
        bytesToBase64([opcode, value & 0xff]),
      ),
    );
  }

  /**
   * Set volume via Terminal IO Basic Control.
   * Writes [0x04, volumePosition] (confirmed).
   * Per-ear control requires connecting to each device independently —
   * the ear parameter is accepted for interface conformance only.
   */
  async setVolume(level: number, _ear?: 'left' | 'right' | 'both'): Promise<void> {
    const clamped = Math.max(0, Math.min(255, Math.round(level)));
    console.log(`[RextonAdapter] setVolume(${clamped})`);
    await this.writeBasicControl(OP_VOLUME, clamped);
    this.lastKnownVolume = clamped;
  }

  /**
   * Read current volume.
   * Terminal IO Basic Control is write-only; reads use the shared POLARIS
   * main volume char (1454e9d6) which returns [level, invMute].
   * Falls back to lastKnownVolume tracked from setVolume() calls and
   * POLARIS volume notifications.
   */
  async getVolume(): Promise<number> {
    const dev = this.connected;
    try {
      const char = await withRetry(() =>
        dev.readCharacteristicForService(POLARIS_SERVICE, MAIN_VOLUME_CHAR),
      );
      if (char.value) {
        const bytes = base64ToBytes(char.value);
        if (bytes.length >= 1) {
          this.lastKnownVolume = bytes[0];
        }
        if (bytes.length >= 2) {
          this.lastKnownMute = bytes[1] === 0;
        }
        console.log(`[RextonAdapter] Read POLARIS volume: level=${bytes[0]}${bytes.length >= 2 ? `, mute=${bytes[1] === 0}` : ''}`);
        return bytes[0];
      }
    } catch {
      // POLARIS main volume char may not be readable on all Rexton firmware.
      // Fall back to lastKnownVolume from writes / notifications.
      console.log('[RextonAdapter] POLARIS volume read unavailable, using lastKnownVolume');
    }
    return this.lastKnownVolume;
  }

  /**
   * Mute/unmute the hearing aid.
   * TODO: No confirmed dedicated mute opcode in Terminal IO Basic Control
   * (command_dictionary.md — mute is routed via advanced/FAPI receiver-state
   * paths). Using volume-minimum emulation as fallback.
   */
  async setMute(muted: boolean): Promise<void> {
    console.log(`[RextonAdapter] setMute(${muted})`);
    this.lastKnownMute = muted;
    if (muted) {
      // Fallback: set volume to 0 (minimum) to emulate mute
      await this.writeBasicControl(OP_VOLUME, 0);
    } else {
      // Restore last known volume (or reasonable default)
      const restoreLevel = this.lastKnownVolume > 0 ? this.lastKnownVolume : 128;
      await this.writeBasicControl(OP_VOLUME, restoreLevel);
    }
  }

  async getMute(): Promise<boolean> {
    // TODO: No confirmed mute readback in Terminal IO — tracked via local state
    return this.lastKnownMute;
  }

  /** Write [0x05, program_index] to Terminal IO Basic Control (confirmed). */
  async setProgram(index: number): Promise<void> {
    console.log(`[RextonAdapter] setProgram(${index})`);
    await this.writeBasicControl(OP_PROGRAM, index);
    this.lastKnownProgram = index;
  }

  /**
   * Read active program.
   * Relies on program notify subscription (8b8225e0) set up during connect().
   * Falls back to last known value.
   */
  async getProgram(): Promise<number> {
    return this.lastKnownProgram;
  }

  /**
   * Read available programs.
   * TODO: Program list discovery via control service is not yet documented
   * (SPEC.md §2.2). Returns placeholder names.
   */
  async getPrograms(): Promise<Program[]> {
    // TODO: Read actual program list via control service (SPEC.md §2.2)
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
   * Confirmed readable on live probe (returned 0x64 = 100%).
   * Note: bonding service also exposes ebee6f69 battery char — not yet tested.
   */
  async getBattery(): Promise<number> {
    const dev = this.connected;
    try {
      const char = await withRetry(() =>
        dev.readCharacteristicForService(BATTERY_SERVICE, BATTERY_LEVEL_CHAR),
      );
      if (!char.value) return -1;
      const level = base64ToBytes(char.value)[0]; // BAS: single byte 0-100
      console.log(`[RextonAdapter] Battery: ${level}%`);
      return level;
    } catch {
      console.log('[RextonAdapter] Battery read failed');
      return -1;
    }
  }

  /**
   * Read device info via standard BLE Device Information Service (0x180A).
   * DIS chars may require bonding on some Rexton models — falls back gracefully.
   */
  async getDeviceInfo(): Promise<DeviceInfo> {
    const dev = this.connected;
    const info: DeviceInfo = {
      id: this.deviceId!,
      name: dev.name ?? 'Rexton Hearing Aid',
      brand: 'rexton',
    };

    try {
      const fwChar = await withRetry(() =>
        dev.readCharacteristicForService(DIS_SERVICE, DIS_FIRMWARE_CHAR),
      );
      if (fwChar.value) {
        info.firmwareVersion = String.fromCharCode(...base64ToBytes(fwChar.value));
      }
    } catch {
      // DIS may not be readable without bond on Rexton devices
    }

    // Try to read ear side from shared POLARIS characteristic
    try {
      const earChar = await withRetry(() =>
        dev.readCharacteristicForService(POLARIS_SERVICE, EAR_CHAR),
      );
      if (earChar.value) {
        const bytes = base64ToBytes(earChar.value);
        // Ear side encoding is partial — 0x01/0x02 for left/right is common
        if (bytes[0] === 0x01) info.side = 'left';
        else if (bytes[0] === 0x02) info.side = 'right';
      }
    } catch {
      // Ear char may not be accessible without bond
    }

    return info;
  }

  /** Write [0x06, value] to Terminal IO Basic Control (confirmed). */
  async setBalance(value: number): Promise<void> {
    const clamped = Math.max(0, Math.min(255, Math.round(value) & 0xff));
    console.log(`[RextonAdapter] setBalance(${clamped})`);
    await this.writeBasicControl(OP_BALANCE, clamped);
  }

  /** Write [0x07, value] to Terminal IO Basic Control (confirmed). */
  async setTinnitusVolume(level: number): Promise<void> {
    const clamped = Math.max(0, Math.min(255, Math.round(level)));
    console.log(`[RextonAdapter] setTinnitusVolume(${clamped})`);
    await this.writeBasicControl(OP_TINNITUS, clamped);
  }

  /**
   * Set streaming volume via legacy OBLE path (50632720 on POLARIS service).
   * Format: nonzero [(slider-1), 0x01], zero [0x00, 0x00] (confirmed from dossier).
   * Also available as TV stream via Basic Control: [0x09, (15 - sliderValue)].
   */
  async setStreamingVolume(level: number): Promise<void> {
    const dev = this.connected;
    const clamped = Math.max(0, Math.min(255, Math.round(level)));
    console.log(`[RextonAdapter] setStreamingVolume(${clamped})`);
    const payload = clamped > 0 ? [clamped - 1, 0x01] : [0x00, 0x00];
    await withRetry(() =>
      dev.writeCharacteristicWithoutResponseForService(
        POLARIS_SERVICE,
        OBLE_VOLUME_CHAR,
        bytesToBase64(payload),
      ),
    );
  }

  async refreshState(): Promise<DriverState> {
    const [volume, batteryPercent, deviceInfo] = await Promise.all([
      this.getVolume().catch(() => undefined),
      this.getBattery().catch(() => undefined),
      this.getDeviceInfo().catch(() => undefined),
    ]);

    return {
      volume,
      muted: this.lastKnownMute,
      activeProgram: this.lastKnownProgram,
      batteryPercent:
        batteryPercent !== undefined && batteryPercent >= 0
          ? batteryPercent
          : undefined,
      deviceInfo,
    };
  }

  getSupportedFeatures(): Feature[] {
    return ['volume', 'mute', 'program', 'balance', 'tinnitus', 'streaming', 'battery'];
  }
}
