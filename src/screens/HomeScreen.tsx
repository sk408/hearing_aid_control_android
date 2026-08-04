/**
 * HomeScreen — scan for BLE hearing aid devices, show connected device slots,
 * and list scan results. Supports dual (left + right) hearing aid connections.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { PERMISSIONS, request, requestMultiple } from 'react-native-permissions';
import { useDeviceStore } from '../store/deviceStore';
import type { DeviceSlot } from '../store/deviceStore';
import { startScan, getBondedDevices } from '../ble/scanner';
import {
  advertisesLeaService,
  buildMfiSetEntries,
  getCachedVerdict,
  isVerificationCandidate,
  verifyMfiDevice,
  MAX_VERIFICATIONS_PER_SCAN,
} from '../ble/mfiSets';
import type { DiscoveredDevice } from '../ble/types';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { RootStackParamList } from '../../App';
import { getBleManager } from '../ble/BleManager';

type HomeScreenProps = {
  navigation: StackNavigationProp<RootStackParamList>;
};

const BRAND_LABELS: Record<string, string> = {
  philips: 'Philips / Oticon',
  rexton: 'Rexton',
  starkey: 'Starkey',
  resound: 'ReSound',
  mfi: 'MFi (Universal)',
  unknown: '?',
};

const BRAND_COLORS: Record<string, string> = {
  philips: '#0066CC',
  rexton: '#8B4513',
  starkey: '#228B22',
  resound: '#CC6600',
  mfi: '#6A5ACD',
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

/** Connected device slot card */
function DeviceSlotCard({
  label,
  slot,
  onDisconnect,
}: {
  label: string;
  slot: DeviceSlot | null;
  onDisconnect: () => void;
}) {
  return (
    <View style={[slotStyles.card, slot && slotStyles.cardConnected]}>
      <Text style={slotStyles.label}>{label}</Text>
      {slot ? (
        <>
          <Text style={slotStyles.name} numberOfLines={1}>
            {slot.deviceName ?? 'Unknown'}
          </Text>
          <View style={slotStyles.row}>
            <View
              style={[
                slotStyles.brandBadge,
                { backgroundColor: BRAND_COLORS[slot.brand] ?? '#888' },
              ]}>
              <Text style={slotStyles.brandText}>
                {BRAND_LABELS[slot.brand] ?? slot.brand}
              </Text>
            </View>
            {slot.driverState?.batteryPercent !== undefined && (
              <Text style={slotStyles.battery}>
                {slot.driverState.batteryPercent}%
              </Text>
            )}
          </View>
          <TouchableOpacity
            style={slotStyles.disconnectBtn}
            onPress={onDisconnect}
            activeOpacity={0.7}>
            <Text style={slotStyles.disconnectText}>Disconnect</Text>
          </TouchableOpacity>
        </>
      ) : (
        <Text style={slotStyles.empty}>Not connected</Text>
      )}
    </View>
  );
}

