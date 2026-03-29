/**
 * Rexton / WS Audiology BLE adapter
 *
 * Protocol reference: SPEC.md §2.2, command_dictionary.md
 *
 * Shares POLARIS service (56772eaf) with Philips for basic control.
 * Terminal IO service:  8b82105d-0f0c-40bb-b422-3770fa72a864
 * Control/FAPI service: c8f75466-21b2-45b8-87f8-bd49a13eff49
 *
 * Terminal IO Basic Control (8b8276e8):
 *   Volume:       [0x04, volumePosition]   confirmed
 *   Program:      [0x05, program_index]     confirmed
 *   Balance:      [0x06, value]             confirmed
 *   Tinnitus vol: [0x07, value]             confirmed
 *   CROS volume:  [0x08, value]             confirmed
 *
 * Program notify: 8b8225e0 (subscribe for active program changes)
 *
 * Control Request:  c8f75466 (write [commandId, payload...])
 * Control Response: c8f70447 (subscribe)
 *   Command IDs: 0x00=start, 0x02=stop, 0x04=hi-perf-start,
 *     0x06=hi-perf-stop, 0x08=conn-param, 0x0A=priority, 0x0C=version
 */
import type { Device, Subscription } from 'react-native-ble-plx';
import { getBleManager } from '../ble/BleManager';
import type { HearingAidAdapter, DriverState } from './types';
import type { DeviceInfo, Feature, Program } from '../ble/types';

// ── Terminal IO service + characteristics (SPEC.md §2.2) ──

const TERMINAL_IO_SERVICE = '8b82105d-0f0c-40bb-b422-3770fa72a864';

/** Basic Control: write [opcode, value] for volume/program/balance/tinnitus/CROS (confirmed) */
const BASIC_CONTROL_CHAR = '8b8276e8-0f0c-40bb-b422-3770fa72a864';

/** Program notify: subscribe for active program changes (confirmed) */
const PROGRAM_NOTIFY_CHAR = '8b8225e0-0f0c-40bb-b422-3770fa72a864';

// ── Control/FAPI service + characteristics (SPEC.md §2.2) ──

const CONTROL_SERVICE = 'c8f75466-21b2-45b8-87f8-bd49a13eff49';

/** Control Request: write [commandId, payload...] (confirmed) */
const CONTROL_REQUEST_CHAR = 'c8f75466-21b2-45b8-87f8-bd49a13eff49';

/** Control Response: subscribe for command responses (confirmed) */
const CONTROL_RESPONSE_CHAR = 'c8f70447-21b2-45b8-87f8-bd49a13eff49';

// ── Shared POLARIS service (for detection & ASHA fallback) ──

const POLARIS_SERVICE = '56772eaf-2153-4f74-acf3-4368d99fbf5a';

/** ASHA volume fallback — signed int8 [-128..0] (confirmed) */
const ASHA_VOLUME_CHAR = '00e4ca9e-ab14-41e4-8823-f9e70c7e91df';

// ── Standard BLE Battery Service ──

const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';

// ── Basic Control opcodes (confirmed) ──

const OP_VOLUME = 0x04;
const OP_PROGRAM = 0x05;
const OP_BALANCE = 0x06;
const OP_TINNITUS = 0x07;
const OP_CROS_VOLUME = 0x08;

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

    this.device = await withRetry(() =>
      manager.connectToDevice(deviceId, { requestMTU: 512 }),
    );

    await this.device.discoverAllServicesAndCharacteristics();

    // Subscribe to program change notifications
    this.programNotifySub = this.device.monitorCharacteristicForService(
      TERMINAL_IO_SERVICE,
      PROGRAM_NOTIFY_CHAR,
      (error, char) => {
        if (error || !char?.value) return;
        const bytes = base64ToBytes(char.value);
        if (bytes.length >= 1) {
          this.lastKnownProgram = bytes[0];
        }
      },
    );
  }

  async disconnect(): Promise<void> {
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
    }
  }

  /** Write [opcode, value] to Terminal IO Basic Control characteristic */
  private async writeBasicControl(opcode: number, value: number): Promise<void> {
    const dev = this.connected;
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
    await this.writeBasicControl(OP_VOLUME, clamped);
    this.lastKnownVolume = clamped;
  }

  /**
   * Read current volume.
   * Terminal IO Basic Control is write-only for individual opcodes;
   * fall back to reading the POLARIS volume characteristic.
   */
  async getVolume(): Promise<number> {
    const dev = this.connected;
    try {
      const char = await withRetry(() =>
        dev.readCharacteristicForService(POLARIS_SERVICE, ASHA_VOLUME_CHAR),
      );
      if (char.value) {
        const bytes = base64ToBytes(char.value);
        // ASHA: signed int8 [-128..0], map to 0..128
        const signed = bytes[0] > 127 ? bytes[0] - 256 : bytes[0];
        return signed + 128;
      }
    } catch {
      // ASHA volume read unavailable
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

  /** Write [0x06, value] to Terminal IO Basic Control (confirmed). */
  async setBalance(value: number): Promise<void> {
    const clamped = Math.max(0, Math.min(255, Math.round(value) & 0xff));
    await this.writeBasicControl(OP_BALANCE, clamped);
  }

  /** Write [0x07, value] to Terminal IO Basic Control (confirmed). */
  async setTinnitusVolume(level: number): Promise<void> {
    const clamped = Math.max(0, Math.min(255, Math.round(level)));
    await this.writeBasicControl(OP_TINNITUS, clamped);
  }

  async refreshState(): Promise<DriverState> {
    const [volume, batteryPercent] = await Promise.all([
      this.getVolume().catch(() => undefined),
      this.getBattery().catch(() => undefined),
    ]);

    return {
      volume,
      muted: this.lastKnownMute,
      activeProgram: this.lastKnownProgram,
      batteryPercent:
        batteryPercent !== undefined && batteryPercent >= 0
          ? batteryPercent
          : undefined,
      deviceInfo: this.deviceId
        ? {
            id: this.deviceId,
            name: this.device?.name ?? 'Rexton Hearing Aid',
            brand: 'rexton' as const,
          }
        : undefined,
    };
  }

  getSupportedFeatures(): Feature[] {
    return ['volume', 'mute', 'program', 'balance', 'tinnitus', 'battery'];
  }
}
