/**
 * DualControlScreen — shows connected device info for both ears
 * and the unified ControlPanel with linked/unlinked modes.
 */
import React, { useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { RootStackParamList } from '../../App';
import { useDeviceStore } from '../store/deviceStore';
import type { DeviceSlot } from '../store/deviceStore';
import { ControlPanel } from './ControlPanel';

const BRAND_LABELS: Record<string, string> = {
  philips: 'Philips / Oticon (POLARIS)',
  rexton: 'Rexton (Terminal IO)',
  starkey: 'Starkey (Piccolo)',
  resound: 'ReSound (GN)',
  unknown: 'Unknown Brand',
};

function DeviceInfoCard({ label, slot }: { label: string; slot: DeviceSlot | null }) {
  if (!slot) {
    return (
      <View style={[cardStyles.card, cardStyles.cardEmpty]}>
        <Text style={cardStyles.label}>{label}</Text>
        <Text style={cardStyles.empty}>Not connected</Text>
      </View>
    );
  }

  return (
    <View style={[cardStyles.card, cardStyles.cardConnected]}>
      <Text style={cardStyles.label}>{label}</Text>
      <Text style={cardStyles.name} numberOfLines={1}>
        {slot.deviceName ?? 'Unknown'}
      </Text>
      <Text style={cardStyles.brand}>
        {BRAND_LABELS[slot.brand] ?? slot.brand}
      </Text>
      <Text style={cardStyles.id}>{slot.deviceId}</Text>
    </View>
  );
}

export function DualControlScreen() {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const leftDevice = useDeviceStore((s) => s.leftDevice);
  const rightDevice = useDeviceStore((s) => s.rightDevice);
  const serviceUUIDs = useDeviceStore((s) => s.serviceUUIDs);
  const lastBleOp = useDeviceStore((s) => s.lastBleOp);

  const [diagExpanded, setDiagExpanded] = useState(false);

  return (
    <ScrollView style={styles.container}>
      {/* Device info cards */}
      <View style={styles.deviceRow}>
        <DeviceInfoCard label="Left Ear" slot={leftDevice} />
        <DeviceInfoCard label="Right Ear" slot={rightDevice} />
      </View>

      {/* Controls */}
      <ControlPanel />

      {/* Probe button for left device */}
      {leftDevice && (
        <TouchableOpacity
          style={styles.probeBtn}
          onPress={() => navigation.navigate('BleProbe', { deviceId: leftDevice.deviceId })}
          activeOpacity={0.7}>
          <Text style={styles.probeBtnText}>Probe Left Device</Text>
        </TouchableOpacity>
      )}

      {/* Probe button for right device */}
      {rightDevice && (
        <TouchableOpacity
          style={styles.probeBtn}
          onPress={() => navigation.navigate('BleProbe', { deviceId: rightDevice.deviceId })}
          activeOpacity={0.7}>
          <Text style={styles.probeBtnText}>Probe Right Device</Text>
        </TouchableOpacity>
      )}

      {/* Diagnostics */}
      <TouchableOpacity
        style={styles.diagHeader}
        onPress={() => setDiagExpanded((v) => !v)}
        activeOpacity={0.7}>
        <Text style={styles.diagHeaderText}>
          Diagnostics {diagExpanded ? '[-]' : '[+]'}
        </Text>
      </TouchableOpacity>

      {diagExpanded && (
        <View style={styles.diagCard}>
          <Text style={styles.diagLabel}>Service UUIDs (last discovery):</Text>
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

const cardStyles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1.5,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  cardConnected: {
    backgroundColor: '#FFF',
    borderColor: '#0066CC',
  },
  cardEmpty: {
    backgroundColor: '#FAFAFA',
    borderColor: '#E0E0E0',
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1A1A1A',
    marginBottom: 2,
  },
  brand: {
    fontSize: 11,
    color: '#0066CC',
    fontWeight: '600',
    marginBottom: 2,
  },
  id: {
    fontSize: 9,
    color: '#999',
    fontFamily: 'monospace',
  },
  empty: {
    fontSize: 13,
    color: '#AAAAAA',
    fontStyle: 'italic',
    marginTop: 4,
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
    padding: 16,
  },
  deviceRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
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
    marginTop: 8,
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
