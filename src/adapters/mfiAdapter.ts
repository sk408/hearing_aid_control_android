/**
 * MFi / LEA universal hearing-aid adapter.
 *
 * Implements remote control using ONLY the standardized MFi/LEA control
 * surface — no brand-specific cores, no GN crypto, no POLARIS, no ASHA.
 * One adapter, any MFi hearing aid.
 *
 * Protocol reference: MFI_SPEC.md (GN Palpatine6 firmware 6.7.4.1 GATT dump)
 *
 * LEA service: 7d74f4bd-c74a-4431-862c-cce884371592
 *
 * Key facts from the spec:
 *  - LEA control characteristics require only an ENCRYPTED (bonded) BLE link;
 *    they are NOT gated on MFi auth completion (spec §4.2). Android
 *    createBond() (Just Works / LESC) is sufficient (spec §4.3).
 *  - Volume: 1-byte attenuation per channel, range 1–255, monotonic with
 *    loudness (spec §3.1). RC table reference points:
 *    {1,13,36,59,82,105,128,151,174,197,220,243,255}.
 *  - Programs: LEAAvailablePrograms is a 4-byte LE bitmask (bit N = program N
 *    fitted); firmware REJECTS writes of invalid indices (spec §3.2), so the
 *    index is validated against the bitmask before writing.
 *  - Mute: no dedicated characteristic — emulated by writing 0 to the mic
 *    attenuation and restoring the stored value on unmute (spec §3.1).
 *    EXPERIMENTAL: firmware treatment of 0 vs 1 is unconfirmed (spec §4.7).
 *  - Program names: write index to LEAProgramNameSelector, then read
 *    LEAProgramName (60-byte UTF-8) and LEAProgramCategory (spec §3.2).
 *
 * This file intentionally imports NO brand-core code.
 */
import type { Device, Subscription } from 'react-native-ble-plx';
import { getBleManager } from '../ble/BleManager';
import { getBondState, createBond, BOND_BONDED } from '../ble/bleBond';
import type { HearingAidAdapter, DriverState } from './types';
import type { DeviceInfo, Feature, Program } from '../ble/types';

// ── LEA (MFi Hearing Aid) service & characteristics (MFI_SPEC.md §1.1) ──

const LEA_SERVICE = '7d74f4bd-c74a-4431-862c-cce884371592';

/** Mic path volume — R/W/N, 1 byte, 1–255 monotonic with loudness */
const LEA_MIC_ATTENUATION = 'f3f594f9-e210-48f3-85e2-4b0cf235a9d3';
/** Streaming path volume — R/W/N, 1 byte, 1–255 */
const LEA_STREAM_ATTENUATION = '6ac46200-24ea-46d8-a136-81133c65840a';
/** Fitted programs — R, 4-byte LE bitmask, bit N = program N fitted */
const LEA_AVAILABLE_PROGRAMS = '21ff4275-c41d-4486-a0e3-dc11138bcde6';
/** Active program index — R/W/N, 1 byte */
const LEA_CURRENT_ACTIVE_PROGRAM = 'a391c6f1-20bb-495a-abbf-2017098fbc61';
/** Battery percent — R/N, 1 byte, 0–100 */
const LEA_BATTERY_LEVEL = '24e1dff3-ae90-41bf-bfbd-2cf8df42bf87';
/** Selects which program the name/category I/O applies to — R/W, 1 byte */
const LEA_PROGRAM_NAME_SELECTOR = 'a28b6be1-2fa4-42f8-aeb2-b15a1dbd837a';
/** UTF-8 name of the selected program — R/W, 60-byte fixed field */
const LEA_PROGRAM_NAME = '7be94a55-8d91-4592-bc0f-ea3664ccd3a9';
/** Category enum of the selected program — R, 1 byte */
const LEA_PROGRAM_CATEGORY = '9c12a3db-9ce8-4865-a217-d394b3bc9311';

// ── Device Information Service (display only — no brand logic) ──

