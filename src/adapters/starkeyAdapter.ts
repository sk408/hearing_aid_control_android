/**
 * Starkey (Piccolo protocol) BLE adapter
 *
 * Protocol reference: SPEC.md §2.3, command_dictionary.md, starkey.md
 *
 * Piccolo service:         9a04f079-9840-4286-ab92-e65be0885f95
 * Primary characteristic:  a287a5f9-0fa3-bc84-2a41-c9da6d85bd4e (R/W/Notify)
 * Fallback characteristic: 37a691f4-7686-4280-caca-fba8b44b9360 (R/W/Notify)
 *
 * Command frame: [0x12, 0x06, 0x04, 0x00, 0x04, controlId, value]
 *
 * Confirmed command IDs (command_dictionary.md):
 *   0x34 = Memory (program select)
 *   0x35 = MicrophoneVolume
 *   0x3A = Mute (0 = unmuted, 1 = muted)
 *   0x3D = StreamingState (start/stop accessory streaming)
 *
 * ControlObjectId enum (starkey.md — 16 values from ControlObjectId.java):
 *   Sequential from 0x34. Only Memory (0x34) and MicrophoneVolume (0x35)
 *   are confirmed; remaining values are inferred from enum order.
 */
import type { Device } from 'react-native-ble-plx';
import { getBleManager } from '../ble/BleManager';
import type { HearingAidAdapter, DriverState } from './types';
import type { DeviceInfo, Feature, Program } from '../ble/types';

// ── Piccolo service & characteristics (starkey.md §GATT, Connection.java) ──

const PICCOLO_SERVICE = '9a04f079-9840-4286-ab92-e65be0885f95';

/** Primary Piccolo R/W/Notify characteristic — tried first */
const PICCOLO_PRIMARY_CHAR = 'a287a5f9-0fa3-bc84-2a41-c9da6d85bd4e';

/** Fallback Piccolo R/W/Notify characteristic — used if primary absent */
const PICCOLO_FALLBACK_CHAR = '37a691f4-7686-4280-caca-fba8b44b9360';

// ── Standard BLE Battery Service ──

const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';

// ── Piccolo command frame ──

const PICCOLO_HEADER: readonly number[] = [0x12, 0x06, 0x04, 0x00, 0x04];

// ── Confirmed Piccolo command IDs (SPEC.md §2.3, command_dictionary.md) ──

const CMD_MEMORY = 0x34;
const CMD_VOLUME = 0x35;
const CMD_MUTE = 0x3a;
const CMD_STREAM_START_STOP = 0x3d;

// ── ControlObjectId enum (starkey.md — all 16 values) ──
//
// Sequential from 0x34 per ControlObjectId.java enum order.
// Memory (0x34) and MicrophoneVolume (0x35) confirmed.
// Mute (0x3A) and StreamStartStop (0x3D) are confirmed as separate
// ExecuteFeature command IDs that overlap with the sequential enum
// positions for StreamingState and EqualizerMiddleState respectively.
// Extended-control methods use the inferred enum values and are marked
// accordingly — byte IDs may need adjustment after device testing.

const enum ControlObjectId {
  Memory = 0x34,
  MicrophoneVolume = 0x35,
  TinnitusVolume = 0x36,                // inferred
  StreamingVolume = 0x37,                // inferred
  AccessoryStreamingVolume = 0x38,       // inferred
  BalanceVolume = 0x39,                  // inferred
  StreamingState = 0x3a,                 // inferred (overlaps confirmed Mute cmd)
  AdaptiveTuningState = 0x3b,            // inferred
  EqualizerBassState = 0x3c,             // inferred
  EqualizerMiddleState = 0x3d,           // inferred (overlaps confirmed Stream cmd)
  EqualizerTrebleState = 0x3e,           // inferred
  NoiseReductionState = 0x3f,            // inferred
  WindReductionState = 0x40,             // inferred
  StreamingEqualizerBassState = 0x41,    // inferred
  StreamingEqualizerMiddleState = 0x42,  // inferred
  StreamingEqualizerTrebleState = 0x43,  // inferred
}

// ── Volume mapping ──

/** Piccolo volume range is 0–15 (4-bit). Input 0–100 maps linearly. */
const PICCOLO_VOLUME_MAX = 15;

