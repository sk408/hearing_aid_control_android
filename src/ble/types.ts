/** BLE types adapted from web app for React Native (react-native-ble-plx) */

export type Brand = 'philips' | 'rexton' | 'starkey' | 'resound' | 'mfi' | 'unknown';

export interface DiscoveredDevice {
  id: string; // peripheral ID (MAC on Android)
  name: string | null;
  rssi: number | null;
  brand: Brand;
  serviceUUIDs: string[];
  bonded?: boolean;
  /**
   * Binaural set fields (MFi adapter only). When the entry represents a
   * left+right pair presented as one list item, `id` is the PRIMARY member's
   * id and `setMemberIds` lists both members. Absent for single devices.
   */
  setMemberIds?: string[];
  /** Ear side per member id (name-derived or side-characteristic read) */
  memberSides?: { [deviceId: string]: 'left' | 'right' };
  /** Display name per member id (before set merging) */
  memberNames?: { [deviceId: string]: string | null };
}

export interface DeviceInfo {
  id: string;
  name: string;
  brand: Brand;
  firmwareVersion?: string;
  side?: 'left' | 'right';
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
