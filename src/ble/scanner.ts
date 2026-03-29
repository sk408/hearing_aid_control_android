/**
 * BLE device scanner with brand detection.
 * Scans ALL nearby BLE devices; brand is identified after connection + service discovery.
 */
import { Device } from 'react-native-ble-plx';
import { getBleManager, waitForPoweredOn } from './BleManager';
import { detectBrandFromDiscovery } from '../brand/detection';
import type { Brand, DiscoveredDevice } from './types';

/** Ignore devices with signal weaker than this. */
const MIN_RSSI = -90;

export type ScanCallback = (device: DiscoveredDevice) => void;

/**
 * Get already-bonded/connected hearing aids.
 * These won't appear in a BLE scan if they're already connected to Android.
 */
export async function getBondedDevices(): Promise<DiscoveredDevice[]> {
  const manager = getBleManager();
  const connected = await manager.connectedDevices([]);
  return connected.map((device) => ({
    id: device.id,
    name: device.name ?? device.localName,
    rssi: null,
    brand: detectBrandFromDiscovery(device.serviceUUIDs ?? [], []),
    serviceUUIDs: device.serviceUUIDs ?? [],
    bonded: true,
  }));
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

/**
 * "Soft" name-based heuristic for ReSound/GN devices.
 * ReSound Smart 3D devices often advertise as "HA" or similar short
 * factory-default names without proprietary service UUIDs in the ad packet.
 * These are factory BLE names, not user-customized names.
 */
const RESOUND_NAME_PATTERN = /^HA$|^HA\s|GN\s|Beltone|ENZO|^One\s|Quattro|Omnia|ReSound/i;

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