function volumeToPiccolo(level: number): number {
  return Math.round(Math.max(0, Math.min(100, level)) * PICCOLO_VOLUME_MAX / 100);
}

function piccoloToVolume(piccolo: number): number {
  return Math.round(Math.max(0, Math.min(PICCOLO_VOLUME_MAX, piccolo)) * 100 / PICCOLO_VOLUME_MAX);
}

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

// ── Adapter ──

export class StarkeyAdapter implements HearingAidAdapter {
  readonly brand = 'starkey' as const;

  private device: Device | null = null;
  private deviceId: string | null = null;

  /**
   * Resolved Piccolo characteristic UUID (primary or fallback).
   * Set during connect() after service discovery.
   */
  private piccoloCharUuid: string | null = null;

  // Cached state — Piccolo is write-centric; read-back format unconfirmed.
  private cachedVolume = 0;
  private cachedMuted = false;
  private cachedProgram = 0;

  /** Returns connected device or throws */
  private get connected(): Device {
    if (!this.device) {
      throw new Error('StarkeyAdapter: not connected — call connect() first');
    }
    return this.device;
  }

  /** Build Piccolo command: [0x12, 0x06, 0x04, 0x00, 0x04, cmdId, value] */
  private buildCommand(cmdId: number, value: number): number[] {
    return [...PICCOLO_HEADER, cmdId, value & 0xff];
  }

  /** Write a Piccolo command to the resolved characteristic with retry */
  private async writeCommand(cmdId: number, value: number): Promise<void> {
    const dev = this.connected;
    const charUuid = this.piccoloCharUuid!;
    const payload = bytesToBase64(this.buildCommand(cmdId, value));

    await withRetry(() =>
      dev.writeCharacteristicWithResponseForService(
        PICCOLO_SERVICE,
        charUuid,
        payload,
      ),
    );
  }

  /**
   * Resolve which Piccolo characteristic to use.
   * Per Connection.java lines 595–600: try primary a287a5f9, fall back
   * to 37a691f4 (firmware generation difference).
   */
  private async resolvePiccoloCharacteristic(): Promise<string> {
    const dev = this.connected;
    try {
      const chars = await dev.characteristicsForService(PICCOLO_SERVICE);
      if (chars.some((c) => c.uuid === PICCOLO_PRIMARY_CHAR)) {
        return PICCOLO_PRIMARY_CHAR;
      }
      if (chars.some((c) => c.uuid === PICCOLO_FALLBACK_CHAR)) {
        return PICCOLO_FALLBACK_CHAR;
      }
    } catch {
      // Characteristic enumeration failed — default to primary
    }
    return PICCOLO_PRIMARY_CHAR;
  }