const DIS_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
const DIS_MANUFACTURER_NAME = '00002a29-0000-1000-8000-00805f9b34fb';

// ── Volume mapping (spec §3.1) ──
//
// GATT byte range is 1–255, monotonic with loudness; the UI slider is 0–100.
// Linear map: 0 → 1 (min), 100 → 255 (max), 50 ≈ 128 (RC mid step 6).

const MFI_VOLUME_MIN = 1;
const MFI_VOLUME_MAX = 255;

function volumeToMfi(level: number): number {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  return MFI_VOLUME_MIN + Math.round((clamped * (MFI_VOLUME_MAX - MFI_VOLUME_MIN)) / 100);
}

function mfiToVolume(mfi: number): number {
  const clamped = Math.max(MFI_VOLUME_MIN, Math.min(MFI_VOLUME_MAX, mfi));
  return Math.round(((clamped - MFI_VOLUME_MIN) * 100) / (MFI_VOLUME_MAX - MFI_VOLUME_MIN));
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

/** Decode a 60-byte fixed UTF-8 field, trimming at the first NUL */
function bytesToUtf8(bytes: number[]): string {
  const end = bytes.indexOf(0);
  const slice = end >= 0 ? bytes.slice(0, end) : bytes;
  let out = '';
  for (const b of slice) out += String.fromCharCode(b);
  try {
    return decodeURIComponent(escape(out)).trim();
  } catch {
    return out.trim();
  }
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

export class MfiAdapter implements HearingAidAdapter {
  readonly brand = 'mfi' as const;

  private device: Device | null = null;
  private deviceId: string | null = null;

  // Notification subscriptions (hardware button presses on the aid)
  private micAttNotifySub: Subscription | null = null;
  private streamAttNotifySub: Subscription | null = null;
  private programNotifySub: Subscription | null = null;
  private batteryNotifySub: Subscription | null = null;

  // Cached state (seeded from reads, kept current by notifications)
  private cachedVolume = 50;
  private cachedStreamVolume = 50;
  private cachedMuted = false;
  private cachedProgram = 0;
  private cachedBattery: number | null = null;
  private availableProgramsMask: number | null = null;
  private manufacturerName: string | null = null;

  /** Pre-mute attenuation for mute emulation restore (spec §3.1) */
  private preMuteMicAtt: number | null = null;

  // Callbacks (HearingAidAdapter interface)
  onRebootRequired?: (message: string) => void;
  onAndroidBondingRequired?: () => void;

  /** Returns connected device or throws */
  private get connected(): Device {
    if (!this.device) {
      throw new Error('MfiAdapter: not connected — call connect() first');
    }
    return this.device;
  }

  /** Read a single-byte LEA characteristic */
  private async readByte(charUuid: string): Promise<number> {
    const dev = this.connected;
    const char = await withRetry(() =>
      dev.readCharacteristicForService(LEA_SERVICE, charUuid),
    );
    if (!char.value) throw new Error(`MfiAdapter: empty read on ${charUuid}`);
    return base64ToBytes(char.value)[0];
  }

  /** Write a single-byte LEA characteristic (Write Request to get error codes) */
  private async writeByte(charUuid: string, value: number): Promise<void> {
    const dev = this.connected;
    const payload = bytesToBase64([value & 0xff]);
    await withRetry(() =>
      dev.writeCharacteristicWithResponseForService(LEA_SERVICE, charUuid, payload),
    );
  }

  /**
   * Read the LEAAvailablePrograms 4-byte LE bitmask.
   * Returns a u32 where bit N set = program N (0–15) fitted.
   */
  private async readAvailableProgramsMask(): Promise<number> {
    const dev = this.connected;
    const char = await withRetry(() =>
      dev.readCharacteristicForService(LEA_SERVICE, LEA_AVAILABLE_PROGRAMS),
    );
    if (!char.value) throw new Error('MfiAdapter: empty AvailablePrograms read');
    const bytes = base64ToBytes(char.value);
    let mask = 0;
    for (let i = 0; i < Math.min(4, bytes.length); i++) {
      mask |= bytes[i] << (8 * i);
    }
    // Convert to unsigned 32-bit
    this.availableProgramsMask = mask >>> 0;
    return this.availableProgramsMask;
  }

  /** True if program index is fitted per the available-programs bitmask */
  private isProgramFitted(index: number): boolean {
    if (index < 0 || index > 15) return false;
    if (this.availableProgramsMask == null) return true; // not read yet — don't block
    return (this.availableProgramsMask & (1 << index)) !== 0;
  }

  async connect(deviceId: string): Promise<void> {
    const manager = getBleManager();
    this.deviceId = deviceId;
    console.log(`[MfiAdapter] Connecting to ${deviceId}...`);

    this.device = await withRetry(() =>
      manager.connectToDevice(deviceId, { requestMTU: 255 }),
    );

    await this.device.discoverAllServicesAndCharacteristics();

    // Bond (spec §4.3): LEA control characteristics require an encrypted link.
    // Standard Android createBond() — expect Just Works (no UI) on a fresh aid;
    // Android 8+ negotiates LESC if the aid offers it. ASHA read-hack and GN
    // createBond variants are NOT applicable here.
    const bondState = await getBondState(deviceId);
    if (bondState !== BOND_BONDED) {
      console.log('[MfiAdapter] Initiating Android BLE bond (Just Works/LESC)...');
      this.onAndroidBondingRequired?.();
      await createBond(deviceId);
      console.log('[MfiAdapter] Android bond complete');
      // Re-discover — secured characteristics may not have been visible pre-bond
      await this.device.discoverAllServicesAndCharacteristics();
    } else {
      console.log('[MfiAdapter] Already Android-bonded');
    }

    // Verify the LEA service is present
    const services = await this.device.services();
    const hasLea = services.some(
      (s) => s.uuid.toLowerCase() === LEA_SERVICE,
    );
    if (!hasLea) {
      throw new Error('MfiAdapter: LEA (MFi hearing aid) service not found on this device');
    }

    // Read DIS manufacturer name for display only (no brand logic — spec task §8)
    try {
      const char = await this.device.readCharacteristicForService(
        DIS_SERVICE,
        DIS_MANUFACTURER_NAME,
      );
      if (char.value) {
        this.manufacturerName = bytesToUtf8(base64ToBytes(char.value)) || null;
        console.log(`[MfiAdapter] DIS manufacturer: ${this.manufacturerName}`);
      }
    } catch {
      console.log('[MfiAdapter] DIS manufacturer name not available');
    }

    // Seed state from reads
    try {
      this.cachedVolume = mfiToVolume(await this.readByte(LEA_MIC_ATTENUATION));
    } catch {
      console.log('[MfiAdapter] Initial mic attenuation read failed');
    }
    try {
      this.cachedStreamVolume = mfiToVolume(await this.readByte(LEA_STREAM_ATTENUATION));
    } catch {
      console.log('[MfiAdapter] Initial stream attenuation read failed');
    }
    try {
      this.cachedProgram = await this.readByte(LEA_CURRENT_ACTIVE_PROGRAM);
    } catch {
      console.log('[MfiAdapter] Initial program read failed');
    }
    try {
      await this.readAvailableProgramsMask();
      console.log(
        `[MfiAdapter] Available programs mask: 0x${this.availableProgramsMask!.toString(16)}`,
      );
    } catch {
      console.log('[MfiAdapter] AvailablePrograms read failed');
    }
    try {
      this.cachedBattery = await this.readByte(LEA_BATTERY_LEVEL);
    } catch {
      console.log('[MfiAdapter] Initial battery read failed');
    }

    // Subscribe to notifications so the UI tracks hardware button presses
    // on the aid (spec §3: LEA chars notify on change).
    try {
      this.micAttNotifySub = this.device.monitorCharacteristicForService(
        LEA_SERVICE,
        LEA_MIC_ATTENUATION,
        (error, char) => {
          if (error || !char?.value) return;
          const att = base64ToBytes(char.value)[0];
          this.cachedVolume = mfiToVolume(att);
          console.log(`[MfiAdapter] Mic attenuation notify: ${att} (${this.cachedVolume}%)`);
        },
      );
    } catch {
      console.log('[MfiAdapter] Mic attenuation subscription not available');
    }

    try {
      this.streamAttNotifySub = this.device.monitorCharacteristicForService(
        LEA_SERVICE,
        LEA_STREAM_ATTENUATION,
        (error, char) => {
          if (error || !char?.value) return;
          const att = base64ToBytes(char.value)[0];
          this.cachedStreamVolume = mfiToVolume(att);
          console.log(`[MfiAdapter] Stream attenuation notify: ${att} (${this.cachedStreamVolume}%)`);
        },
      );
    } catch {
      console.log('[MfiAdapter] Stream attenuation subscription not available');
    }

    try {
      this.programNotifySub = this.device.monitorCharacteristicForService(
        LEA_SERVICE,
        LEA_CURRENT_ACTIVE_PROGRAM,
        (error, char) => {
          if (error || !char?.value) return;
          this.cachedProgram = base64ToBytes(char.value)[0];
          console.log(`[MfiAdapter] Program notify: ${this.cachedProgram}`);
        },
      );
    } catch {
      console.log('[MfiAdapter] Program subscription not available');
    }

    try {
      this.batteryNotifySub = this.device.monitorCharacteristicForService(
        LEA_SERVICE,
        LEA_BATTERY_LEVEL,
        (error, char) => {
          if (error || !char?.value) return;
          this.cachedBattery = base64ToBytes(char.value)[0];
          console.log(`[MfiAdapter] Battery notify: ${this.cachedBattery}%`);
        },
      );
    } catch {
      console.log('[MfiAdapter] Battery subscription not available');
    }

    console.log('[MfiAdapter] Connection setup complete');
  }

  async disconnect(): Promise<void> {
    for (const sub of [
      this.micAttNotifySub,
      this.streamAttNotifySub,
      this.programNotifySub,
      this.batteryNotifySub,
    ]) {
      sub?.remove();
    }
    this.micAttNotifySub = null;
    this.streamAttNotifySub = null;
    this.programNotifySub = null;
    this.batteryNotifySub = null;

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
   * Set mic-path volume (0–100 UI scale → 1–255 GATT attenuation byte).
   * Spec §3.1: byte is monotonic with loudness; GATT clients may write the
   * full 1–255 range (the 13-step RC table quantizes only the physical RC).
   */
  async setVolume(level: number, _ear?: 'left' | 'right' | 'both'): Promise<void> {
    const att = volumeToMfi(level);
    await this.writeByte(LEA_MIC_ATTENUATION, att);
    this.cachedVolume = Math.max(0, Math.min(100, Math.round(level)));
  }

  /** Read mic attenuation from the aid and map to 0–100 */
  async getVolume(): Promise<number> {
    try {
      this.cachedVolume = mfiToVolume(await this.readByte(LEA_MIC_ATTENUATION));
    } catch {
      // fall through to cache
    }
    return this.cachedVolume;
  }

  /**
   * Mute emulation (spec §3.1) — EXPERIMENTAL.
   * Mute: store current mic attenuation, write 0.
   * Unmute: restore the stored value (fallback: mid-scale 128).
   * Note: firmware treatment of byte 0 vs 1 is unconfirmed (spec §4.7 #4).
   */
  async setMute(muted: boolean): Promise<void> {
    if (muted) {
      try {
        this.preMuteMicAtt = await this.readByte(LEA_MIC_ATTENUATION);
      } catch {
        this.preMuteMicAtt = volumeToMfi(this.cachedVolume);
      }
      await this.writeByte(LEA_MIC_ATTENUATION, 0);
    } else {
      await this.writeByte(LEA_MIC_ATTENUATION, this.preMuteMicAtt ?? 128);
      this.preMuteMicAtt = null;
    }
    this.cachedMuted = muted;
  }

  async getMute(): Promise<boolean> {
    return this.cachedMuted;
  }

  /**
   * Switch program. Validates the index against the LEAAvailablePrograms
   * bitmask before writing — firmware rejects invalid indices (spec §3.2).
   */
  async setProgram(index: number): Promise<void> {
    if (this.availableProgramsMask == null) {
      try {
        await this.readAvailableProgramsMask();
      } catch {
        // mask unavailable — attempt the write anyway and let firmware decide
      }
    }
    if (!this.isProgramFitted(index)) {
      throw new Error(
        `MfiAdapter: program ${index} is not fitted (mask 0x${(this.availableProgramsMask ?? 0).toString(16)})`,
      );
    }
    await this.writeByte(LEA_CURRENT_ACTIVE_PROGRAM, index);
    this.cachedProgram = index;
  }

  /** Read the active program index from the aid */
  async getProgram(): Promise<number> {
    try {
      this.cachedProgram = await this.readByte(LEA_CURRENT_ACTIVE_PROGRAM);
    } catch {
      // fall through to cache
    }
    return this.cachedProgram;
  }

  /**
   * Enumerate fitted programs from the bitmask, then read each name via
   * ProgramNameSelector → ProgramName (spec §3.2). Falls back to
   * "Program N+1" when a name read fails.
   */
  async getPrograms(): Promise<Program[]> {
    let mask: number;
    try {
      mask = await this.readAvailableProgramsMask();
    } catch {
      // Bitmask unreadable — return generic 4-program placeholder
      return [0, 1, 2, 3].map((i) => ({ index: i, name: `Program ${i + 1}` }));
    }

    const programs: Program[] = [];
    for (let i = 0; i < 16; i++) {
      if ((mask & (1 << i)) === 0) continue;

      let name = `Program ${i + 1}`;
      try {
        await this.writeByte(LEA_PROGRAM_NAME_SELECTOR, i);
        const dev = this.connected;
        const char = await withRetry(() =>
          dev.readCharacteristicForService(LEA_SERVICE, LEA_PROGRAM_NAME),
        );
        if (char.value) {
          const decoded = bytesToUtf8(base64ToBytes(char.value));
          if (decoded) name = decoded;
        }
      } catch {
        // keep placeholder name
      }
      programs.push({ index: i, name });
    }

    return programs.length > 0
      ? programs
      : [{ index: 0, name: 'Program 1' }];
  }

  /** Read LEABatteryLevel (0–100). Returns -1 on failure. */
  async getBattery(): Promise<number> {
    try {
      this.cachedBattery = await this.readByte(LEA_BATTERY_LEVEL);
      return this.cachedBattery;
    } catch {
      return this.cachedBattery ?? -1;
    }
  }

  /**
   * Set streaming-path volume (0–100 UI scale → 1–255 GATT byte).
   * Applies while the aid is streaming (spec §3.1).
   */
  async setStreamingVolume(level: number): Promise<void> {
    const att = volumeToMfi(level);
    await this.writeByte(LEA_STREAM_ATTENUATION, att);
    this.cachedStreamVolume = Math.max(0, Math.min(100, Math.round(level)));
  }

  async refreshState(): Promise<DriverState> {
    const [volume, activeProgram, batteryPercent] = await Promise.all([
      this.getVolume().catch(() => undefined),
      this.getProgram().catch(() => undefined),
      this.getBattery().catch(() => undefined),
    ]);

    let deviceInfo: DeviceInfo | undefined;
    if (this.device) {
      deviceInfo = {
        id: this.deviceId!,
        name: this.manufacturerName
          ? `MFi hearing aid (${this.manufacturerName})`
          : 'MFi hearing aid',
        brand: 'mfi',
      };
    }

    return {
      volume,
      muted: this.cachedMuted,
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
