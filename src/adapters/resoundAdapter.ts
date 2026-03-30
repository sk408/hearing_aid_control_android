/**
 * ReSound / GN Hearing BLE adapter
 *
 * ── Sources ──
 *
 * | Source                         | Artifact                                                              |
 * |--------------------------------|-----------------------------------------------------------------------|
 * | ILSpy decompile spec           | hearing_aid_control/docs/resound_gn_encryption_1.3.0_ilspy.md         |
 * | Decompiled C# (primary)        | artifacts/decompiled/resound_smart3d_1.3.0_ble/ (AESDeEncoder.cs,     |
 * |                                | P6TrustKeyHandler.cs, HandleBasedPlatform.cs, GNConstants.cs)         |
 * | Smart 3D 1.3.0 static GATT XML | hearing_aid_control/docs/resound_smart3d_1.3.0_ble_static.md          |
 * | Legacy Java client             | hearing_aid_control/docs/resound_legacy_ble_smart_3.3.1.md            |
 * | UUID dossier / master          | hearing_aid_control/docs/uuid_resound_dossier_2026-03-28.md           |
 * | APK provenance                 | ReSound Smart 3D_1.3.0_APKPure.apk → assemblies/BLE.dll              |
 *
 * ── Service placement ──
 *
 * GN command/notify/security/version/challenge/public-key UUIDs from ILSpy
 * belong under 0000fefe (or Palpatine 4d56d4f5), NOT e0262760. The e026
 * family appears on newer stacks; FEFE + command UUIDs are the primary path.
 * Fallback order: charServiceMap → FEFE → Palpatine P5 → e0262760.
 *
 * ── Three client eras ──
 *
 * (a) ReSound Smart 3.3.1 — pure Java, direct FEFE writes, no e026/1959a468.
 * (b) Smart 3D 1.3.0 — Xamarin BLE.dll, FEFE/Palpatine GATT + GNCommand/GNNotify.
 * (c) Smart 3D 1.43.1+ — adds e0262760 family alongside FEFE/command stack.
 *
 * ── Encryption ──
 *
 * Optional trusted bond; session uses AES counter keystream (AESDeEncoder),
 * keys from P6TrustKeyHandler (challenge + AppBaseKeys + ECDH P-256 + SHA-256).
 * Plaintext path: WriteDataToCommandInterfaceNoEncryption / discover [0x06].
 * Auth handshake: "APP says hi " → "HI says hi" verification.
 * See src/ble/gn/ for encryption implementation.
 *
 * ── CONFIRMED paths ──
 *
 *   ASHA volume:    00e4ca9e-ab14-41e4-8823-f9e70c7e91df
 *                   Signed int8 [-128..0] where 0 = max, -128 = min/mute.
 *                   Property: WRITE_NO_RESP (not WRITE).
 *
 *   MFi HAP service (7d74f4bd-c74a-4431-862c-cce884371592):
 *     Program name:  7be94a55-8d91-4592-bc0f-ea3664ccd3a9  R/W
 *     Program count: 7a62b786-f2ef-4afb-9aa8-81cc62a25862  R/N
 *     Ear side:      8d17ac2f-1d54-4742-a49a-ef4b20784eb3  R
 *
 *   Direct GN characteristics (under FEFE / P5 service):
 *     GNMicAttenuation:       32c9322d-6b17-11cf-0234-6f0da5eafd75  (0=mute, 1..255)
 *     GNStreamAttenuation:    054e99c7-ff34-1c12-59cd-e2c20d2e6743  (0=mute, 1..255)
 *     GNCurrentActiveProgram: dc82f820-63ac-f82f-1e89-372fde4151f4
 *
 *   GN Handle Protocol:
 *     write:    [0x03, handle, payload...]
 *     read:     [0x04, handle]
 *     blob:     [0x05, handle, 0x00, 0x00]
 *     discover: [0x06]
 *     Handles: 0x05=MicAtten, 0x06=StreamAtten, 0x08=ActiveProgram
 */
import type { Device } from 'react-native-ble-plx';
import { getBleManager } from '../ble/BleManager';
import { getBondState, createBond, BOND_BONDED } from '../ble/bleBond';
import type { HearingAidAdapter, DriverState } from './types';
import type { DeviceInfo, Feature, Program } from '../ble/types';
import { AESDeEncoder, PassthroughDeEncoder, selfTestAES } from '../ble/gn/aesDeEncoder';
import { P6TrustKeyHandler } from '../ble/gn/p6TrustKeyHandler';
import {
  GN_TRUSTED_APP_CHALLENGE_CHAR,
  GN_HI_PUBLIC_KEY_CHAR,
  GN_VERSION_CHAR,
  AUTH_HI_SAYS_HI,
  BOND_TYPE_BOOT_STAGE1,
  BOND_TYPE_BOOT_STAGE2,
  BOND_TYPE_PASSCODE,
  BOND_TYPE_RECONNECT,
} from '../ble/gn/gnConstants';
import {
  type GnBondInfo,
  type StoredBondData,
  createInitialBondInfo,
  storeBondData,
  loadBondData,
  parseSecurityCap,
  uint8ToBase64,
  base64ToUint8,
} from '../ble/gn/gnBondState';

// ── ASHA service + volume (CONFIRMED — SPEC.md §2.4, command_dictionary.md) ──

const ASHA_SERVICE = '0000fdf0-0000-1000-8000-00805f9b34fb';
const ASHA_VOLUME_CHAR = '00e4ca9e-ab14-41e4-8823-f9e70c7e91df';

// ── GN services — FEFE (primary) → Palpatine P5 → e0262760 (newer stacks) ──

const GN_FEFE_SERVICE = '0000fefe-0000-1000-8000-00805f9b34fb';
const GN_PALPATINE_SERVICE = '4d56d4f5-af39-4885-9525-9f68c18ff451';
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

/** GN bond notify: opcode 0x01, then auth status (AuthException.ThrowAuthExceptionOnCode). */
const AUTH_STATUS_OK = 0;
/** BLE.dll FAIL_HI_WAITS_FOR_REBOOT — only this code uses SetSharedAppKey after reboot. */
const AUTH_HI_WAITS_FOR_REBOOT = 21; // 0x15
/** Observed on some firmware before power-cycle; DLL maps to AuthNotAccepted — use full ECDH after reboot. */
const AUTH_FW_REBOOT_HINT = 0x13;

