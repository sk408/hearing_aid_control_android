/**
 * HearingAidAdapter interface — matches web app's BrandAdapter concept,
 * adapted for React Native BLE (react-native-ble-plx).
 * See SPEC.md §4 for the universal control interface.
 */
import type { Brand, DeviceInfo, Feature, Program } from '../ble/types';

export interface DriverState {
  readonly volume?: number;
  readonly muted?: boolean;
  readonly activeProgram?: number;
  readonly batteryPercent?: number;
  readonly deviceInfo?: DeviceInfo;
}

export interface HearingAidAdapter {
  readonly brand: Brand;

  // Connection
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;

  // Core controls (all brands — see SPEC.md §4)
  setVolume(level: number, ear?: 'left' | 'right' | 'both'): Promise<void>;
  getVolume(): Promise<number>;
  setMute(muted: boolean): Promise<void>;
  getMute(): Promise<boolean>;
  setProgram(index: number): Promise<void>;
  getProgram(): Promise<number>;
  getPrograms(): Promise<Program[]>;
  getBattery(): Promise<number>;

  // Extended controls (where supported)
  setBalance?(value: number): Promise<void>;
  setTinnitusVolume?(level: number): Promise<void>;
  setStreamingVolume?(level: number): Promise<void>;
  setEQ?(bass: number, mid: number, treble: number): Promise<void>;

  // State
  refreshState(): Promise<DriverState>;
  getSupportedFeatures(): Feature[];
}
