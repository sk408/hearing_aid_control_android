/**
 * Zustand store for device state — ported from web app pattern.
 */
import { create } from 'zustand';
import type { DiscoveredDevice } from '../ble/types';
import type { DriverState } from '../adapters/types';

interface DeviceStore {
  // Scanning
  isScanning: boolean;
  discoveredDevices: DiscoveredDevice[];

  // Connected device
  connectedDeviceId: string | null;
  driverState: DriverState | null;

  // Actions
  setScanning: (scanning: boolean) => void;
  addDiscoveredDevice: (device: DiscoveredDevice) => void;
  clearDiscoveredDevices: () => void;
  setConnectedDevice: (deviceId: string | null) => void;
  setDriverState: (state: DriverState | null) => void;
}

export const useDeviceStore = create<DeviceStore>((set) => ({
  isScanning: false,
  discoveredDevices: [],
  connectedDeviceId: null,
  driverState: null,

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

  clearDiscoveredDevices: () => set({ discoveredDevices: [] }),

  setConnectedDevice: (deviceId) => set({ connectedDeviceId: deviceId }),

  setDriverState: (driverState) => set({ driverState }),
}));