export function HomeScreen({ navigation }: HomeScreenProps) {
  const {
    isScanning,
    discoveredDevices,
    setScanning,
    addDiscoveredDevice,
    clearDiscoveredDevices,
    leftDevice,
    rightDevice,
    setDeviceSlot,
  } = useDeviceStore();
  const stopScanRef = useRef<(() => void) | null>(null);

  // Stage-2 filter state: scanned devices that don't advertise the LEA UUID
  // are collected here and verified (brief connect + service discovery) after
  // the scan stops. Only verified MFi devices ever enter the list (TASK14).
  const candidatesRef = useRef(new Map<string, DiscoveredDevice>());
  const verifyingRef = useRef(false);
  const [verifyingCount, setVerifyingCount] = useState(0);

  /**
   * Stage-2 verification: connect briefly to each candidate and check for the
   * LEA service. Verified devices are added to the list as 'mfi'; the rest
   * are hidden permanently (session-cached verdict in mfiSets).
   */
  const runVerification = useCallback(async () => {
    if (verifyingRef.current) return;
    verifyingRef.current = true;
    try {
      const { leftDevice: left, rightDevice: right } = useDeviceStore.getState();
      const connectedIds = new Set(
        [left?.deviceId, right?.deviceId].filter(Boolean) as string[],
      );
      const candidates = Array.from(candidatesRef.current.values())
        .filter((d) => !connectedIds.has(d.id) && isVerificationCandidate(d))
        .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
        .slice(0, MAX_VERIFICATIONS_PER_SCAN);

      setVerifyingCount(candidates.length);
      for (const candidate of candidates) {
        candidatesRef.current.delete(candidate.id);
        setVerifyingCount((n) => Math.max(0, n - 1));
        try {
          const result = await verifyMfiDevice(candidate.id);
          if (result.ok) {
            addDiscoveredDevice({
              ...candidate,
              brand: 'mfi',
              name:
                candidate.name ??
                (result.manufacturer
                  ? `MFi hearing aid (${result.manufacturer})`
                  : 'MFi hearing aid'),
            });
          }
        } catch {
          // verification failure — device stays hidden
        }
      }
    } finally {
      verifyingRef.current = false;
      setVerifyingCount(0);
    }
  }, [addDiscoveredDevice]);

  const stopScanAndVerify = useCallback(() => {
    if (stopScanRef.current) {
      stopScanRef.current();
      stopScanRef.current = null;
    }
    setScanning(false);
    void runVerification();
  }, [setScanning, runVerification]);

  const handleScan = useCallback(async () => {
    if (isScanning) {
      stopScanAndVerify();
      return;
    }

    const granted = await requestBlePermissions();
    if (!granted) return;

    clearDiscoveredDevices();
    candidatesRef.current.clear();
    setScanning(true);

    // Re-verify OS-paired BLE devices — only MFi ones are shown
    try {
      const bonded = await getBondedDevices();
      for (const d of bonded) {
        const verdict = getCachedVerdict(d.id);
        if (verdict === 'verified') {
          addDiscoveredDevice({ ...d, brand: 'mfi' });
        } else if (verdict !== 'rejected') {
          candidatesRef.current.set(d.id, d);
        }
      }
      void runVerification();
    } catch {
      // ignore
    }

    stopScanRef.current = startScan((device) => {
      // Stage 1: devices advertising the LEA service UUID show immediately.
      if (device.brand === 'mfi' || advertisesLeaService(device.serviceUUIDs)) {
        addDiscoveredDevice({ ...device, brand: 'mfi' });
        return;
      }
      // Everything else: stage-2 candidate, verified after scan stops.
      candidatesRef.current.set(device.id, device);
    });

    // Auto-stop after 15 seconds
    setTimeout(() => {
      if (stopScanRef.current) {
        stopScanAndVerify();
      }
    }, 15000);
  }, [isScanning, setScanning, addDiscoveredDevice, clearDiscoveredDevices, stopScanAndVerify, runVerification]);

  // Load already-bonded MFi devices on mount (verified via stage 2)
  useEffect(() => {
    void (async () => {
      try {
        const bonded = await getBondedDevices();
        for (const d of bonded) {
          const verdict = getCachedVerdict(d.id);
          if (verdict === 'verified') {
            addDiscoveredDevice({ ...d, brand: 'mfi' });
          } else if (verdict !== 'rejected') {
            candidatesRef.current.set(d.id, d);
          }
        }
        void runVerification();
      } catch {
        // Bonded device query may fail if BLE not ready
      }
    })();
  }, [addDiscoveredDevice, runVerification]);

  useEffect(() => {
    return () => {
      stopScanRef.current?.();
    };
  }, []);

  const handleDisconnect = useCallback(
    async (side: 'left' | 'right') => {
      const device = side === 'left' ? leftDevice : rightDevice;
      if (!device) return;
      const other = side === 'left' ? rightDevice : leftDevice;
      try {
        await device.adapter.disconnect();
      } catch {
        // ignore
      }
      try {
        await getBleManager().cancelDeviceConnection(device.deviceId);
      } catch {
        // ignore
      }
      setDeviceSlot(side, null);
      // An MFi binaural set shares ONE adapter across both slots — tearing
      // down the adapter disconnects both aids, so clear the peer slot too.
      if (other && other.adapter === device.adapter) {
        try {
          await getBleManager().cancelDeviceConnection(other.deviceId);
        } catch {
          // ignore
        }
        setDeviceSlot(side === 'left' ? 'right' : 'left', null);
      }
    },
    [leftDevice, rightDevice, setDeviceSlot],
  );

  const handleDevicePress = useCallback(
    (device: DiscoveredDevice) => {
      // Don't re-connect an already connected device (or set member)
      const connectedIds = [leftDevice?.deviceId, rightDevice?.deviceId].filter(Boolean);
      if (
        connectedIds.includes(device.id) ||
        device.setMemberIds?.some((id) => connectedIds.includes(id))
      ) {
        return;
      }
      stopScanRef.current?.();
      stopScanRef.current = null;
      setScanning(false);
      navigation.navigate('Device', { device });
    },
    [navigation, setScanning, leftDevice, rightDevice],
  );

  const hasAnyConnection = leftDevice != null || rightDevice != null;

  // Filter out already-connected devices (and set members) from the scan list
  const connectedIdSet = new Set(
    [leftDevice?.deviceId, rightDevice?.deviceId].filter(Boolean) as string[],
  );
  const filteredDevices = discoveredDevices.filter(
    (d) =>
      !connectedIdSet.has(d.id) &&
      !d.setMemberIds?.some((id) => connectedIdSet.has(id)),
  );

  // Group verified MFi devices into binaural set entries (one "L+R" row per
  // detected pair). Singles pass through unchanged.
  const groupedDevices = buildMfiSetEntries(filteredDevices);

  const renderDevice = ({ item }: { item: DiscoveredDevice }) => {
    const isSet = (item.setMemberIds?.length ?? 0) === 2;
    return (
      <TouchableOpacity
        style={styles.deviceCard}
        onPress={() => handleDevicePress(item)}
        activeOpacity={0.7}>
        <View style={styles.deviceHeader}>
          <Text style={styles.deviceName}>{item.name ?? 'MFi hearing aid'}</Text>
          <View style={styles.badgeRow}>
            {isSet && (
              <View style={styles.setBadge}>
                <Text style={styles.setBadgeText}>L+R</Text>
              </View>
            )}
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
        {isSet && (
          <Text style={styles.setHint}>
            Binaural set — both aids connect together
          </Text>
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
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hearing Aid Controller</Text>
      <Text style={styles.subtitle}>
        MFi hearing aids only — binaural pairs appear as one "L+R" entry
      </Text>

      {/* Connected device slots */}
      <View style={slotStyles.row2}>
        <DeviceSlotCard
          label="Left Ear"
          slot={leftDevice}
          onDisconnect={() => handleDisconnect('left')}
        />
        <DeviceSlotCard
          label="Right Ear"
          slot={rightDevice}
          onDisconnect={() => handleDisconnect('right')}
        />
      </View>

      {hasAnyConnection && (
        <TouchableOpacity
          style={styles.controlsButton}
          onPress={() => navigation.navigate('DualControl')}
          activeOpacity={0.8}>
          <Text style={styles.controlsButtonText}>Open Controls</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={[styles.scanButton, isScanning && styles.scanButtonActive]}
        onPress={handleScan}
        activeOpacity={0.8}>
        <Text style={styles.scanButtonText}>
          {isScanning ? 'Stop Scan' : 'Scan for Devices'}
        </Text>
      </TouchableOpacity>

      {verifyingCount > 0 && (
        <View style={styles.verifyRow}>
          <ActivityIndicator size="small" color="#6A5ACD" />
          <Text style={styles.verifyText}>
            Verifying MFi devices ({verifyingCount})...
          </Text>
        </View>
      )}

      {groupedDevices.length > 0 && (
        <>
          <Text style={styles.resultsLabel}>
            {groupedDevices.length} MFi device{groupedDevices.length !== 1 ? 's' : ''} found
          </Text>
          <Text style={styles.tapHint}>Tap a device or pair to connect</Text>
        </>
      )}

      <FlatList
        data={groupedDevices}
        keyExtractor={(item) => item.id}
        renderItem={renderDevice}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          !isScanning ? (
            <Text style={styles.emptyText}>
              {verifyingCount > 0
                ? 'Verifying nearby devices...'
                : 'Press "Scan for Devices" to find nearby MFi hearing aids'}
            </Text>
          ) : (
            <Text style={styles.emptyText}>Scanning...</Text>
          )
        }
      />
    </View>
  );
}

const slotStyles = StyleSheet.create({
  row2: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  card: {
    flex: 1,
    backgroundColor: '#FFF',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1.5,
    borderColor: '#E0E0E0',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  cardConnected: {
    borderColor: '#0066CC',
  },
  label: {
    fontSize: 12,
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
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  brandBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  brandText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: '600',
  },
  battery: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
  },
  empty: {
    fontSize: 13,
    color: '#AAAAAA',
    fontStyle: 'italic',
    marginTop: 4,
  },
  disconnectBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: '#FFEEEE',
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  disconnectText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#CC3333',
  },
});

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
    marginBottom: 16,
  },
  controlsButton: {
    backgroundColor: '#228B22',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12,
  },
  controlsButtonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
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
  setBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#6A5ACD',
  },
  setBadgeText: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '700',
  },
  setHint: {
    fontSize: 12,
    color: '#6A5ACD',
    fontStyle: 'italic',
    marginBottom: 2,
  },
  verifyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  verifyText: {
    fontSize: 13,
    color: '#6A5ACD',
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
