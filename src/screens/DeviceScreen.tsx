/**
 * DeviceScreen — shows connected device info and controls.
 * TODO: Implement actual BLE connection and adapter wiring.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { RouteProp } from '@react-navigation/native';
import type { DiscoveredDevice } from '../ble/types';
import { ControlPanel } from './ControlPanel';

type DeviceScreenProps = {
  route: RouteProp<{ Device: { device: DiscoveredDevice } }, 'Device'>;
};

const BRAND_LABELS: Record<string, string> = {
  philips: 'Philips / Oticon (POLARIS)',
  rexton: 'Rexton (Terminal IO)',
  starkey: 'Starkey (Piccolo)',
  resound: 'ReSound (GN)',
  unknown: 'Unknown Brand',
};

export function DeviceScreen({ route }: DeviceScreenProps) {
  const { device } = route.params;

  return (
    <View style={styles.container}>
      <View style={styles.infoCard}>
        <Text style={styles.deviceName}>{device.name ?? 'Unknown Device'}</Text>
        <Text style={styles.brand}>{BRAND_LABELS[device.brand] ?? device.brand}</Text>
        <Text style={styles.id}>{device.id}</Text>
        {device.rssi != null && (
          <Text style={styles.rssi}>Signal: {device.rssi} dBm</Text>
        )}
      </View>

      <Text style={styles.statusText}>
        {/* TODO: Wire up actual BLE connection via adapter (SPEC.md §4) */}
        Connection not implemented yet — adapter stubs only
      </Text>

      <ControlPanel brand={device.brand} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
    padding: 16,
  },
  infoCard: {
    backgroundColor: '#FFF',
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  deviceName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 4,
  },
  brand: {
    fontSize: 14,
    color: '#0066CC',
    fontWeight: '600',
    marginBottom: 8,
  },
  id: {
    fontSize: 11,
    color: '#999',
    fontFamily: 'monospace',
  },
  rssi: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
  },
  statusText: {
    textAlign: 'center',
    color: '#CC6600',
    fontSize: 13,
    marginBottom: 16,
    fontStyle: 'italic',
  },
});
