/** BLE types adapted from web app for React Native (react-native-ble-plx) */

export type Brand = 'philips' | 'rexton' | 'starkey' | 'resound' | 'unknown';

export interface DiscoveredDevice {
  id: string; // peripheral ID (MAC on Android)
  name: string | null;
  rssi: number | null;
  brand: Brand;
  serviceUUIDs: string[];
}

export interface DeviceInfo {
  id: string;
  name: string;
  brand: Brand;
  firmwareVersion?: string;
}

export interface Program {
  index: number;
  name: string;
}

export type Feature =
  | 'volume'
  | 'mute'
  | 'program'
  | 'balance'
  | 'tinnitus'
  | 'streaming'
  | 'eq'
  | 'battery'
  | 'noiseReduction'
  | 'windReduction';
