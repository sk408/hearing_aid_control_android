/**
 * DeviceScreen — connects to device, discovers GATT services, detects brand,
 * creates + connects adapter, auto-detects ear side, and assigns to the
 * left/right store slot. Then navigates to the dual control screen.
 *
 * Includes a Diagnostics section for real-device BLE debugging.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { MfiAdapter } from '../adapters/mfiAdapter';
import { useDeviceStore } from '../store/deviceStore';
import type { EarSide } from '../store/deviceStore';
import type { HearingAidAdapter } from '../adapters/types';
import { LEA_SERVICE_UUID, markVerifiedMfi } from '../ble/mfiSets';

type DeviceScreenProps = {
  route: RouteProp<{ Device: { device: DiscoveredDevice } }, 'Device'>;
};

const BRAND_LABELS: Record<string, string> = {
  philips: 'Philips / Oticon (POLARIS)',
  rexton: 'Rexton (Terminal IO)',
  starkey: 'Starkey (Piccolo)',
  resound: 'ReSound (GN)',
  mfi: 'MFi (Universal)',
  unknown: 'Unknown Brand',
};

/** The MFi HAP / GN side characteristic — 0=left, 1=right */
const SIDE_CHAR_UUID = '8d17ac2f-1d54-4742-a49a-ef4b20784eb3';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64ToBytes(base64: string): number[] {
  const clean = base64.replace(/=+$/, '');
  const out: number[] = [];
  let bits = 0;
  let collected = 0;
  for (const ch of clean) {
    const val = B64.indexOf(ch);
    if (val < 0) continue;
    bits = (bits << 6) | val;
    collected += 6;
    if (collected >= 8) {
      collected -= 8;
      out.push((bits >> collected) & 0xff);
    }
  }
  return out;
}

