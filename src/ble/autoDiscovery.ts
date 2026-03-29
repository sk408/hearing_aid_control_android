/**
 * autoDiscovery.ts — Automated BLE GATT enumeration, characterization, and GN protocol probing.
 *
 * Phases:
 *   1. Full GATT enumeration (read all readable, subscribe to notifiable for 2s)
 *   2. Characteristic value interpretation (uint8/16/32, float32, string, hex)
 *   3. Safe write probing (zero-length write, idempotent write-back)
 *   4. GN Protocol discovery (discover frame + handle space scan 0x01–0x20)
 */
import type { Subscription } from 'react-native-ble-plx';
import { getBleManager } from './BleManager';

// ── Base64 helpers ──

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

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

// ── Report types ──

export interface CharacteristicReport {
  uuid: string;
  properties: string[];
  readValue: string | null;
  readInterpretations: string[];
  notifications: string[];
  writeResult: string | null;
}

export interface ServiceReport {
  uuid: string;
  characteristics: CharacteristicReport[];
}

export interface AutoDiscoveryReport {
  deviceId: string;
  timestamp: string;
  services: ServiceReport[];
  gnHandleMap: Record<string, string>;
}

export type ProgressCallback = (current: number, total: number, label: string) => void;

// ── Dangerous UUIDs: never attempt write probing on these ──

const DANGEROUS_CHAR_UUIDS = new Set([
  // Generic Access / Attribute / ASHA control
  '00002a00-0000-1000-8000-00805f9b34fb', // Device Name
  '00002a05-0000-1000-8000-00805f9b34fb', // Service Changed
  '00002b29-0000-1000-8000-00805f9b34fb', // Client Supported Features
  '00002b2a-0000-1000-8000-00805f9b34fb', // Database Hash
  '6333651e-c481-4a3e-9169-7c902aad37bb', // ASHA AudioControlPoint
  // GN Command char — handled separately in Phase 4
  '1959a468-3234-4c18-9e78-8daf8d9dbf61',
]);

const GN_COMMAND_CHAR = '1959a468-3234-4c18-9e78-8daf8d9dbf61';
const GN_NOTIFY_CHAR = '8b51a2ca-5bed-418b-b54b-22fe666aadd2';

// ── Phase 2: Value interpretation ──

