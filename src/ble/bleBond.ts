/**
 * JS bridge for BleBondModule — Android-only native bonding API.
 *
 * react-native-ble-plx has no bonding support.  On Android 6+, the OS no
 * longer auto-initiates bonding when a GATT op returns GATT_INSUF_AUTHENTICATION.
 * The app must call BluetoothDevice.createBond() explicitly.
 *
 * Bond state integers match Android's BluetoothDevice constants:
 *   10 = BOND_NONE
 *   11 = BOND_BONDING
 *   12 = BOND_BONDED
 */
import { NativeModules, Platform } from 'react-native';

const { BleBond } = NativeModules;

export type BondedBleRow = {
  address: string;
  name: string | null;
  deviceType: number;
};

/**
 * OS-paired BLE-capable devices (LE / dual / unknown). Classic-only omitted.
 * Empty on iOS or if native module missing.
 */
export async function getBondedBleDevicesFromOs(): Promise<BondedBleRow[]> {
  if (Platform.OS !== 'android' || !BleBond?.getBondedBleDevices) return [];
  const rows = await BleBond.getBondedBleDevices();
  if (!Array.isArray(rows)) return [];
  return rows.map((r: { address?: string; name?: string | null; deviceType?: number }) => ({
    address: String(r.address ?? ''),
    name: r.name ?? null,
    deviceType: typeof r.deviceType === 'number' ? r.deviceType : 0,
  }));
}

export const BOND_NONE = 10;
export const BOND_BONDING = 11;
export const BOND_BONDED = 12;

/** Returns the current Android bond state for the given MAC address. */
export async function getBondState(macAddress: string): Promise<number> {
  if (Platform.OS !== 'android' || !BleBond) return BOND_BONDED;
  return BleBond.getBondState(macAddress);
}

/**
 * Initiates Android BLE bonding.  Triggers the system pairing dialog (or
 * completes silently for Just-Works pairing).  Resolves when BOND_BONDED,
 * rejects if pairing is rejected or times out (60 s).
 */
export async function createBond(macAddress: string): Promise<void> {
  if (Platform.OS !== 'android' || !BleBond) return;
  await BleBond.createBond(macAddress);
}
