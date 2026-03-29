/**
 * HomeScreen — scan for BLE hearing aid devices and list results.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { PERMISSIONS, request, requestMultiple } from 'react-native-permissions';
import { useDeviceStore } from '../store/deviceStore';
import { startScan, getBondedDevices } from '../ble/scanner';
import type { DiscoveredDevice } from '../ble/types';
import type { StackNavigationProp } from '@react-navigation/stack';

type HomeScreenProps = {
  navigation: StackNavigationProp<any>;
};

const BRAND_LABELS: Record<string, string> = {
  philips: 'Philips / Oticon',
  rexton: 'Rexton',
  starkey: 'Starkey',
  resound: 'ReSound',
  unknown: '?',
};

const BRAND_COLORS: Record<string, string> = {
  philips: '#0066CC',
  rexton: '#8B4513',
  starkey: '#228B22',
  resound: '#CC6600',
  unknown: '#AAAAAA',
};

function signalStrengthLabel(rssi: number | null): string {
  if (rssi == null) return '';
  if (rssi >= -60) return 'Strong';
  if (rssi >= -75) return 'Good';
  return 'Weak';
}

function signalStrengthColor(rssi: number | null): string {
  if (rssi == null) return '#999';
  if (rssi >= -60) return '#228B22';
  if (rssi >= -75) return '#CC6600';
  return '#CC3333';
}

async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  if (Platform.Version >= 31) {
    const results = await requestMultiple([
      PERMISSIONS.ANDROID.BLUETOOTH_SCAN,
      PERMISSIONS.ANDROID.BLUETOOTH_CONNECT,
      PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION,
    ]);
    return Object.values(results).every((r) => r === 'granted');
  }

  const result = await request(PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION);
  return result === 'granted';
}

export function HomeScreen({ navigation }: HomeScreenProps) {
  const {
    isScanning,
    discoveredDevices,
    setScanning,
    addDiscoveredDevice,
    clearDiscoveredDevices,
  } = useDeviceStore();
  const stopScanRef = useRef<(() => void) | null>(null);

  const handleScan = useCallback(async () => {
    if (isScanning) {
      stopScanRef.current?.();
      stopScanRef.current = null;
      setScanning(false);
      return;
    }

    const granted = await requestBlePermissions();
    if (!granted) {
      // TODO: Show user-friendly permission denied message
      return;
    }

    clearDiscoveredDevices();
    setScanning(true);

    stopScanRef.current = startScan((device) => {
      addDiscoveredDevice(device);
    });

    // Auto-stop after 15 seconds
    setTimeout(() => {
      if (stopScanRef.current) {
        stopScanRef.current();
        stopScanRef.current = null;
        setScanning(false);
      }
    }, 15000);
  }, [isScanning, setScanning, addDiscoveredDevice, clearDiscoveredDevices]);

  // Load already-bonded devices on mount, before scanning
  useEffect(() => {
    void (async () => {
      try {
        const bonded = await getBondedDevices();
        for (const d of bonded) {
          addDiscoveredDevice(d);
        }
      } catch {
        // Bonded device query may fail if BLE not ready
      }
    })();
  }, [addDiscoveredDevice]);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      stopScanRef.current?.();
    };
  }, []);

  const handleDevicePress = useCallback(
    (device: DiscoveredDevice) => {
      stopScanRef.current?.();
      stopScanRef.current = null;
      setScanning(false);
      navigation.navigate('Device', { device });
    },
    [navigation, setScanning],
  );

  const renderDevice = ({ item }: { item: DiscoveredDevice }) => (
    <TouchableOpacity
      style={styles.deviceCard}
      onPress={() => handleDevicePress(item)}
      activeOpacity={0.7}>
      <View style={styles.deviceHeader}>
        <Text style={styles.deviceName}>{item.name ?? 'Unknown Device'}</Text>
        <View style={styles.badgeRow}>
          {item.bonded && (
            <View style={styles.pairedBadge}>
              <Text style={styles.pairedText}>Paired</Text>
            </View>
          )}
          <View
            style={[
              styles.brandBadge,
              { backgroundColor: BRAND_COLORS[item.brand] ?? '#888' },
            ]}>
            <Text style={styles.brandText}>{BRAND_LABELS[item.brand] ?? item.brand}</Text>
          </View>
        </View>
      </View>
      {item.brand === 'unknown' && (
        <Text style={styles.unknownHint}>Unknown hearing aid — tap to identify</Text>
      )}
      <Text style={styles.deviceId}>{item.id}</Text>
      {item.rssi != null && (
        <View style={styles.signalRow}>
          <Text style={[styles.rssi, { color: signalStrengthColor(item.rssi) }]}>
            {signalStrengthLabel(item.rssi)} ({item.rssi} dBm)
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hearing Aid Controller</Text>
      <Text style={styles.subtitle}>
        Scan for nearby Bluetooth devices
      </Text>

      <TouchableOpacity
        style={[styles.scanButton, isScanning && styles.scanButtonActive]}
        onPress={handleScan}
        activeOpacity={0.8}>
        <Text style={styles.scanButtonText}>
          {isScanning ? 'Stop Scan' : 'Scan for Devices'}
        </Text>
      </TouchableOpacity>

      {discoveredDevices.length > 0 && (
        <>
          <Text style={styles.resultsLabel}>
            {discoveredDevices.length} device{discoveredDevices.length !== 1 ? 's' : ''} found
          </Text>
          <Text style={styles.tapHint}>Tap any device to identify it</Text>
        </>
      )}

      <FlatList
        data={discoveredDevices}
        keyExtractor={(item) => item.id}
        renderItem={renderDevice}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          !isScanning ? (
            <Text style={styles.emptyText}>
              Press "Scan for Devices" to find nearby hearing aids
            </Text>
          ) : (
            <Text style={styles.emptyText}>Scanning...</Text>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 20,
  },
  scanButton: {
    backgroundColor: '#0066CC',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 16,
  },
  scanButtonActive: {
    backgroundColor: '#CC3333',
  },
  scanButtonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
  },
  resultsLabel: {
    fontSize: 13,
    color: '#666',
    marginBottom: 8,
  },
  list: {
    paddingBottom: 24,
  },
  deviceCard: {
    backgroundColor: '#FFF',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  deviceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1A1A1A',
    flexShrink: 1,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 8,
  },
  pairedBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#4CAF50',
  },
  pairedText: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '600',
  },
  brandBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  brandText: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '600',
  },
  unknownHint: {
    fontSize: 12,
    color: '#AAAAAA',
    fontStyle: 'italic',
    marginBottom: 2,
  },
  deviceId: {
    fontSize: 11,
    color: '#999',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo',
  },
  signalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  rssi: {
    fontSize: 12,
    marginTop: 0,
  },
  tapHint: {
    fontSize: 12,
    color: '#0066CC',
    marginBottom: 10,
    fontStyle: 'italic',
  },
  emptyText: {
    textAlign: 'center',
    color: '#999',
    marginTop: 40,
    fontSize: 14,
  },
});