  async connect(deviceId: string): Promise<void> {
    const manager = getBleManager();
    this.deviceId = deviceId;

    this.device = await withRetry(() =>
      manager.connectToDevice(deviceId, { requestMTU: 512 }),
    );

    await this.device.discoverAllServicesAndCharacteristics();

    // Resolve primary vs fallback Piccolo characteristic
    this.piccoloCharUuid = await this.resolvePiccoloCharacteristic();
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
      this.piccoloCharUuid = null;
    }
  }

  /**
   * Set volume on connected Starkey device.
   * Sends Piccolo [0x12, 0x06, 0x04, 0x00, 0x04, 0x35, volume] (confirmed).
   * Input 0–100 mapped to Piccolo 0–15 range.
   */
  async setVolume(level: number, _ear?: 'left' | 'right' | 'both'): Promise<void> {
    const piccoloLevel = volumeToPiccolo(level);
    await this.writeCommand(CMD_VOLUME, piccoloLevel);
    this.cachedVolume = level;
  }

  /**
   * Returns cached volume (0–100).
   * Piccolo read-back response format is unconfirmed — cache is authoritative.
   */
  async getVolume(): Promise<number> {
    return this.cachedVolume;
  }

  /**
   * Set mute state.
   * Sends Piccolo [0x12, 0x06, 0x04, 0x00, 0x04, 0x3A, muteByte] (confirmed).
   * muteByte: 0 = unmuted, 1 = muted.
   */
  async setMute(muted: boolean): Promise<void> {
    await this.writeCommand(CMD_MUTE, muted ? 1 : 0);
    this.cachedMuted = muted;
  }

  async getMute(): Promise<boolean> {
    return this.cachedMuted;
  }

  /**
   * Switch program/memory slot.
   * Sends Piccolo [0x12, 0x06, 0x04, 0x00, 0x04, 0x34, memoryIndex] (confirmed).
   */
  async setProgram(index: number): Promise<void> {
    await this.writeCommand(CMD_MEMORY, index);
    this.cachedProgram = index;
  }

  async getProgram(): Promise<number> {
    return this.cachedProgram;
  }

  /**
   * Return available programs.
   * No confirmed Piccolo query for program list — returns placeholder names.
   * TODO: Parse program list from Piccolo response when format is documented.
   */
  async getPrograms(): Promise<Program[]> {
    return [
      { index: 0, name: 'Program 1' },
      { index: 1, name: 'Program 2' },
      { index: 2, name: 'Program 3' },
      { index: 3, name: 'Program 4' },
    ];
  }

  /**
   * Read battery via standard BLE Battery Service (0x180F).
   * Returns 0–100 on success, -1 on failure.
   * TODO: Try Starkey Morse battery char (60fb6208) if BAS unavailable.
   */
  async getBattery(): Promise<number> {
    const dev = this.connected;
    try {
      const char = await withRetry(() =>
        dev.readCharacteristicForService(BATTERY_SERVICE, BATTERY_LEVEL_CHAR),
      );
      if (!char.value) return -1;
      return base64ToBytes(char.value)[0]; // BAS: single byte 0–100
    } catch {
      return -1;
    }
  }

  /**
   * Set left/right balance.
   * Uses inferred ControlObjectId.BalanceVolume (0x39).
   * Maps input -10..+10 to byte 0..20 (10 = centered).
   */
  async setBalance(value: number): Promise<void> {
    const clamped = Math.max(-10, Math.min(10, Math.round(value)));
    await this.writeCommand(ControlObjectId.BalanceVolume, clamped + 10);
  }

  /**
   * Set tinnitus masker volume.
   * Uses inferred ControlObjectId.TinnitusVolume (0x36).
   * Input 0–100 mapped to Piccolo 0–15 range.
   */
  async setTinnitusVolume(level: number): Promise<void> {
    await this.writeCommand(ControlObjectId.TinnitusVolume, volumeToPiccolo(level));
  }

  /**
   * Set streaming audio volume.
   * Uses inferred ControlObjectId.StreamingVolume (0x37).
   * Input 0–100 mapped to Piccolo 0–15 range.
   */
  async setStreamingVolume(level: number): Promise<void> {
    await this.writeCommand(ControlObjectId.StreamingVolume, volumeToPiccolo(level));
  }

  /**
   * Set 3-band equalizer (bass / mid / treble).
   * Uses inferred ControlObjectIds 0x3C / 0x3D / 0x3E.
   * Input and output range TBD — clamped to 0–15 for now.
   */
  async setEQ(bass: number, mid: number, treble: number): Promise<void> {
    const clamp = (v: number) => Math.max(0, Math.min(15, Math.round(v)));
    await this.writeCommand(ControlObjectId.EqualizerBassState, clamp(bass));
    await this.writeCommand(ControlObjectId.EqualizerMiddleState, clamp(mid));
    await this.writeCommand(ControlObjectId.EqualizerTrebleState, clamp(treble));
  }

  async refreshState(): Promise<DriverState> {
    const batteryPercent = await this.getBattery().catch(() => undefined);

    let deviceInfo: DeviceInfo | undefined;
    if (this.device) {
      deviceInfo = {
        id: this.deviceId!,
        name: this.device.name ?? 'Starkey Hearing Aid',
        brand: 'starkey',
      };
    }

    return {
      volume: this.cachedVolume,
      muted: this.cachedMuted,
      activeProgram: this.cachedProgram,
      batteryPercent:
        batteryPercent !== undefined && batteryPercent >= 0
          ? batteryPercent
          : undefined,
      deviceInfo,
    };
  }

  getSupportedFeatures(): Feature[] {
    return [
      'volume',
      'mute',
      'program',
      'battery',
      'balance',
      'tinnitus',
      'streaming',
      'eq',
      'noiseReduction',
      'windReduction',
    ];
  }
}
