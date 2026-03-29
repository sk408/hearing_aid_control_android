/**
 * DeviceScreen — connects to device, discovers GATT services, detects brand,
 * creates + connects adapter, then shows control panel or "not supported" message.
 * Includes a Diagnostics section for real-device BLE debugging.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { RouteProp } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { RootStackParamList } from '../../App';
import type { Brand, DiscoveredDevice } from '../ble/types';
import { getBleManager } from '../ble/BleManager';
import { detectBrandFromDiscovery } from '../brand/detection';
import { createAdapter } from '../adapters/factory';
import { useDeviceStore } from '../store/deviceStore';
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

type ConnectionState =
  | { status: 'connecting' }
  | { status: 'discovering' }
  | { status: 'identified'; brand: Brand }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

export function DeviceScreen({ route }: DeviceScreenProps) {
  const { device } = route.params;
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const updateDiscoveredDeviceBrand = useDeviceStore((s) => s.updateDiscoveredDeviceBrand);
  const setAdapter = useDeviceStore((s) => s.setAdapter);
  const setConnectedDevice = useDeviceStore((s) => s.setConnectedDevice);
  const setDriverState = useDeviceStore((s) => s.setDriverState);
  const setServiceUUIDs = useDeviceStore((s) => s.setServiceUUIDs);
  const logBleOp = useDeviceStore((s) => s.logBleOp);
  const serviceUUIDs = useDeviceStore((s) => s.serviceUUIDs);
  const lastBleOp = useDeviceStore((s) => s.lastBleOp);

  const [state, setState] = useState<ConnectionState>(
    device.brand !== 'unknown'
      ? { status: 'identified', brand: device.brand }
      : { status: 'connecting' },
  );

  const connectAndIdentify = useCallback(async () => {
    const manager = getBleManager();

    try {
      // Connect
      setState({ status: 'connecting' });
      logBleOp('connect', 'in progress...');
      const connected = await manager.connectToDevice(device.id);

      // Discover services & characteristics
      setState({ status: 'discovering' });
      logBleOp('discoverServices', 'in progress...');
      const discovered = await connected.discoverAllServicesAndCharacteristics();

      // Collect all service UUIDs
      const services = await discovered.services();
      const svcUuids = services.map((s) => s.uuid);
      setServiceUUIDs(svcUuids);

      // Collect all characteristic UUIDs across all services
      const charUuids: string[] = [];
      for (const service of services) {
        const chars = await discovered.characteristicsForService(service.uuid);
        for (const c of chars) {
          charUuids.push(c.uuid);
        }
      }

      logBleOp('discoverServices', `OK — ${svcUuids.length} services, ${charUuids.length} chars`);

      // Re-run brand detection with full GATT data
      const brand = detectBrandFromDiscovery(svcUuids, charUuids);

      if (brand === 'unknown') {
        setState({ status: 'unsupported' });
        return;
      }

      // Update the store so the device list reflects the real brand
      updateDiscoveredDeviceBrand(device.id, brand);

      // Create and connect the adapter
      const adapter = createAdapter(brand);
      if (!adapter) {
        setState({ status: 'unsupported' });
        return;
      }

      logBleOp('adapter.connect', 'in progress...');
      await adapter.connect(device.id);
      logBleOp('adapter.connect', 'OK');

      setAdapter(adapter);
      setConnectedDevice(device.id);

      // Initial state read
      try {
        logBleOp('refreshState', 'in progress...');
        const driverState = await adapter.refreshState();
        setDriverState(driverState);
        logBleOp('refreshState', 'OK');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        logBleOp('refreshState', `FAILED: ${msg}`);
      }

      setState({ status: 'identified', brand });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      logBleOp('connect', `FAILED: ${message}`);
      setState({ status: 'error', message });
    }
  }, [device.id, updateDiscoveredDeviceBrand, setAdapter, setConnectedDevice, setDriverState, setServiceUUIDs, logBleOp]);

  useEffect(() => {
    if (device.brand === 'unknown') {
      void connectAndIdentify();
    } else {
      // Brand already known — still need to create + connect adapter
      void (async () => {
        try {
          const adapter = createAdapter(device.brand);
          if (!adapter) return;
          logBleOp('adapter.connect', 'in progress...');
          await adapter.connect(device.id);
          logBleOp('adapter.connect', 'OK');
          setAdapter(adapter);
          setConnectedDevice(device.id);

          logBleOp('refreshState', 'in progress...');
          const driverState = await adapter.refreshState();
          setDriverState(driverState);
          logBleOp('refreshState', 'OK');
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown';
          logBleOp('adapter.connect', `FAILED: ${msg}`);
        }
      })();
    }
  }, [device.brand, device.id, connectAndIdentify, setAdapter, setConnectedDevice, setDriverState, logBleOp]);

  // Cleanup: disconnect adapter + BLE on unmount
  useEffect(() => {
    return () => {
      const adapter = useDeviceStore.getState().adapter;
      if (adapter) {
        void adapter.disconnect().catch(() => {});
        setAdapter(null);
      } else {
        void getBleManager().cancelDeviceConnection(device.id).catch(() => {});
      }
      setConnectedDevice(null);
      setDriverState(null);
    };
  }, [device.id, setAdapter, setConnectedDevice, setDriverState]);

  const [diagExpanded, setDiagExpanded] = useState(false);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.infoCard}>
        <Text style={styles.deviceName}>{device.name ?? 'Unknown Device'}</Text>
        <Text style={styles.brand}>
          {state.status === 'identified'
            ? BRAND_LABELS[state.brand] ?? state.brand
            : 'Identifying device...'}
        </Text>
        <Text style={styles.id}>{device.id}</Text>
        {device.rssi != null && (
          <Text style={styles.rssi}>Signal: {device.rssi} dBm</Text>
        )}
      </View>

      {state.status === 'connecting' && (
        <View style={styles.statusContainer}>
          <ActivityIndicator size="large" color="#0066CC" />
          <Text style={styles.statusText}>Connecting...</Text>
        </View>
      )}

      {state.status === 'discovering' && (
        <View style={styles.statusContainer}>
          <ActivityIndicator size="large" color="#0066CC" />
          <Text style={styles.statusText}>Identifying device...</Text>
        </View>
      )}

      {state.status === 'identified' && <ControlPanel brand={state.brand} />}

      {state.status === 'identified' && (
        <TouchableOpacity
          style={styles.probeBtn}
          onPress={() => navigation.navigate('BleProbe', { deviceId: device.id })}
          activeOpacity={0.7}
        >
          <Text style={styles.probeBtnText}>Probe</Text>
        </TouchableOpacity>
      )}

      {state.status === 'unsupported' && (
        <View style={styles.unsupportedCard}>
          <Text style={styles.unsupportedTitle}>Not a Supported Hearing Aid</Text>
          <Text style={styles.unsupportedBody}>
            This device was not recognized as a supported hearing aid.
            Supported brands: Philips, Rexton, Starkey, and ReSound.
          </Text>
        </View>
      )}

      {state.status === 'error' && (
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Connection Failed</Text>
          <Text style={styles.errorBody}>{state.message}</Text>
        </View>
      )}

      {/* Diagnostics */}
      <TouchableOpacity
        style={styles.diagHeader}
        onPress={() => setDiagExpanded((v) => !v)}
        activeOpacity={0.7}
      >
        <Text style={styles.diagHeaderText}>
          Diagnostics {diagExpanded ? '[-]' : '[+]'}
        </Text>
      </TouchableOpacity>

      {diagExpanded && (
        <View style={styles.diagCard}>
          <Text style={styles.diagLabel}>Connected Service UUIDs:</Text>
          {serviceUUIDs.length > 0 ? (
            serviceUUIDs.map((uuid) => (
              <Text key={uuid} style={styles.diagUuid}>{uuid}</Text>
            ))
          ) : (
            <Text style={styles.diagMuted}>None discovered yet</Text>
          )}

          <Text style={[styles.diagLabel, { marginTop: 12 }]}>Last BLE Operation:</Text>
          {lastBleOp ? (
            <View>
              <Text style={styles.diagValue}>
                {lastBleOp.name}: {lastBleOp.result}
              </Text>
              <Text style={styles.diagMuted}>
                {new Date(lastBleOp.time).toLocaleTimeString()}
              </Text>
            </View>
          ) : (
            <Text style={styles.diagMuted}>No operations yet</Text>
          )}
        </View>
      )}
    </ScrollView>
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
  statusContainer: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  statusText: {
    textAlign: 'center',
    color: '#0066CC',
    fontSize: 15,
    marginTop: 12,
    fontWeight: '500',
  },
  unsupportedCard: {
    backgroundColor: '#FFF',
    borderRadius: 10,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  unsupportedTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#CC3333',
    marginBottom: 8,
  },
  unsupportedBody: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    lineHeight: 20,
  },
  errorCard: {
    backgroundColor: '#FFF5F5',
    borderRadius: 10,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FFCCCC',
  },
  errorTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#CC3333',
    marginBottom: 8,
  },
  errorBody: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
  },
  probeBtn: {
    backgroundColor: '#6A1B9A',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 8,
  },
  probeBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFF',
  },
  diagHeader: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: '#E8E8E8',
    borderRadius: 8,
  },
  diagHeaderText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#555',
  },
  diagCard: {
    backgroundColor: '#FFF',
    borderRadius: 10,
    padding: 14,
    marginTop: 8,
    marginBottom: 16,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  diagLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
  },
  diagUuid: {
    fontSize: 11,
    color: '#0066CC',
    fontFamily: 'monospace',
    marginLeft: 8,
    lineHeight: 18,
  },
  diagMuted: {
    fontSize: 12,
    color: '#999',
    fontStyle: 'italic',
  },
  diagValue: {
    fontSize: 12,
    color: '#333',
    fontFamily: 'monospace',
  },
});