type ConnectionState =
  | { status: 'connecting' }
  | { status: 'connecting_set' }
  | { status: 'discovering' }
  | { status: 'detecting_side' }
  | { status: 'pick_side' }
  | { status: 'assigned'; side: EarSide; brand: Brand }
  | { status: 'slot_full'; side: EarSide }
  | { status: 'slot_conflict' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

/**
 * Try to read the ear side from the device via BLE characteristic.
 * Returns 'left', 'right', or null if unreadable.
 */
async function readEarSide(
  deviceId: string,
  serviceUUIDs: string[],
  charServiceMap: Map<string, string>,
): Promise<'left' | 'right' | null> {
  const manager = getBleManager();

  // Try each service that might contain the side characteristic
  const possibleServices = [
    charServiceMap.get(SIDE_CHAR_UUID),
    ...serviceUUIDs,
  ].filter(Boolean) as string[];

  for (const svcUuid of possibleServices) {
    try {
      const char = await manager.readCharacteristicForDevice(
        deviceId,
        svcUuid,
        SIDE_CHAR_UUID,
      );
      if (char.value) {
        const bytes = base64ToBytes(char.value);
        if (bytes.length > 0) {
          return bytes[0] === 0 ? 'left' : 'right';
        }
      }
    } catch {
      // This service doesn't have the side char, try next
    }
  }
  return null;
}

/**
 * Check if two MAC addresses share the first 3 bytes (same manufacturer pair).
 */
function isMacPrefixMatch(mac1: string, mac2: string): boolean {
  const normalize = (m: string) => m.replace(/[:-]/g, '').toUpperCase().slice(0, 6);
  return normalize(mac1) === normalize(mac2);
}

/**
 * Piggyback LEA verification (TASK16): the ONLY place MFi verification
 * happens is inside a real connect flow. If the connected device exposes the
 * LEA service, its id is added to the persisted verified set so future scans
 * fast-list it immediately.
 */
async function piggybackVerifyLea(deviceId: string, svcUuids: string[]): Promise<void> {
  if (svcUuids.length > 0) {
    if (svcUuids.some((u) => u.toLowerCase() === LEA_SERVICE_UUID)) {
      markVerifiedMfi(deviceId);
    }
    return;
  }
  try {
    const services = await getBleManager().servicesForDevice(deviceId);
    if (services.some((s) => s.uuid.toLowerCase() === LEA_SERVICE_UUID)) {
      markVerifiedMfi(deviceId);
    }
  } catch {
    // verification is best-effort; connect flow continues regardless
  }
}

export function DeviceScreen({ route }: DeviceScreenProps) {
  const { device } = route.params;
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const updateDiscoveredDeviceBrand = useDeviceStore((s) => s.updateDiscoveredDeviceBrand);
  const setDeviceSlot = useDeviceStore((s) => s.setDeviceSlot);
  const setServiceUUIDs = useDeviceStore((s) => s.setServiceUUIDs);
  const logBleOp = useDeviceStore((s) => s.logBleOp);
  const serviceUUIDs = useDeviceStore((s) => s.serviceUUIDs);
  const lastBleOp = useDeviceStore((s) => s.lastBleOp);
  const leftDevice = useDeviceStore((s) => s.leftDevice);
  const rightDevice = useDeviceStore((s) => s.rightDevice);

  const [state, setState] = useState<ConnectionState>({ status: 'connecting' });

  // Keep references for cleanup
  const adapterRef = useRef<HearingAidAdapter | null>(null);
  const assignedRef = useRef(false);

  const assignToSlot = useCallback(
    (side: EarSide, adapter: HearingAidAdapter, brand: Brand, driverState: any) => {
      // Check if slot is already occupied by a different device
      const existing = side === 'left' ? leftDevice : rightDevice;
      if (existing && existing.deviceId !== device.id) {
        setState({ status: 'slot_full', side });
        return false;
      }

      setDeviceSlot(side, {
        deviceId: device.id,
        deviceName: device.name,
        brand,
        adapter,
        driverState,
      });
      assignedRef.current = true;
      setState({ status: 'assigned', side, brand });
      return true;
    },
    [device.id, device.name, leftDevice, rightDevice, setDeviceSlot],
  );

  /**
   * MFi binaural set connect flow (TASK14). The tapped list entry represents
   * BOTH aids: bond+connect both through one MfiAdapter, then assign the
   * shared adapter to both ear slots with per-ear battery state.
   * Brand-agnostic: sides come from the set entry (name-derived) with an
   * opportunistic read of the generic HAP side characteristic as refinement.
   */
  const connectMfiSet = useCallback(async () => {
    const manager = getBleManager();
    const memberIds = device.setMemberIds!;
    const primaryId = device.id; // set entry id is the primary member
    const secondaryId = memberIds.find((id) => id !== primaryId)!;

    // Both slots must be free (or already hold members of this set)
    const occupiedByOther = [leftDevice, rightDevice].some(
      (s) => s && s.deviceId !== primaryId && s.deviceId !== secondaryId,
    );
    if (occupiedByOther) {
      setState({ status: 'slot_conflict' });
      return;
    }

    try {
      setState({ status: 'connecting_set' });
      logBleOp('mfiSet.connect', 'connecting BOTH aids...');

      const adapter = new MfiAdapter();
      adapterRef.current = adapter;
      adapter.onRebootRequired = (message) => {
        Alert.alert('Reboot Required', message, [{ text: 'OK' }]);
      };
      adapter.onAndroidBondingRequired = () => {
        Alert.alert(
          'Bluetooth Pairing',
          'A Bluetooth pairing request may appear for EACH aid — please accept both to continue.',
          [{ text: 'OK' }],
        );
      };

      const nameSides = device.memberSides ?? {};
      await adapter.connectSet(primaryId, secondaryId, nameSides[primaryId] ?? 'right');

      // Piggyback verification (TASK16): both aids were connected anyway —
      // record LEA confirmation for each so future scans fast-list them.
      void piggybackVerifyLea(primaryId, []);
      if (adapter.isSet) void piggybackVerifyLea(secondaryId, []);

      // Refine sides via the HAP side characteristic when names gave no hint
      if (!nameSides[primaryId]) {
        try {
          const pServices = (await manager.servicesForDevice(primaryId)).map((s) => s.uuid);
          const pSide = await readEarSide(primaryId, pServices, new Map());
          if (pSide) {
            adapter.primarySide = pSide;
          } else if (adapter.isSet) {
            const sServices = (await manager.servicesForDevice(secondaryId)).map((s) => s.uuid);
            const sSide = await readEarSide(secondaryId, sServices, new Map());
            if (sSide) adapter.primarySide = sSide === 'left' ? 'right' : 'left';
          }
        } catch {
          // keep default (right)
        }
      }
      logBleOp(
        'mfiSet.connect',
        adapter.isSet ? 'OK — both aids connected' : 'OK — primary only (secondary unavailable)',
      );

      const primarySide = adapter.primarySide;
      const secondarySide: EarSide = primarySide === 'left' ? 'right' : 'left';
      const names = device.memberNames ?? {};

      logBleOp('refreshSetState', 'in progress...');
      const setStates = await adapter.refreshSetState().catch(() => null);

      if (setStates) {
        setDeviceSlot(primarySide, {
          deviceId: primaryId,
          deviceName: names[primaryId] ?? device.name,
          brand: 'mfi',
          adapter,
          driverState: setStates.primary,
        });
        setDeviceSlot(secondarySide, {
          deviceId: secondaryId,
          deviceName: names[secondaryId] ?? device.name,
          brand: 'mfi',
          adapter,
          driverState: setStates.secondary,
        });
        logBleOp('refreshSetState', 'OK');
      } else {
        // Secondary aid unavailable — single-sided graceful fallback
        const single = await adapter.refreshState().catch(() => null);
        setDeviceSlot(primarySide, {
          deviceId: primaryId,
          deviceName: names[primaryId] ?? device.name,
          brand: 'mfi',
          adapter,
          driverState: single,
        });
        logBleOp('refreshSetState', 'secondary unavailable — single-sided');
      }

      assignedRef.current = true;
      setState({ status: 'assigned', side: primarySide, brand: 'mfi' });
      setTimeout(() => {
        navigation.replace('DualControl');
      }, 800);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      logBleOp('mfiSet.connect', `FAILED: ${message}`);
      setState({ status: 'error', message });
    }
  }, [device, leftDevice, rightDevice, setDeviceSlot, logBleOp, navigation]);

  const connectAndIdentify = useCallback(async () => {
    // MFi binaural set entries take the dedicated dual-connect path
    if (device.brand === 'mfi' && (device.setMemberIds?.length ?? 0) === 2) {
      await connectMfiSet();
      return;
    }

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

      const services = await discovered.services();
      const svcUuids = services.map((s) => s.uuid);
      setServiceUUIDs(svcUuids);

      // Piggyback verification (TASK16): record LEA confirmation now that
      // we've connected anyway — future scans fast-list this device.
      void piggybackVerifyLea(device.id, svcUuids);

      // Build a map from char UUID → service UUID for side reading
      const charServiceMap = new Map<string, string>();
      const charUuids: string[] = [];
      for (const service of services) {
        const chars = await discovered.characteristicsForService(service.uuid);
        for (const c of chars) {
          charUuids.push(c.uuid);
          charServiceMap.set(c.uuid, service.uuid);
        }
      }

      logBleOp('discoverServices', `OK — ${svcUuids.length} services, ${charUuids.length} chars`);

      // Brand detection
      const brand = device.brand !== 'unknown'
        ? device.brand
        : detectBrandFromDiscovery(svcUuids, charUuids);

      if (brand === 'unknown') {
        setState({ status: 'unsupported' });
        return;
      }

      updateDiscoveredDeviceBrand(device.id, brand);

      // Create and connect adapter
      const adapter = createAdapter(brand);
      if (!adapter) {
        setState({ status: 'unsupported' });
        return;
      }
      adapterRef.current = adapter;

      adapter.onRebootRequired = (message) => {
        Alert.alert('Reboot Required', message, [{ text: 'OK' }]);
      };
      adapter.onAndroidBondingRequired = () => {
        Alert.alert(
          'Bluetooth Pairing',
          'A Bluetooth pairing request may appear — please accept it to continue.',
          [{ text: 'OK' }],
        );
      };

      logBleOp('adapter.connect', 'in progress...');
      await adapter.connect(device.id);
      logBleOp('adapter.connect', 'OK');

      // Initial state read
      let driverState = null;
      try {
        logBleOp('refreshState', 'in progress...');
        driverState = await adapter.refreshState();
        logBleOp('refreshState', 'OK');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        logBleOp('refreshState', `FAILED: ${msg}`);
      }

      // Auto-detect ear side
      setState({ status: 'detecting_side' });
      logBleOp('detectSide', 'reading side characteristic...');
      const detectedSide = await readEarSide(device.id, svcUuids, charServiceMap);

      if (detectedSide) {
        logBleOp('detectSide', `detected: ${detectedSide}`);
        const assigned = assignToSlot(detectedSide, adapter, brand, driverState);
        if (assigned) {
          // Auto-navigate to controls after a brief moment
          setTimeout(() => {
            navigation.replace('DualControl');
          }, 800);
        }
      } else {
        logBleOp('detectSide', 'could not detect — asking user');
        // Try to infer from available slots
        if (!leftDevice && rightDevice) {
          // Only right is connected, assign to left
          assignToSlot('left', adapter, brand, driverState);
          setTimeout(() => navigation.replace('DualControl'), 800);
        } else if (leftDevice && !rightDevice) {
          // Only left is connected, assign to right
          assignToSlot('right', adapter, brand, driverState);
          setTimeout(() => navigation.replace('DualControl'), 800);
        } else {
          // Neither connected or both free — ask user
          setState({ status: 'pick_side' });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      logBleOp('connect', `FAILED: ${message}`);
      setState({ status: 'error', message });
    }
  }, [
    device.id,
    device.brand,
    device.name,
    updateDiscoveredDeviceBrand,
    setDeviceSlot,
    setServiceUUIDs,
    logBleOp,
    leftDevice,
    rightDevice,
    assignToSlot,
    navigation,
  ]);

  useEffect(() => {
    void connectAndIdentify();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount — only disconnect if NOT assigned to a slot
  useEffect(() => {
    return () => {
      if (!assignedRef.current) {
        const adapter = adapterRef.current;
        if (adapter) {
          void adapter.disconnect().catch(() => {});
        } else {
          void getBleManager().cancelDeviceConnection(device.id).catch(() => {});
        }
      }
    };
  }, [device.id]);

  const handlePickSide = useCallback(
    (side: EarSide) => {
      const adapter = adapterRef.current;
      if (!adapter) return;
      const brand = device.brand !== 'unknown' ? device.brand : 'unknown';
      assignToSlot(side, adapter, brand, null);
      setTimeout(() => navigation.replace('DualControl'), 400);
    },
    [device.brand, assignToSlot, navigation],
  );

  const handleForceReplace = useCallback(
    async (side: EarSide) => {
      // Disconnect the existing device in that slot
      const existing = side === 'left' ? leftDevice : rightDevice;
      if (existing) {
        try { await existing.adapter.disconnect(); } catch { /* ignore */ }
        try { await getBleManager().cancelDeviceConnection(existing.deviceId); } catch { /* ignore */ }
        setDeviceSlot(side, null);
      }
      // Now assign the new device
      const adapter = adapterRef.current;
      if (!adapter) return;
      const brand = device.brand !== 'unknown' ? device.brand : 'unknown';
      assignToSlot(side, adapter, brand, null);
      setTimeout(() => navigation.replace('DualControl'), 400);
    },
    [device.brand, leftDevice, rightDevice, setDeviceSlot, assignToSlot, navigation],
  );

  const handleResolveConflict = useCallback(async () => {
    // Disconnect whatever currently occupies the slots, then retry the set
    for (const side of ['left', 'right'] as EarSide[]) {
      const existing = side === 'left' ? leftDevice : rightDevice;
      if (!existing) continue;
      if (side === 'right' && leftDevice && existing.adapter === leftDevice.adapter) {
        // shared adapter (MFi set) — already torn down with the left slot
        setDeviceSlot('right', null);
        continue;
      }
      try { await existing.adapter.disconnect(); } catch { /* ignore */ }
      try { await getBleManager().cancelDeviceConnection(existing.deviceId); } catch { /* ignore */ }
      setDeviceSlot(side, null);
    }
    await connectMfiSet();
  }, [leftDevice, rightDevice, setDeviceSlot, connectMfiSet]);

  const [diagExpanded, setDiagExpanded] = useState(false);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.infoCard}>
        <Text style={styles.deviceName}>{device.name ?? 'Unknown Device'}</Text>
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

      {state.status === 'connecting_set' && (
        <View style={styles.statusContainer}>
          <ActivityIndicator size="large" color="#6A5ACD" />
          <Text style={styles.statusText}>
            Connecting BOTH hearing aids...{'\n'}Accept pairing requests for each aid if prompted.
          </Text>
        </View>
      )}

      {state.status === 'discovering' && (
        <View style={styles.statusContainer}>
          <ActivityIndicator size="large" color="#0066CC" />
          <Text style={styles.statusText}>Identifying device...</Text>
        </View>
      )}

      {state.status === 'detecting_side' && (
        <View style={styles.statusContainer}>
          <ActivityIndicator size="large" color="#0066CC" />
          <Text style={styles.statusText}>Detecting ear side...</Text>
        </View>
      )}

      {state.status === 'pick_side' && (
        <View style={styles.pickSideCard}>
          <Text style={styles.pickSideTitle}>Which ear is this device?</Text>
          <Text style={styles.pickSideBody}>
            Could not auto-detect the side. Please select:
          </Text>
          <View style={styles.pickSideRow}>
            <TouchableOpacity
              style={[styles.sideButton, styles.sideButtonLeft]}
              onPress={() => handlePickSide('left')}
              activeOpacity={0.7}>
              <Text style={styles.sideButtonText}>Left Ear</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.sideButton, styles.sideButtonRight]}
              onPress={() => handlePickSide('right')}
              activeOpacity={0.7}>
              <Text style={styles.sideButtonText}>Right Ear</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {state.status === 'slot_full' && (
        <View style={styles.pickSideCard}>
          <Text style={styles.pickSideTitle}>
            {state.side === 'left' ? 'Left' : 'Right'} slot already connected
          </Text>
          <Text style={styles.pickSideBody}>
            Replace the existing device or assign to the other ear?
          </Text>
          <View style={styles.pickSideRow}>
            <TouchableOpacity
              style={[styles.sideButton, { backgroundColor: '#CC6600' }]}
              onPress={() => handleForceReplace(state.side)}
              activeOpacity={0.7}>
              <Text style={styles.sideButtonText}>
                Replace {state.side === 'left' ? 'Left' : 'Right'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.sideButton, { backgroundColor: '#0066CC' }]}
              onPress={() => handlePickSide(state.side === 'left' ? 'right' : 'left')}
              activeOpacity={0.7}>
              <Text style={styles.sideButtonText}>
                Use {state.side === 'left' ? 'Right' : 'Left'} Ear
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {state.status === 'slot_conflict' && (
        <View style={styles.pickSideCard}>
          <Text style={styles.pickSideTitle}>Other devices are connected</Text>
          <Text style={styles.pickSideBody}>
            Connecting this pair will disconnect the currently connected
            device(s).
          </Text>
          <View style={styles.pickSideRow}>
            <TouchableOpacity
              style={[styles.sideButton, { backgroundColor: '#CC6600' }]}
              onPress={handleResolveConflict}
              activeOpacity={0.7}>
              <Text style={styles.sideButtonText}>Replace & Connect Pair</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {state.status === 'assigned' && (
        <View style={styles.assignedCard}>
          <Text style={styles.assignedTitle}>
            Assigned to {state.side === 'left' ? 'Left' : 'Right'} Ear
          </Text>
          <Text style={styles.assignedBody}>
            {BRAND_LABELS[state.brand] ?? state.brand}
          </Text>
          <Text style={styles.assignedHint}>Opening controls...</Text>
        </View>
      )}

      {state.status === 'unsupported' && (
        <View style={styles.unsupportedCard}>
          <Text style={styles.unsupportedTitle}>Not a Supported Hearing Aid</Text>
          <Text style={styles.unsupportedBody}>
            This device was not recognized as a supported hearing aid.
            Supported brands: Philips, Rexton, Starkey, ReSound, and any
            standardized MFi hearing aid.
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
        activeOpacity={0.7}>
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
  pickSideCard: {
    backgroundColor: '#FFF',
    borderRadius: 10,
    padding: 20,
    marginBottom: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  pickSideTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 8,
    textAlign: 'center',
  },
  pickSideBody: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginBottom: 16,
  },
  pickSideRow: {
    flexDirection: 'row',
    gap: 12,
  },
  sideButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  sideButtonLeft: {
    backgroundColor: '#0066CC',
  },
  sideButtonRight: {
    backgroundColor: '#CC6600',
  },
  sideButtonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
  },
  assignedCard: {
    backgroundColor: '#F0FFF0',
    borderRadius: 10,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#228B22',
    alignItems: 'center',
  },
  assignedTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#228B22',
    marginBottom: 4,
  },
  assignedBody: {
    fontSize: 14,
    color: '#333',
  },
  assignedHint: {
    fontSize: 12,
    color: '#999',
    fontStyle: 'italic',
    marginTop: 8,
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
