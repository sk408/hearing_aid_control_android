/**
 * BLE device scanner with brand detection.
 * Scans ALL nearby BLE devices; brand is identified after connection + service discovery.
 */
import { Platform } from 'react-native';
import { Device } from 'react-native-ble-plx';
import { getBondedBleDevicesFromOs } from './bleBond';
import { getBleManager, waitForPoweredOn } from './BleManager';
import { detectBrandFromDiscovery } from '../brand/detection';
import type { Brand, DiscoveredDevice } from './types';

/** Ignore devices with signal weaker than this. */
const MIN_RSSI = -90;

/**
 * ReSound/GN factory-style BLE names (scan + bonded display name hint).
 * Matches classifyDevice heuristic.
 */
const RESOUND_NAME_PATTERN = /^HA$|^HA\s|GN\s|Beltone|ENZO|^One\s|Quattro|Omnia|ReSound/i;

export type ScanCallback = (device: DiscoveredDevice) => void;

/**
 * Soft brand hint from Bluetooth display name only (bonded list has no GATT yet).
 * Real brand still comes from service discovery after connect.
 */
function inferBrandFromBluetoothName(name: string | null | undefined): Brand {
  if (!name) return 'unknown';
  if (RESOUND_NAME_PATTERN.test(name)) return 'resound';
  if (/Starkey|Piccolo|Thrive/i.test(name)) return 'starkey';
  if (/Phonak|Audio/i.test(name)) return 'unknown';
  if (/Oticon|Philips|HearLink|POLARIS/i.test(name)) return 'philips';
  if (/Rexton/i.test(name)) return 'rexton';
  if (/Signia|Widex|Unitron|Beltone/i.test(name)) return 'unknown';
  return 'unknown';
}

function normalizeDeviceId(address: string): string {
  return address.trim().toUpperCase();
}

/**
 * Devices paired in Android Settings that are BLE-capable, merged with any
 * currently GATT-connected peripherals (enriches names / advertised UUIDs).
 * Classic-only bonded devices are excluded — they are not usable via BLE GATT here.
 */
export async function getBondedDevices(): Promise<DiscoveredDevice[]> {
  const byId = new Map<string, DiscoveredDevice>();

  if (Platform.OS === 'android') {
    try {
      const rows = await getBondedBleDevicesFromOs();
      for (const row of rows) {
        if (!row.address) continue;
        const id = normalizeDeviceId(row.address);
        byId.set(id, {
          id,
          name: row.name?.trim() || id,
          rssi: null,
          brand: inferBrandFromBluetoothName(row.name),
          serviceUUIDs: [],
          bonded: true,
        });
      }
    } catch {
      // BLUETOOTH_CONNECT or BT off
    }
  }

  try {
    const manager = getBleManager();
    const connected = await manager.connectedDevices([]);
    for (const device of connected) {
      const id = normalizeDeviceId(device.id);
      const brandGatt = detectBrandFromDiscovery(device.serviceUUIDs ?? [], []);
      const existing = byId.get(id);
      const name = device.name ?? device.localName ?? existing?.name ?? id;
      const brand =
        brandGatt !== 'unknown' ? brandGatt : (existing?.brand ?? inferBrandFromBluetoothName(name));
      byId.set(id, {
        id,
        name,
        rssi: null,
        brand,
        serviceUUIDs: device.serviceUUIDs ?? existing?.serviceUUIDs ?? [],
        bonded: true,
      });
    }
  } catch {
    // BLE manager not ready
  }

  return Array.from(byId.values());
}

/**
 * Start scanning for ALL nearby BLE devices (no service UUID filter).
 * Brand detection is attempted from advertised UUIDs but most devices will
 * be 'unknown' until a full GATT discovery is performed after connection.
 * Returns a stop function.
 */
export function startScan(onDevice: ScanCallback): () => void {
  const manager = getBleManager();
  let stopped = false;

  void (async () => {
    await waitForPoweredOn();
    if (stopped) return;

    manager.startDeviceScan(
      null,
      { allowDuplicates: false },
      (error, device) => {
        if (error || !device || stopped) return;
        const discovered = classifyDevice(device);
        if (discovered) {
          onDevice(discovered);
        }
      },
    );
  })();

  return () => {
    stopped = true;
    manager.stopDeviceScan();
  };
}

function classifyDevice(device: Device): DiscoveredDevice | null {
  // Filter out devices with very weak signal
  if (device.rssi != null && device.rssi < MIN_RSSI) return null;

  const serviceUUIDs = device.serviceUUIDs ?? [];

  // 1. Try UUID-based detection (high confidence)
  let brand: Brand = detectBrandFromDiscovery(
    serviceUUIDs,
    [], // characteristics not available during scan, only after connection
  );

  // 2. If UUID detection didn't match, try soft name-based heuristic
  //    Prefer localName (from scan response) over name (from GAP)
  if (brand === 'unknown') {
    const advertisedName = device.localName ?? device.name;
    if (advertisedName && RESOUND_NAME_PATTERN.test(advertisedName)) {
      brand = 'resound';
    }
  }

  return {
    id: device.id,
    name: device.name ?? device.localName,
    rssi: device.rssi,
    brand,
    serviceUUIDs,
  };
}
