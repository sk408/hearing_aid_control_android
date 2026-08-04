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
  findSetSibling,
  initVerifiedMfiSet,
  isVerifiedMfi,
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
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lazy sibling window (TASK16): after a single device is tapped, scanning
  // continues in the background for up to 10s while we watch scan results
  // for the binaural sibling (grouping heuristics in mfiSets.findSetSibling).
  const SIBLING_WINDOW_MS = 10000;
  const siblingTargetRef = useRef<DiscoveredDevice | null>(null);
  const siblingCandidatesRef = useRef(new Map<string, DiscoveredDevice>());
  const siblingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lookingForSibling, setLookingForSibling] = useState(false);
  // Every scan callback result (listed or not) — seeds the sibling window so
  // a sibling that appeared before the tap can still be matched.
  const allScannedRef = useRef(new Map<string, DiscoveredDevice>());

  /**
   * Fast-list criteria (TASK16): a device appears immediately if it
   * advertises the LEA service UUID or was LEA-verified on a prior connect
   * (persisted set). Unknown candidates are never connected-to during scan.
   */
  const passesFastList = useCallback(
    (d: DiscoveredDevice) =>
      d.brand === 'mfi' || advertisesLeaService(d.serviceUUIDs) || isVerifiedMfi(d.id),
    [],
  );

  const stopScan = useCallback(() => {
    if (stopScanRef.current) {
      stopScanRef.current();
      stopScanRef.current = null;
    }
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    setScanning(false);
  }, [setScanning]);

  /** End the sibling window: stop scanning and navigate with the outcome. */
  const finishSiblingWindow = useCallback(
    (outcome: DiscoveredDevice) => {
      if (siblingTimerRef.current) {
        clearTimeout(siblingTimerRef.current);
        siblingTimerRef.current = null;
      }
      siblingTargetRef.current = null;
      siblingCandidatesRef.current.clear();
      setLookingForSibling(false);
      stopScan();
      navigation.navigate('Device', { device: outcome });
    },
    [navigation, stopScan],
  );

  /** Cancel the sibling window without navigating (user stopped the scan). */
  const cancelSiblingWindow = useCallback(() => {
    if (siblingTimerRef.current) {
      clearTimeout(siblingTimerRef.current);
      siblingTimerRef.current = null;
    }
    siblingTargetRef.current = null;
    siblingCandidatesRef.current.clear();
    setLookingForSibling(false);
  }, []);

  const handleScan = useCallback(async () => {
    if (isScanning) {
      cancelSiblingWindow();
      stopScan();
      return;
    }

    const granted = await requestBlePermissions();
    if (!granted) return;

    clearDiscoveredDevices();
    allScannedRef.current.clear();
    await initVerifiedMfiSet();
    setScanning(true);

    // OS-paired BLE devices previously confirmed as MFi show immediately
    try {
      const bonded = await getBondedDevices();
      for (const d of bonded) {
        if (isVerifiedMfi(d.id) || advertisesLeaService(d.serviceUUIDs)) {
          addDiscoveredDevice({ ...d, brand: 'mfi' });
        }
      }
    } catch {
      // ignore
    }

    stopScanRef.current = startScan((device) => {
      allScannedRef.current.set(device.id, device);
      // Fast list: LEA advertisers and previously verified MFi devices only.
      if (passesFastList(device)) {
        addDiscoveredDevice({ ...device, brand: 'mfi' });
      }
      // Lazy sibling window: watch ALL scan results for the tapped aid's
      // binaural sibling (unknown candidates are never listed, but the
      // sibling check is name/RSSI-based so it can still spot them).
      const target = siblingTargetRef.current;
      if (target && device.id !== target.id) {
        siblingCandidatesRef.current.set(device.id, device);
        const set = findSetSibling(
          target,
          Array.from(siblingCandidatesRef.current.values()),
        );
        if (set) {
          finishSiblingWindow({ ...set, brand: 'mfi' });
        }
      }
    });

    // Auto-stop after 15 seconds (not while a sibling window is active)
    autoStopTimerRef.current = setTimeout(() => {
      if (stopScanRef.current && !siblingTargetRef.current) {
        stopScan();
      }
    }, 15000);
  }, [isScanning, setScanning, addDiscoveredDevice, clearDiscoveredDevices, stopScan, cancelSiblingWindow, finishSiblingWindow, passesFastList]);

  // Load already-bonded MFi devices on mount (persisted verified set only)
  useEffect(() => {
    void (async () => {
      try {
        await initVerifiedMfiSet();
        const bonded = await getBondedDevices();
        for (const d of bonded) {
          if (isVerifiedMfi(d.id) || advertisesLeaService(d.serviceUUIDs)) {
            addDiscoveredDevice({ ...d, brand: 'mfi' });
          }
        }
      } catch {
        // Bonded device query may fail if BLE not ready
      }
    })();
  }, [addDiscoveredDevice]);

  useEffect(() => {
    return () => {
      stopScanRef.current?.();
      if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
      if (siblingTimerRef.current) clearTimeout(siblingTimerRef.current);
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
      // Ignore further taps while a sibling window is already running
      if (siblingTargetRef.current) return;

      // Binaural set entry: connect both aids immediately (existing flow)
      if ((device.setMemberIds?.length ?? 0) === 2) {
        stopScan();
        navigation.navigate('Device', { device });
        return;
      }

      // Single device: lazy sibling window (TASK16). Keep scanning in the
      // background for up to 10s while showing "looking for the other ear…".
      // If the sibling appears, finishSiblingWindow navigates with a merged
      // set entry (dual connect flow); otherwise the timer proceeds
      // single-sided.
      if (autoStopTimerRef.current) {
        clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
      }
      siblingTargetRef.current = device;
      siblingCandidatesRef.current.clear();
      for (const [id, d] of allScannedRef.current) {
        if (id !== device.id && !connectedIds.includes(id)) {
          siblingCandidatesRef.current.set(id, d);
        }
      }
      setLookingForSibling(true);

      // The sibling may already have been scanned before the tap
      const immediate = findSetSibling(
        device,
        Array.from(siblingCandidatesRef.current.values()),
      );
      if (immediate) {
        finishSiblingWindow({ ...immediate, brand: 'mfi' });
        return;
      }

      // If no scan is currently running (e.g. tapped a bonded-list entry
      // after auto-stop), start one so the window has something to watch.
      if (!stopScanRef.current) {
        setScanning(true);
        stopScanRef.current = startScan((scanned) => {
          allScannedRef.current.set(scanned.id, scanned);
          if (passesFastList(scanned)) {
            addDiscoveredDevice({ ...scanned, brand: 'mfi' });
          }
          const target = siblingTargetRef.current;
          if (target && scanned.id !== target.id) {
            siblingCandidatesRef.current.set(scanned.id, scanned);
            const set = findSetSibling(
              target,
              Array.from(siblingCandidatesRef.current.values()),
            );
            if (set) {
              finishSiblingWindow({ ...set, brand: 'mfi' });
            }
          }
        });
      }

      siblingTimerRef.current = setTimeout(() => {
        const target = siblingTargetRef.current;
        if (target) finishSiblingWindow(target);
      }, SIBLING_WINDOW_MS);
    },
    [navigation, stopScan, finishSiblingWindow, leftDevice, rightDevice, setScanning, addDiscoveredDevice, passesFastList],
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

      {lookingForSibling && (
        <View style={styles.verifyRow}>
          <ActivityIndicator size="small" color="#6A5ACD" />
          <Text style={styles.verifyText}>Looking for the other ear…</Text>
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
              Press "Scan for Devices" to find nearby MFi hearing aids
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