/** Bond ack status bytes that may appear before the 0x00 + ciphertext completion notify. */
const BOND_ACK_INTERIM_STATUSES = new Set<number>([0x02]);
/** Microphone / HA gain (not streaming-only ASHA volume) — handle 0x05 */
const GN_MIC_ATTENUATION_CHAR = '32c9322d-6b17-11cf-0234-6f0da5eafd75';
/** Streaming attenuation — handle 0x06, 0=mute 1..255 */
const GN_STREAM_ATTENUATION_CHAR = '054e99c7-ff34-1c12-59cd-e2c20d2e6743';

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
  /** All discovered service UUIDs (lowercase), populated during connect */
  private discoveredServices = new Set<string>();
  /** Cached resolved GN service UUID (FEFE → P5 → e026 chain) */
  private gnResolvedService: string | null = null;

  /** GN notify data handler — replaced temporarily during discover() */
  private onGnNotify: (data: number[]) => void = () => {};

  /** Queue of notify responses that arrived before a waiter was registered */
  private pendingNotifyQueue: number[][] = [];
  /** Registered waiters for the next notify response */
  private notifyWaiters: Array<(data: number[]) => void> = [];

  // ── Encryption state (Phase C) ──

  /** Current encoder: PassthroughDeEncoder (default) or AESDeEncoder (after bond) */
  private encoder: PassthroughDeEncoder | AESDeEncoder = new PassthroughDeEncoder();
  /** Bond state tracking */
  private bondInfo: GnBondInfo = createInitialBondInfo();
  /** Trust key handler — manages ECDH + SHA-256 derivation during bond */
  private trustKeyHandler: P6TrustKeyHandler | null = null;

  public onRebootRequired?: (message: string) => void;
  public onAndroidBondingRequired?: () => void;

  private get connected(): Device {
    if (!this.device) {
      throw new Error('ResoundAdapter: not connected — call connect() first');
    }
    return this.device;
  }

  // ── Connection ──

  async connect(deviceId: string): Promise<void> {
    selfTestAES();
    const manager = getBleManager();
    this.deviceId = deviceId;

    this.device = await withRetry(() =>
      manager.connectToDevice(deviceId, { requestMTU: 512 }),
    );

    await this.device.discoverAllServicesAndCharacteristics();
    await this.buildCharacteristicMap();

    // Step 1: Ensure Android-level BLE bond exists before GN trust.
    //
    // react-native-ble-plx has no bonding API.  On Android 6+, the OS no
    // longer auto-initiates bonding from a GATT auth failure — createBond()
    // must be called explicitly.  We use the native BleBond module for this.
    const bondState = await getBondState(deviceId);
    if (bondState !== BOND_BONDED) {
      console.log('[ResoundAdapter] Initiating Android BLE bond...');
      this.onAndroidBondingRequired?.(); // inform UI that pairing dialog may appear
      await createBond(deviceId); // waits up to 60s for BOND_BONDED, throws on reject
      console.log('[ResoundAdapter] Android bond complete');
    } else {
      console.log('[ResoundAdapter] Already Android-bonded');
    }

    await this.setupGnNotify();

    // Step 2: GN application-level trust (only after Android bond is confirmed)
    try {
      const stored = loadBondData(this.deviceId);
      if (stored) {
        const bonded = await this.establishTrustedBond();
        if (!bonded) {
          console.log('[ResoundAdapter] Reconnect bond failed, trying boot bond...');
          await this.createTrustedBondBoot();
        }
      } else {
        console.log('[ResoundAdapter] No stored bond — starting boot bond...');
        await this.createTrustedBondBoot();
      }
    } catch (e) {
      console.warn('[ResoundAdapter] Trust handshake failed (plaintext fallback):', e);
    }
  }

  async disconnect(): Promise<void> {
    this.teardownGnNotify();
    if (this.device) {
      try {
        await this.device.cancelConnection();
      } catch {
        // Device may already be disconnected
      }
      this.device = null;
      this.deviceId = null;
      this.charServiceMap.clear();
      this.discoveredServices.clear();
      this.gnResolvedService = null;
      this.gnTrustBootstrapDone = false;
      this.encoder = new PassthroughDeEncoder();
      this.bondInfo = createInitialBondInfo();
      this.trustKeyHandler = null;
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

  // ── Streaming volume ──
  //
  // Primary: GN stream attenuation (054e99c7 / handle 0x06).
  // Fallback: ASHA volume (streaming-oriented int8).

  async setStreamingVolume(level: number): Promise<void> {
    const clampedLevel = Math.max(0, Math.min(100, level));
    await this.ensureGnTrustBootstrap();

    const attenuation =
      clampedLevel <= 0
        ? 0
        : Math.max(1, Math.min(255, Math.round((clampedLevel / 100) * 255)));

    let program = await this.readRawActiveProgramIndex();
    if (program === null) program = 0;

    // Try direct GN stream attenuation characteristic
    const streamKey = GN_STREAM_ATTENUATION_CHAR.toLowerCase();
    if (this.charServiceMap.has(streamKey)) {
      const svc = this.findService(GN_STREAM_ATTENUATION_CHAR);
      try {
        await this.writeCharacteristicBothModes(svc, GN_STREAM_ATTENUATION_CHAR, [
          program,
          attenuation,
        ]);
        return;
      } catch {
        try {
          await this.writeCharacteristicBothModes(svc, GN_STREAM_ATTENUATION_CHAR, [
            attenuation,
          ]);
          return;
        } catch {
          // try command tunnel
        }
      }
    }

    // Try GN command tunnel — handle 0x06 = GNStreamAttenuation
    try {
      await this.writeGnCommandFrame([0x03, 0x06, program, attenuation]);
      return;
    } catch {
      // ASHA fallback
    }

    await this.setVolumeAsha(clampedLevel);
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
    return ['volume', 'mute', 'battery', 'program', 'streaming'];
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
        this.discoveredServices.add(service.uuid.toLowerCase());
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
   * Prefers charServiceMap (live discovery); then known non-GN services;
   * then FEFE → Palpatine P5 → e0262760 for GN UUIDs.
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
    // GN chars: FEFE → Palpatine P5 → e0262760 fallback
    return this.resolveGnService();
  }

  /**
   * Resolve the GN service UUID from discovered services.
   * Priority: FEFE (primary for Smart 3D 1.3.0) → Palpatine P5 → e0262760 (newer).
   * Cached after first resolution per connection.
   */
  private resolveGnService(): string {
    if (this.gnResolvedService) return this.gnResolvedService;

    if (this.discoveredServices.has(GN_FEFE_SERVICE.toLowerCase())) {
      this.gnResolvedService = GN_FEFE_SERVICE;
    } else if (this.discoveredServices.has(GN_PALPATINE_SERVICE.toLowerCase())) {
      this.gnResolvedService = GN_PALPATINE_SERVICE;
    } else {
      this.gnResolvedService = GN_SERVICE;
    }

    console.log('[ResoundAdapter] GN service resolved:', this.gnResolvedService);
    return this.gnResolvedService;
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

  /**
   * Write a GN command frame, encrypting when in a trusted session.
   * From HandleBasedPlatform.SetData: encoder.Encrypt(fullFrame) when trusted.
   */
  private async writeGnCommandFrame(frame: number[]): Promise<void> {
    const cmdSvc = this.findService(GN_COMMAND_CHAR);
    const dev = this.connected;

    let payload: number[];
    if (this.bondInfo.trusted && !(this.encoder instanceof PassthroughDeEncoder)) {
      const encrypted = this.encoder.encrypt(new Uint8Array(frame));
      payload = Array.from(encrypted);
    } else {
      payload = frame;
    }

    const b64 = bytesToBase64(payload);
    try {
      await withRetry(() =>
        dev.writeCharacteristicWithResponseForService(cmdSvc, GN_COMMAND_CHAR, b64),
      );
    } catch {
      await withRetry(() =>
        dev.writeCharacteristicWithoutResponseForService(cmdSvc, GN_COMMAND_CHAR, b64),
      );
    }
  }

  /**
   * Write raw bytes to GNCommand without encryption.
   * From HandleBasedPlatform.WriteDataToCommandInterfaceNoEncryption.
   * Use when encryption must be bypassed (e.g., initial discover in some states).
   */
  private async writeGnCommandFrameNoEncryption(frame: number[]): Promise<void> {
    const cmdSvc = this.findService(GN_COMMAND_CHAR);
    const b64 = bytesToBase64(frame);
    const dev = this.connected;
    try {
      await withRetry(() =>
        dev.writeCharacteristicWithResponseForService(cmdSvc, GN_COMMAND_CHAR, b64),
      );
    } catch {
      await withRetry(() =>
        dev.writeCharacteristicWithoutResponseForService(cmdSvc, GN_COMMAND_CHAR, b64),
      );
    }
  }

  /**
   * Drop the active notify subscription and clear waiter queues.
   * Required after GATT reconnect (e.g. HI reboot during boot bond): the old
   * monitor is tied to the previous connection; keeping it blocks re-subscribe.
   */
  private teardownGnNotify(): void {
    if (this.notifySubscription) {
      try {
        this.notifySubscription.remove();
      } catch {
        // Already torn down or connection dead
      }
      this.notifySubscription = null;
    }
    this.notifyWaiters = [];
    this.pendingNotifyQueue = [];
  }

  /**
   * Subscribe to GN Notify for handle-based response data.
   * Safe to call again after reconnect — always tears down any prior monitor first.
   *
   * Opcodes (from HandleBasedPlatform.Notification switch):
   *   0x01 = Bond ack           0x05 = Blob data
   *   0x02 = Notification vector 0x06 = Discover response
   *   0x03 = Read out           0x07 = Discover end
   *   0x04 = Notification payload 0x08 = Error
   */
  private async setupGnNotify(): Promise<void> {
    this.teardownGnNotify();

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
            const raw = base64ToBytes(characteristic.value);
            // Notification handler: strip opcode (first byte), decrypt remainder if trusted
            // From HandleBasedPlatform.Notification (non-DFU path)
            let data: number[];
            if (raw.length > 1 && this.bondInfo.trusted &&
                !(this.encoder instanceof PassthroughDeEncoder)) {
              const opcode = raw[0];
              const decrypted = this.encoder.decrypt(new Uint8Array(raw.slice(1)));
              data = [opcode, ...Array.from(decrypted)];
            } else {
              data = raw;
            }
            this.parseGnNotify(data);
            this.onGnNotify(data);

            // Feed any pending waiters (bond notify race condition fix)
            const waiter = this.notifyWaiters.shift();
            if (waiter) {
              waiter(data);
            } else {
              this.pendingNotifyQueue.push(data);
            }
          }
        },
      );
    } catch {
      console.warn(
        '[ResoundAdapter] GN notify subscription failed — handle protocol unavailable',
      );
    }
  }

  /**
   * Parse and log GN notify payload by opcode.
   * Opcode is the first byte; remainder is opcode-specific data.
   * From HandleBasedPlatform.Notification in decompiled Smart 3D 1.3.0.
   */
  private parseGnNotify(data: number[]): void {
    const hex = (b: number) => '0x' + b.toString(16).padStart(2, '0');
    const hexDump = data.map(hex).join(' ');

    if (data.length === 0) {
      console.warn('[ResoundAdapter] GN notify: empty payload');
      return;
    }

    const opcode = data[0];
    const payload = data.slice(1);

    switch (opcode) {
      case 0x01:
        console.log('[ResoundAdapter] GN notify [0x01 Bond Ack]:', hexDump);
        break;
      case 0x02:
        console.log('[ResoundAdapter] GN notify [0x02 Notification Vector]:', hexDump);
        break;
      case 0x03:
        console.log(
          '[ResoundAdapter] GN notify [0x03 Read Out] handle=',
          payload.length > 0 ? hex(payload[0]) : '?',
          'data=',
          payload.slice(1).map(hex).join(' '),
        );
        break;
      case 0x04:
        console.log('[ResoundAdapter] GN notify [0x04 Notification Payload]:', hexDump);
        break;
      case 0x05:
        console.log('[ResoundAdapter] GN notify [0x05 Blob]:', hexDump);
        break;
      case 0x06:
        console.log('[ResoundAdapter] GN notify [0x06 Discover]:', hexDump);
        break;
      case 0x07:
        console.log('[ResoundAdapter] GN notify [0x07 Discover End]:', hexDump);
        break;
      case 0x08:
        this.logGnError(payload);
        break;
      default:
        console.log('[ResoundAdapter] GN notify [unknown opcode', hex(opcode), ']:', hexDump);
        // Check if payload looks encrypted
        if (data.length >= 8 && looksEncrypted(data)) {
          console.warn(
            '[ResoundAdapter] ⚠ Payload may be encrypted — trusted bond / AES session ' +
            'may be required. See src/ble/gn/ for encryption support.',
          );
        }
        break;
    }
  }

  /**
   * Log GN error opcode (0x08) tuples in plain English.
   * Error format: [errorType, handle, errorCode, ...]
   * From HandleBasedPlatform error handling.
   */
  private logGnError(payload: number[]): void {
    const hex = (b: number) => '0x' + b.toString(16).padStart(2, '0');

    if (payload.length < 3) {
      console.warn(
        '[ResoundAdapter] GN notify [0x08 Error] short payload:',
        payload.map(hex).join(' '),
      );
      return;
    }

    const errType = payload[0];
    const handle = payload[1];
    const errCode = payload[2];

    const errCodeNames: Record<number, string> = {
      0x01: 'invalid handle',
      0x02: 'read not permitted',
      0x03: 'write not permitted',
      0x06: 'request not supported',
      0x0d: 'invalid attribute length',
      0x0e: 'insufficient encryption',
      0x10: 'insufficient resources',
      0x81: 'not permitted (vendor)',
      0x82: 'invalid state (vendor)',
      0xfe: 'out of range',
      0xff: 'procedure in progress',
    };

    const errName = errCodeNames[errCode] ?? `unknown (${hex(errCode)})`;
    console.warn(
      `[ResoundAdapter] GN notify [0x08 Error] type=${hex(errType)} ` +
      `handle=${hex(handle)} error=${errName}`,
    );

    if (errCode === 0x0e) {
      console.warn(
        '[ResoundAdapter] ⚠ "Insufficient encryption" — device requires trusted bond. ' +
        'Establish AES session via src/ble/gn/ encryption before retrying.',
      );
    }
  }

  // ── Encryption integration (Phase C) ──

  /**
   * Write notification vector — 17-byte encrypted payload (0x01 + 16-byte bitfield).
   * From HandleBasedPlatform.WriteNotificationVector: needed for subscriptions
   * on handle-controlled characteristics.
   */
  async writeNotificationVector(bitfield: Uint8Array): Promise<void> {
    if (bitfield.length !== 16) {
      throw new Error('WriteNotificationVector: bitfield must be 16 bytes');
    }
    const vector = new Uint8Array(17);
    vector[0] = 0x01;
    vector.set(bitfield, 1);

    const payload = this.bondInfo.trusted && !(this.encoder instanceof PassthroughDeEncoder)
      ? this.encoder.encrypt(vector)
      : vector;

    const cmdSvc = this.findService(GN_COMMAND_CHAR);
    const b64 = bytesToBase64(Array.from(payload));
    try {
      await withRetry(() =>
        this.connected.writeCharacteristicWithResponseForService(
          cmdSvc, GN_COMMAND_CHAR, b64,
        ),
      );
    } catch {
      await withRetry(() =>
        this.connected.writeCharacteristicWithoutResponseForService(
          cmdSvc, GN_COMMAND_CHAR, b64,
        ),
      );
    }
  }

  /**
   * Establish a trusted bond using stored SharedAppSecret (reconnect path).
   *
   * From HandleBasedPlatform.EstablishTrustedBond:
   *   1. Read security capability → version, keyIndex
   *   2. Read challenge from GNTrustedAppChallenge
   *   3. Read HI public key from GNHIPublicKey
   *   4. P6TrustKeyHandler: UpdateChallenge → SetHIPublicKey → SetSharedAppKey → GenerateKeys
   *   5. GenerateAuth(type=4) → write to GNTrustedAppChallenge
   *   6. Await GNNotify → decrypt → verify "HI says hi"
   *
   * @returns true if trusted bond established, false otherwise
   */
  async establishTrustedBond(): Promise<boolean> {
    if (!this.deviceId) throw new Error('Not connected');

    // Check for stored bond data
    const stored = loadBondData(this.deviceId);
    if (!stored) {
      console.log('[ResoundAdapter] No stored bond data — cannot reconnect-bond');
      return false;
    }

    try {
      this.bondInfo = { ...createInitialBondInfo(), mode: 'reconnect', phase: 'reading_challenge' };
      this.pendingNotifyQueue = [];
      this.notifyWaiters = [];
      const gnSvc = this.resolveGnService();

      // Step 1: Read security capability
      const secCapKey = GN_SECURITY_CAP_CHAR.toLowerCase();
      let version = 0;
      let keyIndex = 0;
      if (this.charServiceMap.has(secCapKey)) {
        try {
          const capChar = await withRetry(() =>
            this.connected.readCharacteristicForService(gnSvc, GN_SECURITY_CAP_CHAR),
          );
          if (capChar.value) {
            const capData = new Uint8Array(base64ToBytes(capChar.value));
            const parsed = parseSecurityCap(capData);
            version = parsed.version;
            keyIndex = parsed.keyIndex;
          }
        } catch (e) {
          console.warn('[ResoundAdapter] Security cap read failed:', e);
        }
      }
      this.bondInfo.version = version;
      this.bondInfo.keyIndex = keyIndex;

      // Step 2: Read challenge
      const challengeChar = await withRetry(() =>
        this.connected.readCharacteristicForService(gnSvc, GN_TRUSTED_APP_CHALLENGE_CHAR),
      );
      if (!challengeChar.value) throw new Error('No challenge data');
      const challenge = new Uint8Array(base64ToBytes(challengeChar.value));

      // Step 3: Read HI public key
      this.bondInfo.phase = 'reading_public_key';
      const hiPubKeyChar = await withRetry(() =>
        this.connected.readCharacteristicForService(gnSvc, GN_HI_PUBLIC_KEY_CHAR),
      );
      if (!hiPubKeyChar.value) throw new Error('No HI public key');
      const hiPublicKey = new Uint8Array(base64ToBytes(hiPubKeyChar.value));

      // Step 4: Key derivation
      this.bondInfo.phase = 'generating_keys';
      const handler = new P6TrustKeyHandler();
      handler.updateChallenge(challenge, version, keyIndex);
      handler.setHIPublicKey(hiPublicKey);
      handler.setSharedAppKey(base64ToUint8(stored.sharedAppSecret));

      const aesEncoder = new AESDeEncoder();
      handler.generateKeys(aesEncoder);
      this.trustKeyHandler = handler;

      // Step 5: Generate and write auth
      this.bondInfo.phase = 'writing_auth';
      const auth = handler.generateAuth(aesEncoder, BOND_TYPE_RECONNECT, stored.sharedAppIndex);
      const authB64 = bytesToBase64(Array.from(auth));

      // Set up listener BEFORE writing (prevents race condition)
      const responsePromise = this.awaitGnNotifyResponse(15000);

      await withRetry(() =>
        this.connected.writeCharacteristicWithResponseForService(
          gnSvc, GN_TRUSTED_APP_CHALLENGE_CHAR, authB64,
        ),
      );

      // Step 6: Await and verify response
      this.bondInfo.phase = 'awaiting_response';
      const response = await responsePromise;
      if (!response || response.length < 2) {
        throw new Error('No bond response from HI');
      }

      this.bondInfo.phase = 'verifying';
      this.assertNoFatalBondAuthStatus('EstablishTrustedBond', response, BOND_ACK_INTERIM_STATUSES);
      if (response[0] !== 0x01 || response[1] !== AUTH_STATUS_OK || response.length < 3) {
        throw new Error('Unexpected reconnect bond notify shape');
      }
      const decrypted = aesEncoder.decrypt(new Uint8Array(response.slice(2)));
      const responseText = utf8Decode(decrypted.slice(1));

      if (!responseText.includes(AUTH_HI_SAYS_HI)) {
        console.warn('[ResoundAdapter] Bond verification failed — response:', responseText);
        this.bondInfo.phase = 'failed';
        return false;
      }

      // Success — switch to AES encoder
      this.encoder = aesEncoder;
      this.bondInfo.phase = 'trusted';
      this.bondInfo.trusted = true;
      console.log('[ResoundAdapter] Trusted bond established (reconnect)');
      return true;

    } catch (e) {
      console.warn('[ResoundAdapter] EstablishTrustedBond failed:', e);
      this.bondInfo.phase = 'failed';
      return false;
    }
  }

  /**
   * Re-negotiate ATT MTU after reconnect. Boot auth writes are ~80+ bytes; at
   * default MTU 23, write-with-response fails on Android until MTU is raised.
   */
  private async ensureNegotiatedMtu(requested: number = 512): Promise<void> {
    try {
      await withRetry(async () => {
        const d = await this.connected.requestMTU(requested);
        if (d.mtu < 64) {
          console.warn('[ResoundAdapter] MTU still small after request:', d.mtu);
        }
      });
    } catch (e) {
      console.warn('[ResoundAdapter] MTU request failed:', e);
    }
  }

  /**
   * Write GNTrustedAppChallenge — try with response, then without (property / state dependent).
   */
  private async writeTrustedChallengeAuth(serviceUuid: string, auth: Uint8Array): Promise<void> {
    const b64 = bytesToBase64(Array.from(auth));
    const dev = this.connected;
    try {
      await withRetry(() =>
        dev.writeCharacteristicWithResponseForService(serviceUuid, GN_TRUSTED_APP_CHALLENGE_CHAR, b64),
      );
      return;
    } catch (e) {
      console.warn('[ResoundAdapter] TrustedChallenge write with response failed, trying without:', e);
    }
    await withRetry(() =>
      dev.writeCharacteristicWithoutResponseForService(serviceUuid, GN_TRUSTED_APP_CHALLENGE_CHAR, b64),
    );
  }

  /**
   * HandleBasedPlatform.ReadTrustConnectionParameters — write before security cap read.
   */
  private async gnSecurityCapPrimeWrite(gnSvc: string): Promise<void> {
    const key = GN_SECURITY_CAP_CHAR.toLowerCase();
    if (!this.charServiceMap.has(key)) return;
    try {
      await this.writeCharacteristicBothModes(gnSvc, GN_SECURITY_CAP_CHAR, [4, 0, 0, 0, 0]);
    } catch {
      // Best-effort; some stacks already primed
    }
  }

  /**
   * Bond notify 0x01 [status]: fail on non-OK status unless exempt (reboot hints).
   */
  private assertNoFatalBondAuthStatus(
    context: string,
    data: number[],
    exempt: ReadonlySet<number>,
  ): void {
    if (data.length < 2 || data[0] !== 0x01) return;
    const st = data[1];
    if (st === AUTH_STATUS_OK || exempt.has(st)) return;
    const label =
      st === 13
        ? 'Credentials rejected'
        : st === 19
          ? 'Auth not accepted'
          : st === 2
            ? 'Auth timeout'
            : `Auth status ${st}`;
    throw new Error(`${context}: ${label} (0x${st.toString(16)})`);
  }

  /**
   * RespondeWithAuth: copy from index 2, decrypt, UTF-8 "HI says hi" at plaintext[1..],
   * SharedAppIndex = plaintext[0] (HandleBasedPlatform ~746–760).
   */
  private parseBondAuthDecryptOk(aesEncoder: AESDeEncoder, data: number[]): { sharedAppIndex: number } | null {
    if (data.length < 3 || data[0] !== 0x01 || data[1] !== AUTH_STATUS_OK) return null;
    const cipher = data.slice(2);
    if (cipher.length < 2) return null;
    try {
      const dec = aesEncoder.decrypt(new Uint8Array(cipher));
      console.log('[Crypto Debug] Decrypted response:', Array.from(dec).map(b => '0x' + b.toString(16).padStart(2,'0')).join(' '));
      console.log('[Crypto Debug] Decoded text:', utf8Decode(dec.slice(1)));
      if (dec.length < 2) return null;
      const text = utf8Decode(dec.slice(1));
      if (text !== AUTH_HI_SAYS_HI && !text.includes(AUTH_HI_SAYS_HI)) return null;
      return { sharedAppIndex: dec[0] };
    } catch {
      return null;
    }
  }

  /**
   * Boot bond stage 1 only (HandleBasedPlatform.CreateTrustedBondUsingBoot):
   * security cap + challenge + HI public key + ECDH → GenerateKeys.
   * Stage 2 after HI reboot uses {@link prepareBootBondStage2AfterReboot} instead
   * (SetSharedAppKey from stage-1 SharedAppKey — no second SetHIPublicKey).
   */
  private async prepareBootBondMaterial(gnSvc: string): Promise<{
    handler: P6TrustKeyHandler;
    aesEncoder: AESDeEncoder;
    keyIndex: number;
  }> {
    try {
      if (this.charServiceMap.has(GN_VERSION_CHAR.toLowerCase())) {
        await this.connected.readCharacteristicForService(gnSvc, GN_VERSION_CHAR);
        console.log('[Crypto Debug] GN version read OK');
      }
    } catch (e) {
      console.log('[Crypto Debug] GN version read failed (continuing):', e);
    }

    await this.gnSecurityCapPrimeWrite(gnSvc);

    let version = 0;
    let keyIndex = 0;
    let capChar: { value: string | null } | undefined;
    const secCapKey = GN_SECURITY_CAP_CHAR.toLowerCase();
    if (this.charServiceMap.has(secCapKey)) {
      try {
        capChar = await withRetry(() =>
          this.connected.readCharacteristicForService(gnSvc, GN_SECURITY_CAP_CHAR),
        );
        if (capChar.value) {
          const parsed = parseSecurityCap(new Uint8Array(base64ToBytes(capChar.value)));
          version = parsed.version;
          keyIndex = parsed.keyIndex;
        }
      } catch { /* defaults */ }
    }
    const secCapAllBytes = capChar?.value ? Array.from(new Uint8Array(base64ToBytes(capChar.value))).map(b => '0x' + b.toString(16).padStart(2,'0')).join(' ') : 'not read';
    const bondMethodByte = capChar?.value ? new Uint8Array(base64ToBytes(capChar.value))[4] : -1;
    const bondMethodName = bondMethodByte === 1 ? 'Boot' : bondMethodByte === 2 ? 'Passcode' : bondMethodByte === 3 ? 'DFU' : `Unknown(${bondMethodByte})`;
    console.log('[Crypto Debug] Security cap ALL bytes:', secCapAllBytes);
    console.log('[Crypto Debug] Security cap — version:', version, 'keyIndex:', keyIndex, 'bondMethod:', bondMethodName);
    this.bondInfo.version = version;
    this.bondInfo.keyIndex = keyIndex;

    this.bondInfo.phase = 'reading_challenge';
    const challengeChar = await withRetry(() =>
      this.connected.readCharacteristicForService(gnSvc, GN_TRUSTED_APP_CHALLENGE_CHAR),
    );
    if (!challengeChar.value) throw new Error('No challenge data');
    const challenge = new Uint8Array(base64ToBytes(challengeChar.value));
    console.log('[Crypto Debug] Challenge (hex):', Array.from(challenge).map(b => b.toString(16).padStart(2, '0')).join(' '), '(' + challenge.length + ' bytes)');
    console.log('[Crypto Debug] Challenge byte[4] (bond method from sec cap):', bondMethodByte, bondMethodName);

    this.bondInfo.phase = 'reading_public_key';
    const hiPubKeyChar = await withRetry(() =>
      this.connected.readCharacteristicForService(gnSvc, GN_HI_PUBLIC_KEY_CHAR),
    );
    if (!hiPubKeyChar.value) throw new Error('No HI public key');
    const hiPublicKey = new Uint8Array(base64ToBytes(hiPubKeyChar.value));

    this.bondInfo.phase = 'generating_keys';
    const handler = new P6TrustKeyHandler();
    handler.updateChallenge(challenge, version, keyIndex);
    console.log('[Crypto Debug] updateChallenge done — commonSecret set');
    handler.setHIPublicKey(hiPublicKey);
    console.log('[Crypto Debug] setHIPublicKey done');
    const aesEncoder = new AESDeEncoder();
    handler.generateKeys(aesEncoder);
    console.log('[Crypto Debug] generateKeys done');
    this.trustKeyHandler = handler;
    return { handler, aesEncoder, keyIndex };
  }

  /**
   * Boot stage 2 after HI reboot (HandleBasedPlatform lines 895–903):
   * Discover + read challenge (≥36 bytes), new P6TrustKeyHandler, UpdateChallenge,
   * SetSharedAppKey(stage1 SharedAppKey) — not SetHIPublicKey — then GenerateKeys.
   * Stage-2 GenerateAuth therefore has no trailing app DH pubkey bytes (C# publicDHKey null).
   */
  private async prepareBootBondStage2AfterReboot(
    gnSvc: string,
    stage1SharedAppKey: Uint8Array,
  ): Promise<{ handler: P6TrustKeyHandler; aesEncoder: AESDeEncoder; keyIndex: number }> {
    await this.gnSecurityCapPrimeWrite(gnSvc);

    let version = 0;
    let keyIndex = 0;
    const secCapKey = GN_SECURITY_CAP_CHAR.toLowerCase();
    if (this.charServiceMap.has(secCapKey)) {
      try {
        const capChar = await withRetry(() =>
          this.connected.readCharacteristicForService(gnSvc, GN_SECURITY_CAP_CHAR),
        );
        if (capChar.value) {
          const parsed = parseSecurityCap(new Uint8Array(base64ToBytes(capChar.value)));
          version = parsed.version;
          keyIndex = parsed.keyIndex;
        }
      } catch { /* defaults */ }
    }
    this.bondInfo.version = version;
    this.bondInfo.keyIndex = keyIndex;

    this.bondInfo.phase = 'reading_challenge';
    const challengeChar = await withRetry(() =>
      this.connected.readCharacteristicForService(gnSvc, GN_TRUSTED_APP_CHALLENGE_CHAR),
    );
    if (!challengeChar.value) throw new Error('No challenge data after reboot');
    const challenge = new Uint8Array(base64ToBytes(challengeChar.value));
    if (challenge.length < 36) {
      throw new Error(`Challenge too short after reboot (${challenge.length}), expected ≥36`);
    }

    this.bondInfo.phase = 'generating_keys';
    const handler = new P6TrustKeyHandler();
    handler.updateChallenge(challenge, version, keyIndex);
    handler.setSharedAppKey(stage1SharedAppKey);
    const aesEncoder = new AESDeEncoder();
    handler.generateKeys(aesEncoder);
    this.trustKeyHandler = handler;
    return { handler, aesEncoder, keyIndex };
  }

  /**
   * Boot verification notify: 0x01 uses ciphertext from byte 2 (RespondeWithAuth); 0x04 fallback strips opcode only.
   */
  private tryParseBootBondVerification(aesEncoder: AESDeEncoder, data: number[]): number | null {
    if (data.length < 1) return null;
    if (data[0] === 0x01) {
      const r = this.parseBondAuthDecryptOk(aesEncoder, data);
      return r ? r.sharedAppIndex : null;
    }
    if (data[0] === 0x04 && data.length >= 2) {
      try {
        const decrypted = aesEncoder.decrypt(new Uint8Array(data.slice(1)));
        if (decrypted.length < 2) return null;
        const text = utf8Decode(decrypted.slice(1));
        if (!text.includes(AUTH_HI_SAYS_HI)) return null;
        return decrypted[0];
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * After stage-2 write, accept bond ack (e.g. 0x01 0x02) then wait for verification notify.
   * Returns SharedAppIndex from first decrypted byte (boot bond completion).
   */
  private async awaitBootBondVerification(
    aesEncoder: AESDeEncoder,
    firstPacket: number[] | null,
    timeoutMs: number,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let next: number[] | null = firstPacket;

    while (Date.now() < deadline) {
      if (next) {
        this.assertNoFatalBondAuthStatus('Boot bond verify', next, BOND_ACK_INTERIM_STATUSES);
        const idx = this.tryParseBootBondVerification(aesEncoder, next);
        if (idx !== null) return idx;
      }
      const waitMs = Math.min(20000, Math.max(0, deadline - Date.now()));
      if (waitMs <= 0) break;
      next = await this.awaitGnNotifyResponse(waitMs);
    }

    if (next) {
      this.assertNoFatalBondAuthStatus('Boot bond verify', next, BOND_ACK_INTERIM_STATUSES);
      const idx = this.tryParseBootBondVerification(aesEncoder, next);
      if (idx !== null) return idx;
    }
    throw new Error('Bond verification: "HI says hi" not found in GN notifies');
  }

  /**
   * Create a trusted bond using boot authentication (two-stage).
   *
   * From HandleBasedPlatform.CreateTrustedBondUsingBoot:
   *   Stage 1: GenerateAuth(type=1) → may trigger HI reboot
   *   Stage 2: GenerateAuth(type=2) → completes the bond
   *   Persist SharedAppSecret + SharedAppIndex for future reconnect.
   *
   * @returns true if bond established
   */
  async createTrustedBondBoot(): Promise<boolean> {
    if (!this.deviceId) throw new Error('Not connected');
    console.log('[ResoundAdapter] Starting boot bond flow...');

    try {
      this.bondInfo = { ...createInitialBondInfo(), mode: 'boot', phase: 'reading_challenge' };
      this.pendingNotifyQueue = [];
      this.notifyWaiters = [];
      const gnSvc = this.resolveGnService();

      let { handler, aesEncoder, keyIndex } = await this.prepareBootBondMaterial(gnSvc);
      /** Stage-1 SharedAppKey — required for SetSharedAppKey after HI reboot (BLE.dll boot bond). */
      let bootStage1SharedKey: Uint8Array | null = null;

      // Stage 1: GenerateAuth type 1 — third byte is always 0 in CreateTrustedBondUsingBoot (C#)
      this.bondInfo.phase = 'writing_auth';
      const auth1 = handler.generateAuth(aesEncoder, BOND_TYPE_BOOT_STAGE1, 0);
      console.log('[Crypto Debug] GenerateAuth payload (' + auth1.length + ' bytes):', Array.from(auth1).map(b => b.toString(16).padStart(2, '0')).join(' '));

      // Set up listener BEFORE writing (prevents race condition)
      const resp1Promise = this.awaitGnNotifyResponse(15000);

      console.log('[Crypto Debug] Writing auth to GNTrustedAppChallenge...');
      await this.writeTrustedChallengeAuth(gnSvc, auth1);

      // Await response (may indicate reboot needed)
      this.bondInfo.phase = 'awaiting_response';
      const resp1 = await resp1Promise;
      if (!resp1 || resp1.length < 2) {
        throw new Error('No stage 1 response');
      }
      console.log('[ResoundAdapter] Stage 1 response:', resp1.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));

      // 0x15 (21) = HIWaitsForReboot in BLE.dll → SetSharedAppKey path after reconnect
      // 0x13 (19) = AuthNotAccepted/Credentials rejected → assertNoFatalBondAuthStatus will throw
      const useSharedKeyAfterReboot = resp1[1] === AUTH_HI_WAITS_FOR_REBOOT; // 0x15 ONLY
      const useFullEcdhAfterReboot = false;
      const needRebootWait = useSharedKeyAfterReboot;

      if (!needRebootWait) {
        this.assertNoFatalBondAuthStatus('Boot stage 1', resp1, BOND_ACK_INTERIM_STATUSES);
      }

      let gnSvc2 = gnSvc;
      if (needRebootWait) {
        if (useSharedKeyAfterReboot) {
          bootStage1SharedKey = new Uint8Array(handler.getSharedAppKey());
          console.log('[ResoundAdapter] Stage 1: HI waits for reboot (0x15) — SetSharedAppKey path after reconnect');
        } else {
          bootStage1SharedKey = null;
          console.log(
            '[ResoundAdapter] Stage 1: firmware reboot hint (0x13) — full ECDH after reconnect (not SetSharedAppKey)',
          );
        }
        try {
          this.onRebootRequired?.(
            'Please reboot your hearing aid now (open/close the battery door or place in charger) to complete pairing.',
          );
          console.log('[ResoundAdapter] Waiting for user to reboot HI...');
          this.bondInfo.phase = 'awaiting_reboot';
          const manager = getBleManager();

          // Wait for disconnect — ignore BLE cancellation errors (expected when device reboots)
          await new Promise<void>((resolve) => {
            let resolved = false;
            const finish = () => { if (!resolved) { resolved = true; resolve(); } };

            const sub = manager.onDeviceDisconnected(this.deviceId!, () => {
              sub.remove();
              finish();
            });
            setTimeout(() => { try { sub.remove(); } catch {} finish(); }, 15000);
          }).catch(() => {}); // swallow any errors during disconnect

          // Small additional wait to let the device fully power cycle
          await new Promise<void>((r) => setTimeout(() => r(), 3000));

          // Wait for reconnect
          let reconnected = false;
          for (let i = 0; i < 30; i++) {
            await new Promise<void>((r) => setTimeout(() => r(), 2000));
            try {
              const connected = await manager.isDeviceConnected(this.deviceId!);
              if (connected) { reconnected = true; break; }
            } catch (e) {
              // Device not available yet, keep waiting
              console.log(`[ResoundAdapter] Still waiting for HI reconnect... (${i + 1}/30)`);
            }
          }
          if (!reconnected) throw new Error('HI did not reconnect after reboot');

          // Re-establish services — Android may auto-reconnect if bonded
          try {
            const isConn = await manager.isDeviceConnected(this.deviceId!);
            if (!isConn) {
              this.device = await manager.connectToDevice(this.deviceId!, { requestMTU: 512 });
            } else {
              // Already reconnected by Android — get device reference
              const devs = await manager.devices([this.deviceId!]);
              this.device = devs[0] ?? null;
              if (!this.device) {
                this.device = await manager.connectToDevice(this.deviceId!, { requestMTU: 512 });
              }
            }
          } catch {
            this.device = await manager.connectToDevice(this.deviceId!, { requestMTU: 512 });
          }
          await this.device!.discoverAllServicesAndCharacteristics();
          await this.buildCharacteristicMap();
          await this.ensureNegotiatedMtu();
          await this.setupGnNotify();
          gnSvc2 = this.resolveGnService();
          console.log('[ResoundAdapter] Reconnected after HI reboot');
          if (bootStage1SharedKey) {
            ({ handler, aesEncoder, keyIndex } = await this.prepareBootBondStage2AfterReboot(
              gnSvc2,
              bootStage1SharedKey,
            ));
            console.log('[ResoundAdapter] Boot stage 2: SetSharedAppKey path (BLE.dll)');
          } else {
            ({ handler, aesEncoder, keyIndex } = await this.prepareBootBondMaterial(gnSvc2));
            console.log('[ResoundAdapter] Boot stage 2: full ECDH material after 0x13 reboot path');
          }
          await this.ensureNegotiatedMtu();
        } catch (rebootErr) {
          // If we get here due to BLE cancellation during disconnect,
          // check if device eventually reconnected
          console.log('[ResoundAdapter] Reboot phase error (may be normal):', rebootErr);
          // Wait a bit then try to reconnect anyway
          await new Promise<void>((r) => setTimeout(() => r(), 5000));
          try {
            const manager = getBleManager();
            const isConn = await manager.isDeviceConnected(this.deviceId!).catch(() => false);
            if (!isConn) {
              this.device = await manager.connectToDevice(this.deviceId!, { requestMTU: 512 });
            } else {
              const devs = await manager.devices([this.deviceId!]);
              this.device = devs[0] ?? null;
              if (!this.device) {
                this.device = await manager.connectToDevice(this.deviceId!, { requestMTU: 512 });
              }
            }
            await this.device!.discoverAllServicesAndCharacteristics();
            await this.buildCharacteristicMap();
            await this.ensureNegotiatedMtu();
            await this.setupGnNotify();
            gnSvc2 = this.resolveGnService();
            console.log('[ResoundAdapter] Reconnected after HI reboot (fallback path)');
            if (bootStage1SharedKey) {
              ({ handler, aesEncoder, keyIndex } = await this.prepareBootBondStage2AfterReboot(
                gnSvc2,
                bootStage1SharedKey,
              ));
              console.log('[ResoundAdapter] Boot stage 2: SetSharedAppKey path (BLE.dll)');
            } else {
              ({ handler, aesEncoder, keyIndex } = await this.prepareBootBondMaterial(gnSvc2));
              console.log('[ResoundAdapter] Boot stage 2: full ECDH material after 0x13 reboot path');
            }
            await this.ensureNegotiatedMtu();
          } catch (reconnectErr) {
            throw new Error('HI did not reconnect after reboot: ' + reconnectErr);
          }
        }
      }

      // Stage 2: GenerateAuth type 2 — sharedAppIndex arg is 0 in C#; index comes from HI response
      const auth2 = handler.generateAuth(aesEncoder, BOND_TYPE_BOOT_STAGE2, 0);

      // Set up listener BEFORE writing (prevents race condition)
      const resp2Promise = this.awaitGnNotifyResponse(15000);

      await this.writeTrustedChallengeAuth(gnSvc2, auth2);

      let resp2 = await resp2Promise;
      if (!resp2 || resp2.length < 2) {
        throw new Error('No stage 2 response');
      }
      console.log('[ResoundAdapter] Stage 2 response:', resp2.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));

      this.assertNoFatalBondAuthStatus('Boot stage 2', resp2, BOND_ACK_INTERIM_STATUSES);

      // Ack-only 0x01 0x02 is normal; "HI says hi" may arrive in a follow-up 0x01/0x04 notify
      this.bondInfo.phase = 'verifying';
      const sharedAppIndexFromHi = await this.awaitBootBondVerification(aesEncoder, resp2, 45000);

      // Success
      this.encoder = aesEncoder;
      this.bondInfo.phase = 'trusted';
      this.bondInfo.trusted = true;

      // Persist bond data for future reconnect (SharedAppIndex from HI — HandleBasedPlatform line 904)
      const sharedAppKey = handler.getSharedAppKey();
      storeBondData({
        deviceId: this.deviceId,
        sharedAppSecret: uint8ToBase64(sharedAppKey),
        sharedAppIndex: sharedAppIndexFromHi,
        lastBondTimestamp: Date.now(),
      });

      console.log('[ResoundAdapter] Trusted bond established (boot)');
      return true;

    } catch (e) {
      console.warn('[ResoundAdapter] CreateTrustedBondBoot failed:', e);
      this.bondInfo.phase = 'failed';
      return false;
    }
  }

  /**
   * Create a trusted bond using a passcode.
   *
   * From HandleBasedPlatform.CreateTrustedBondUsingPasscode:
   *   SetPasscode(GetHIID(challenge), passcode) before GenerateKeys.
   *   GenerateAuth type 3.
   */
  async createTrustedBondPasscode(passcode: string): Promise<boolean> {
    if (!this.deviceId) throw new Error('Not connected');

    try {
      this.bondInfo = { ...createInitialBondInfo(), mode: 'passcode', phase: 'reading_challenge' };
      this.pendingNotifyQueue = [];
      this.notifyWaiters = [];
      const gnSvc = this.resolveGnService();

      // Read security capability
      let version = 0;
      let keyIndex = 0;
      const secCapKey = GN_SECURITY_CAP_CHAR.toLowerCase();
      if (this.charServiceMap.has(secCapKey)) {
        try {
          const capChar = await withRetry(() =>
            this.connected.readCharacteristicForService(gnSvc, GN_SECURITY_CAP_CHAR),
          );
          if (capChar.value) {
            const parsed = parseSecurityCap(new Uint8Array(base64ToBytes(capChar.value)));
            version = parsed.version;
            keyIndex = parsed.keyIndex;
          }
        } catch { /* continue */ }
      }
      this.bondInfo.version = version;
      this.bondInfo.keyIndex = keyIndex;

      // Read challenge
      const challengeChar = await withRetry(() =>
        this.connected.readCharacteristicForService(gnSvc, GN_TRUSTED_APP_CHALLENGE_CHAR),
      );
      if (!challengeChar.value) throw new Error('No challenge data');
      const challenge = new Uint8Array(base64ToBytes(challengeChar.value));

      // Read HI public key
      this.bondInfo.phase = 'reading_public_key';
      const hiPubKeyChar = await withRetry(() =>
        this.connected.readCharacteristicForService(gnSvc, GN_HI_PUBLIC_KEY_CHAR),
      );
      if (!hiPubKeyChar.value) throw new Error('No HI public key');
      const hiPublicKey = new Uint8Array(base64ToBytes(hiPubKeyChar.value));

      // Key derivation with passcode
      this.bondInfo.phase = 'generating_keys';
      const handler = new P6TrustKeyHandler();
      handler.updateChallenge(challenge, version, keyIndex);
      handler.setHIPublicKey(hiPublicKey);
      handler.setPasscode(P6TrustKeyHandler.getHIID(challenge), passcode);

      const aesEncoder = new AESDeEncoder();
      handler.generateKeys(aesEncoder);
      this.trustKeyHandler = handler;

      // Auth type 3
      this.bondInfo.phase = 'writing_auth';
      const auth = handler.generateAuth(aesEncoder, BOND_TYPE_PASSCODE, 0);

      // Set up listener BEFORE writing (prevents race condition)
      const respPromise = this.awaitGnNotifyResponse(15000);

      await withRetry(() =>
        this.connected.writeCharacteristicWithResponseForService(
          gnSvc, GN_TRUSTED_APP_CHALLENGE_CHAR, bytesToBase64(Array.from(auth)),
        ),
      );

      // Verify response
      this.bondInfo.phase = 'awaiting_response';
      const resp = await respPromise;
      if (!resp || resp.length < 2) throw new Error('No bond response');

      this.bondInfo.phase = 'verifying';
      this.assertNoFatalBondAuthStatus('Passcode bond', resp, BOND_ACK_INTERIM_STATUSES);
      if (resp[0] !== 0x01 || resp[1] !== AUTH_STATUS_OK || resp.length < 3) {
        throw new Error('Unexpected passcode bond notify shape');
      }
      const decrypted = aesEncoder.decrypt(new Uint8Array(resp.slice(2)));
      const responseText = utf8Decode(decrypted.slice(1));
      if (!responseText.includes(AUTH_HI_SAYS_HI)) {
        this.bondInfo.phase = 'failed';
        return false;
      }

      this.encoder = aesEncoder;
      this.bondInfo.phase = 'trusted';
      this.bondInfo.trusted = true;

      storeBondData({
        deviceId: this.deviceId,
        sharedAppSecret: uint8ToBase64(handler.getSharedAppKey()),
        sharedAppIndex: keyIndex,
        lastBondTimestamp: Date.now(),
      });

      console.log('[ResoundAdapter] Trusted bond established (passcode)');
      return true;

    } catch (e) {
      console.warn('[ResoundAdapter] CreateTrustedBondPasscode failed:', e);
      this.bondInfo.phase = 'failed';
      return false;
    }
  }

  /** Get current bond info (for UI/diagnostics) */
  getBondInfo(): GnBondInfo {
    return { ...this.bondInfo };
  }

  /**
   * Wait for a single GN notify response within a timeout.
   * Uses a queue so the listener is registered BEFORE the write that triggers
   * the response — prevents the race where the aid responds before we listen.
   * Returns the raw data or null if timed out.
   */
  private awaitGnNotifyResponse(timeoutMs: number): Promise<number[] | null> {
    return new Promise((resolve) => {
      // Check if a response is already queued (arrived before we started waiting)
      if (this.pendingNotifyQueue.length > 0) {
        resolve(this.pendingNotifyQueue.shift()!);
        return;
      }

      let settled = false;
      const finish = (data: number[] | null) => {
        if (settled) return;
        settled = true;
        // Remove from waiters if still there
        const idx = this.notifyWaiters.indexOf(resolver);
        if (idx >= 0) this.notifyWaiters.splice(idx, 1);
        resolve(data);
      };

      const resolver = (data: number[]) => finish(data);
      this.notifyWaiters.push(resolver);
      setTimeout(() => finish(null), timeoutMs);
    });
  }
}

// ── Text helpers ──

/** Decode UTF-8 bytes to string (manual — avoids TextDecoder dependency) */
function utf8Decode(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) {
      result += String.fromCharCode(b);
      i++;
    } else if ((b & 0xe0) === 0xc0) {
      result += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b & 0xf0) === 0xe0) {
      result += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
      );
      i += 3;
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      result += String.fromCodePoint(cp);
      i += 4;
    }
  }
  return result;
}

// ── Notify helpers ──

/**
 * Heuristic: does a payload look encrypted (high byte entropy)?
 * Returns true when the byte distribution looks random rather than structured.
 */
function looksEncrypted(data: number[]): boolean {
  if (data.length < 8) return false;
  // Count distinct byte values in the payload; structured GN payloads
  // typically use a small set of values, encrypted data is broadly distributed
  const distinct = new Set(data).size;
  return distinct > data.length * 0.6 && data.length >= 12;
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
