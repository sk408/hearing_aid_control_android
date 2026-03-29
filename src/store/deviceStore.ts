/**
 * Zustand store for device state — ported from web app pattern.
 */
import { create } from 'zustand';
import type { Brand, DiscoveredDevice } from '../ble/types';
import type { HearingAidAdapter, DriverState } from '../adapters/types';

interface DeviceStore {
  // Scanning
  isScanning: boolean;
  discoveredDevices: DiscoveredDevice[];

  // Connected device
  connectedDeviceId: string | null;
  adapter: HearingAidAdapter | null;
  driverState: DriverState | null;

  // BLE diagnostics
  serviceUUIDs: string[];
  lastBleOp: { name: string; result: string; time: number } | null;

  // Actions
  setScanning: (scanning: boolean) => void;
  addDiscoveredDevice: (device: DiscoveredDevice) => void;
  updateDiscoveredDeviceBrand: (deviceId: string, brand: Brand) => void;
  clearDiscoveredDevices: () => void;
  setConnectedDevice: (deviceId: string | null) => void;
  setAdapter: (adapter: HearingAidAdapter | null) => void;
  setDriverState: (state: DriverState | null) => void;
  setServiceUUIDs: (uuids: string[]) => void;
  logBleOp: (name: string, result: string) => void;
}

export const useDeviceStore = create<DeviceStore>((set) => ({
  isScanning: false,
  discoveredDevices: [],
  connectedDeviceId: null,
  adapter: null,
  driverState: null,
  serviceUUIDs: [],
  lastBleOp: null,

  setScanning: (scanning) => set({ isScanning: scanning }),

  addDiscoveredDevice: (device) =>
    set((state) => {
      // Deduplicate by device ID, update if already seen (fresher RSSI)
      const existing = state.discoveredDevices.findIndex((d) => d.id === device.id);
      if (existing >= 0) {
        const updated = [...state.discoveredDevices];
        updated[existing] = device;
        return { discoveredDevices: updated };
      }
      return { discoveredDevices: [...state.discoveredDevices, device] };
    }),

  updateDiscoveredDeviceBrand: (deviceId, brand) =>
    set((state) => {
      const idx = state.discoveredDevices.findIndex((d) => d.id === deviceId);
      if (idx < 0) return state;
      const updated = [...state.discoveredDevices];
      updated[idx] = { ...updated[idx], brand };
      return { discoveredDevices: updated };
    }),

  clearDiscoveredDevices: () => set({ discoveredDevices: [] }),

  setConnectedDevice: (deviceId) => set({ connectedDeviceId: deviceId }),

  setAdapter: (adapter) => set({ adapter }),

  setDriverState: (driverState) => set({ driverState }),

  setServiceUUIDs: (serviceUUIDs) => set({ serviceUUIDs }),

  logBleOp: (name, result) =>
    set({ lastBleOp: { name, result, time: Date.now() } }),
}));
