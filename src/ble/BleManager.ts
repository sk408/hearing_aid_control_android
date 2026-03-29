/**
 * Singleton wrapper around react-native-ble-plx BleManager.
 * Provides a single shared instance for the entire app.
 */
import { BleManager as PlxBleManager, State } from 'react-native-ble-plx';

let instance: PlxBleManager | null = null;

export function getBleManager(): PlxBleManager {
  if (!instance) {
    instance = new PlxBleManager();
  }
  return instance;
}

export function destroyBleManager(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}

/**
 * Wait for BLE to be powered on. Resolves when state === PoweredOn,
 * rejects after timeout.
 */
export function waitForPoweredOn(timeoutMs = 10000): Promise<void> {
  const manager = getBleManager();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.remove();
      reject(new Error('Bluetooth did not power on within timeout'));
    }, timeoutMs);

    const subscription = manager.onStateChange((state) => {
      if (state === State.PoweredOn) {
        clearTimeout(timer);
        subscription.remove();
        resolve();
      }
    }, true);
  });
}