function interpretBytes(bytes: number[]): string[] {
  const interps: string[] = [];

  if (bytes.length === 1) {
    interps.push(`uint8: ${bytes[0]}`);
    interps.push(`int8: ${bytes[0] > 127 ? bytes[0] - 256 : bytes[0]}`);
    interps.push(`bool: ${bytes[0] !== 0}`);
  }

  if (bytes.length === 2) {
    const le = bytes[0] | (bytes[1] << 8);
    const be = (bytes[0] << 8) | bytes[1];
    interps.push(`uint16 LE: ${le}`);
    interps.push(`uint16 BE: ${be}`);
  }

  if (bytes.length === 4) {
    const le =
      (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    interps.push(`uint32 LE: ${le}`);

    // float32 LE
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    for (let i = 0; i < 4; i++) view.setUint8(i, bytes[i]);
    const f = view.getFloat32(0, true);
    if (Number.isFinite(f)) {
      interps.push(`float32 LE: ${f}`);
    }
  }

  // UTF-8 string attempt: check if all bytes are printable ASCII or common UTF-8
  const isLikelyString =
    bytes.length > 0 &&
    bytes.every(
      (b) => (b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d || b === 0x09,
    );
  if (isLikelyString) {
    const str = bytes.map((b) => String.fromCharCode(b)).join('');
    interps.push(`string: "${str}"`);
  }

  return interps;
}

// ── Helpers ──

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collect notifications from a characteristic for `durationMs`, then unsubscribe. */
async function collectNotifications(
  deviceId: string,
  serviceUuid: string,
  charUuid: string,
  durationMs: number,
): Promise<string[]> {
  const manager = getBleManager();
  const results: string[] = [];

  return new Promise<string[]>((resolve) => {
    let sub: Subscription | null = null;

    const timer = setTimeout(() => {
      if (sub) sub.remove();
      resolve(results);
    }, durationMs);

    try {
      sub = manager.monitorCharacteristicForDevice(
        deviceId,
        serviceUuid,
        charUuid,
        (error, characteristic) => {
          if (error) {
            clearTimeout(timer);
            if (sub) sub.remove();
            resolve(results);
            return;
          }
          if (characteristic?.value) {
            const bytes = base64ToBytes(characteristic.value);
            results.push(toHex(bytes));
          }
        },
      );
    } catch {
      clearTimeout(timer);
      resolve(results);
    }
  });
}

/** Subscribe to GN Notify and collect one response within timeout. */
function collectGnResponse(
  deviceId: string,
  gnNotifyServiceUuid: string,
  timeoutMs: number,
): { promise: Promise<string | null>; cleanup: () => void } {
  const manager = getBleManager();
  let sub: Subscription | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const promise = new Promise<string | null>((resolve) => {
    timer = setTimeout(() => {
      settled = true;
      if (sub) sub.remove();
      resolve(null);
    }, timeoutMs);

    try {
      sub = manager.monitorCharacteristicForDevice(
        deviceId,
        gnNotifyServiceUuid,
        GN_NOTIFY_CHAR,
        (error, characteristic) => {
          if (settled) return;
          if (error) {
            settled = true;
            if (timer) clearTimeout(timer);
            if (sub) sub.remove();
            resolve(null);
            return;
          }
          if (characteristic?.value) {
            settled = true;
            if (timer) clearTimeout(timer);
            if (sub) sub.remove();
            const bytes = base64ToBytes(characteristic.value);
            resolve(toHex(bytes));
          }
        },
      );
    } catch {
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(null);
    }
  });

  const cleanup = () => {
    settled = true;
    if (timer) clearTimeout(timer);
    if (sub) sub.remove();
  };

  return { promise, cleanup };
}

// ── Main discovery function ──

export async function runAutoDiscovery(
  deviceId: string,
  onProgress: ProgressCallback,
): Promise<AutoDiscoveryReport> {
  const manager = getBleManager();
  const report: AutoDiscoveryReport = {
    deviceId,
    timestamp: new Date().toISOString(),
    services: [],
    gnHandleMap: {},
  };

  // Ensure connection and service discovery
  const isConnected = await manager.isDeviceConnected(deviceId);
  if (!isConnected) throw new Error('Device not connected');
  const device = await manager.discoverAllServicesAndCharacteristicsForDevice(deviceId);

  const svcList = await device.services();

  // Build flat list of all characteristics for progress tracking
  interface CharEntry {
    serviceUuid: string;
    charUuid: string;
    isReadable: boolean;
    isWritableWithResponse: boolean;
    isWritableWithoutResponse: boolean;
    isNotifiable: boolean;
    isIndicatable: boolean;
  }
  const allChars: CharEntry[] = [];
  const serviceCharMap = new Map<string, CharEntry[]>();

  for (const svc of svcList) {
    const chars = await device.characteristicsForService(svc.uuid);
    const entries: CharEntry[] = chars.map((c) => ({
      serviceUuid: svc.uuid,
      charUuid: c.uuid,
      isReadable: c.isReadable,
      isWritableWithResponse: c.isWritableWithResponse,
      isWritableWithoutResponse: c.isWritableWithoutResponse,
      isNotifiable: c.isNotifiable,
      isIndicatable: c.isIndicatable,
    }));
    allChars.push(...entries);
    serviceCharMap.set(svc.uuid, entries);
  }

  // Check if GN chars exist
  const gnCommandServiceUuid = allChars.find(
    (c) => c.charUuid.toLowerCase() === GN_COMMAND_CHAR,
  )?.serviceUuid;
  const gnNotifyServiceUuid = allChars.find(
    (c) => c.charUuid.toLowerCase() === GN_NOTIFY_CHAR,
  )?.serviceUuid;
  const hasGn = gnCommandServiceUuid != null && gnNotifyServiceUuid != null;

  // Total steps: allChars (phases 1-3) + GN handles (32 if GN present)
  const gnHandleCount = hasGn ? 33 : 0; // 1 discover + 32 handle reads
  const totalSteps = allChars.length + gnHandleCount;
  let currentStep = 0;

  // ── Phase 1 + 2 + 3: Enumerate, read, interpret, notify, write-probe ──

  for (const svc of svcList) {
    const entries = serviceCharMap.get(svc.uuid) ?? [];
    const svcReport: ServiceReport = { uuid: svc.uuid, characteristics: [] };

    for (const entry of entries) {
      currentStep++;
      const shortUuid = entry.charUuid.substring(0, 8);
      onProgress(currentStep, totalSteps, `Probing ${shortUuid}...`);

      const props: string[] = [];
      if (entry.isReadable) props.push('READ');
      if (entry.isWritableWithResponse) props.push('WRITE');
      if (entry.isWritableWithoutResponse) props.push('WRITE_NO_RESP');
      if (entry.isNotifiable) props.push('NOTIFY');
      if (entry.isIndicatable) props.push('INDICATE');

      const charReport: CharacteristicReport = {
        uuid: entry.charUuid,
        properties: props,
        readValue: null,
        readInterpretations: [],
        notifications: [],
        writeResult: null,
      };

      // Phase 1: Read
      let readBytes: number[] | null = null;
      if (entry.isReadable) {
        try {
          const c = await manager.readCharacteristicForDevice(
            deviceId,
            entry.serviceUuid,
            entry.charUuid,
          );
          if (c.value) {
            readBytes = base64ToBytes(c.value);
            charReport.readValue = toHex(readBytes);
            // Phase 2: Interpret
            charReport.readInterpretations = interpretBytes(readBytes);
          } else {
            charReport.readValue = '(empty)';
          }
        } catch (err) {
          charReport.readValue = `ERROR: ${err instanceof Error ? err.message : 'read failed'}`;
        }
      }

      // Phase 1: Subscribe for 2 seconds
      if (entry.isNotifiable) {
        try {
          charReport.notifications = await collectNotifications(
            deviceId,
            entry.serviceUuid,
            entry.charUuid,
            2000,
          );
        } catch {
          charReport.notifications = ['ERROR: subscribe failed'];
        }
      }

      // Phase 3: Safe write probing
      const isWritable = entry.isWritableWithResponse || entry.isWritableWithoutResponse;
      const isDangerous = DANGEROUS_CHAR_UUIDS.has(entry.charUuid.toLowerCase());
      if (isWritable && !isDangerous) {
        try {
          // Zero-length write
          if (entry.isWritableWithResponse) {
            await manager.writeCharacteristicWithResponseForDevice(
              deviceId,
              entry.serviceUuid,
              entry.charUuid,
              bytesToBase64([]),
            );
            charReport.writeResult = 'zero-length: OK';
          } else {
            await manager.writeCharacteristicWithoutResponseForDevice(
              deviceId,
              entry.serviceUuid,
              entry.charUuid,
              bytesToBase64([]),
            );
            charReport.writeResult = 'zero-length (no-resp): OK';
          }

          // Idempotent write-back if we successfully read a value
          if (readBytes != null && readBytes.length > 0) {
            if (entry.isWritableWithResponse) {
              await manager.writeCharacteristicWithResponseForDevice(
                deviceId,
                entry.serviceUuid,
                entry.charUuid,
                bytesToBase64(readBytes),
              );
              charReport.writeResult += '; write-back: OK';
            } else {
              await manager.writeCharacteristicWithoutResponseForDevice(
                deviceId,
                entry.serviceUuid,
                entry.charUuid,
                bytesToBase64(readBytes),
              );
              charReport.writeResult += '; write-back (no-resp): OK';
            }
          }
        } catch (err) {
          const existing = charReport.writeResult ?? '';
          charReport.writeResult =
            existing +
            (existing ? '; ' : '') +
            `ERROR: ${err instanceof Error ? err.message : 'write failed'}`;
        }
      }

      svcReport.characteristics.push(charReport);
    }

    report.services.push(svcReport);
  }

  // ── Phase 4: GN Protocol Discovery ──

  if (hasGn && gnCommandServiceUuid && gnNotifyServiceUuid) {
    // 4a: Send discover frame [0x06]
    currentStep++;
    onProgress(currentStep, totalSteps, 'GN: sending discover frame...');
    try {
      const listener = collectGnResponse(deviceId, gnNotifyServiceUuid, 3000);
      await manager.writeCharacteristicWithResponseForDevice(
        deviceId,
        gnCommandServiceUuid,
        GN_COMMAND_CHAR,
        bytesToBase64([0x06]),
      );
      const resp = await listener.promise;
      if (resp) {
        report.gnHandleMap['discover'] = resp;
      }
    } catch {
      report.gnHandleMap['discover'] = 'ERROR';
    }

    // 4b: Read handles 0x01 through 0x20
    for (let h = 0x01; h <= 0x20; h++) {
      currentStep++;
      const hexHandle = h.toString(16).padStart(2, '0');
      onProgress(currentStep, totalSteps, `GN: reading handle 0x${hexHandle}...`);
      try {
        const listener = collectGnResponse(deviceId, gnNotifyServiceUuid, 2000);
        await manager.writeCharacteristicWithResponseForDevice(
          deviceId,
          gnCommandServiceUuid,
          GN_COMMAND_CHAR,
          bytesToBase64([0x04, h]),
        );
        const resp = await listener.promise;
        if (resp) {
          report.gnHandleMap[`0x${hexHandle}`] = resp;
        }
      } catch {
        // skip errors silently
      }
      // Small delay between handle reads to avoid flooding
      await delay(100);
    }
  }

  onProgress(totalSteps, totalSteps, 'Discovery complete');
  return report;
}

// ── Markdown report generator ──

export function generateMarkdownReport(report: AutoDiscoveryReport): string {
  const lines: string[] = [];
  lines.push(`# BLE Auto-Discovery Report`);
  lines.push(`**Device:** ${report.deviceId}`);
  lines.push(`**Timestamp:** ${report.timestamp}`);
  lines.push('');

  let totalChars = 0;
  let readableCount = 0;
  let notifiableCount = 0;
  let writableCount = 0;

  for (const svc of report.services) {
    totalChars += svc.characteristics.length;
    for (const ch of svc.characteristics) {
      if (ch.readValue && !ch.readValue.startsWith('ERROR')) readableCount++;
      if (ch.notifications.length > 0) notifiableCount++;
      if (ch.writeResult) writableCount++;
    }
  }

  lines.push(`## Summary`);
  lines.push(`- Services: ${report.services.length}`);
  lines.push(`- Characteristics: ${totalChars}`);
  lines.push(`- Successfully read: ${readableCount}`);
  lines.push(`- With notifications: ${notifiableCount}`);
  lines.push(`- Write-probed: ${writableCount}`);
  lines.push(`- GN handles mapped: ${Object.keys(report.gnHandleMap).length}`);
  lines.push('');

  for (const svc of report.services) {
    lines.push(`## Service: ${svc.uuid}`);
    lines.push('');

    for (const ch of svc.characteristics) {
      lines.push(`### ${ch.uuid}`);
      lines.push(`Properties: ${ch.properties.join(', ')}`);

      if (ch.readValue) {
        lines.push(`Read: \`${ch.readValue}\``);
      }
      if (ch.readInterpretations.length > 0) {
        lines.push('Interpretations:');
        for (const interp of ch.readInterpretations) {
          lines.push(`  - ${interp}`);
        }
      }
      if (ch.notifications.length > 0) {
        lines.push(`Notifications (${ch.notifications.length}):`);
        for (const n of ch.notifications) {
          lines.push(`  - \`${n}\``);
        }
      }
      if (ch.writeResult) {
        lines.push(`Write probe: ${ch.writeResult}`);
      }
      lines.push('');
    }
  }

  if (Object.keys(report.gnHandleMap).length > 0) {
    lines.push('## GN Protocol Handle Map');
    lines.push('');
    lines.push('| Handle | Response |');
    lines.push('|--------|----------|');
    for (const [handle, resp] of Object.entries(report.gnHandleMap)) {
      lines.push(`| ${handle} | \`${resp}\` |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
