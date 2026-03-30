/**
 * Zustand store for device state — supports dual (left + right) hearing aids.
 */
import { create } from 'zustand';
import type { Brand, DiscoveredDevice } from '../ble/types';
import type { HearingAidAdapter, DriverState } from '../adapters/types';

export type EarSide = 'left' | 'right';

export interface DeviceSlot {
  deviceId: string;
  deviceName: string | null;
  brand: Brand;
  adapter: HearingAidAdapter;
  driverState: DriverState | null;
}

interface DeviceStore {
  // Scanning
  isScanning: boolean;
  discoveredDevices: DiscoveredDevice[];

  // Connected devices (dual)
  leftDevice: DeviceSlot | null;
  rightDevice: DeviceSlot | null;
  linked: boolean;

  // BLE diagnostics
  serviceUUIDs: string[];
  lastBleOp: { name: string; result: string; time: number } | null;

  // Actions
  setScanning: (scanning: boolean) => void;
  addDiscoveredDevice: (device: DiscoveredDevice) => void;
  updateDiscoveredDeviceBrand: (deviceId: string, brand: Brand) => void;
  clearDiscoveredDevices: () => void;
  setDeviceSlot: (side: EarSide, slot: DeviceSlot | null) => void;
  updateDriverState: (side: EarSide, state: DriverState | null) => void;
  setLinked: (linked: boolean) => void;
  setServiceUUIDs: (uuids: string[]) => void;
  logBleOp: (name: string, result: string) => void;

  // Legacy single-device compat helpers
  /** Returns the first connected adapter (left preferred) */
  getActiveAdapter: () => HearingAidAdapter | null;
  /** Returns deviceId for a given side */
  getDeviceId: (side: EarSide) => string | null;
}

export const useDeviceStore = create<DeviceStore>((set, get) => ({
  isScanning: false,
  discoveredDevices: [],
  leftDevice: null,
  rightDevice: null,
  linked: true,
  serviceUUIDs: [],
  lastBleOp: null,

  setScanning: (scanning) => set({ isScanning: scanning }),

  addDiscoveredDevice: (device) =>
    set((state) => {
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

  setDeviceSlot: (side, slot) =>
    set(side === 'left' ? { leftDevice: slot } : { rightDevice: slot }),

  updateDriverState: (side, driverState) =>
    set((state) => {
      const key = side === 'left' ? 'leftDevice' : 'rightDevice';
      const device = state[key];
      if (!device) return state;
      return { [key]: { ...device, driverState } };
    }),

  setLinked: (linked) => set({ linked }),

  setServiceUUIDs: (serviceUUIDs) => set({ serviceUUIDs }),

  logBleOp: (name, result) =>
    set({ lastBleOp: { name, result, time: Date.now() } }),

  getActiveAdapter: () => {
    const { leftDevice, rightDevice } = get();
    return leftDevice?.adapter ?? rightDevice?.adapter ?? null;
  },

  getDeviceId: (side) => {
    const { leftDevice, rightDevice } = get();
    return (side === 'left' ? leftDevice : rightDevice)?.deviceId ?? null;
  },
}));
