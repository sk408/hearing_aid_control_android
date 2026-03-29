/**
 * BLE device scanner with brand detection.
 * Scans for hearing aids and classifies them by brand using advertised service UUIDs.
 */
import { Device } from 'react-native-ble-plx';
import { getBleManager, waitForPoweredOn } from './BleManager';
import { detectBrandFromDiscovery } from '../brand/detection';
import type { Brand, DiscoveredDevice } from './types';

export type ScanCallback = (device: DiscoveredDevice) => void;

/**
 * Start scanning for BLE hearing aid devices.
 * Calls `onDevice` for each discovered device with brand detection applied.
 * Returns a stop function.
 */
export function startScan(onDevice: ScanCallback): () => void {
  const manager = getBleManager();
  let stopped = false;

  // Known hearing aid service UUID prefixes to filter scan results
  const HEARING_AID_SERVICE_UUIDS = [
    '56772eaf-2153-4f74-acf3-4368d99fbf5a', // Philips / Rexton POLARIS
    '9a04f079-9840-4286-ab92-e65be0885f95', // Starkey Piccolo
    '0000fdf0-0000-1000-8000-00805f9b34fb', // ASHA
  ];

  void (async () => {
    await waitForPoweredOn();
    if (stopped) return;

    manager.startDeviceScan(
      null, // scan all UUIDs — we filter in the callback
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
  const serviceUUIDs = device.serviceUUIDs ?? [];
  const brand: Brand = detectBrandFromDiscovery(
    serviceUUIDs,
    [], // characteristics not available during scan, only after connection
    { deviceName: device.name ?? undefined },
  );

  // Return all discovered devices — even 'unknown' brand, so the user can see them
  return {
    id: device.id,
    name: device.name,
    rssi: device.rssi,
    brand,
    serviceUUIDs,
  };
}
