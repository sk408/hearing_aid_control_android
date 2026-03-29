/**
 * BleProbeScreen — live BLE testing tool for UUID discovery and GN protocol probing.
 *
 * Sections:
 *   1. Discovered Services & Characteristics (expand/collapse per service)
 *   2. UUID Probe Panel (candidate UUIDs with read/subscribe/write)
 *   3. GN Handle Protocol Tester (raw command sender)
 *   4. Export Log (copy all operations as JSON)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { RouteProp } from '@react-navigation/native';
import type { Subscription } from 'react-native-ble-plx';
import { getBleManager } from '../ble/BleManager';
import type { RootStackParamList } from '../../App';
import {
  runAutoDiscovery,
  generateMarkdownReport,
  type AutoDiscoveryReport,
} from '../ble/autoDiscovery';

// ── Base64 helpers (same as resoundAdapter) ──

const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

function base64ToBytes(base64: string): number[] {
  const clean = base64.replace(/=+$/, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i]);
    const c1 = B64.indexOf(clean[i + 1]);
    const c2 = B64.indexOf(clean[i + 2]);
    const c3 = B64.indexOf(clean[i + 3]);
    bytes.push((c0 << 2) | (c1 >> 4));
    if (i + 2 < clean.length) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
    if (i + 3 < clean.length) bytes.push(((c2 & 3) << 6) | c3);
  }
  return bytes;
}

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function toDec(bytes: number[]): string {
  return bytes.map((b) => b.toString()).join(' ');
}

/** Parse hex string like "03 05 01" or "0305 01" into byte array */
function parseHexInput(input: string): number[] | null {
  const cleaned = input.replace(/[^0-9a-fA-F]/g, '');
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) return null;
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes.push(parseInt(cleaned.substring(i, i + 2), 16));
  }
  return bytes;
}

// ── Candidate UUIDs ──

const GN_COMMAND_CHAR = '1959a468-3234-4c18-9e78-8daf8d9dbf61';
const GN_NOTIFY_CHAR = '8b51a2ca-5bed-418b-b54b-22fe666aadd2';

interface CandidateUUID {
  label: string;
  uuid: string;
}

const CANDIDATE_UUIDS: CandidateUUID[] = [
  { label: 'GN Command', uuid: '1959a468-3234-4c18-9e78-8daf8d9dbf61' },
  { label: 'GN Notify', uuid: '8b51a2ca-5bed-418b-b54b-22fe666aadd2' },
  { label: 'GN Active Program', uuid: 'dc82f820-63ac-f82f-1e89-372fde4151f4' },
  { label: 'GN Battery', uuid: '86e2c601-d90a-2628-19b9-bdb38d5c7cf0' },
  { label: 'GN Side', uuid: '8d17ac2f-1d54-4742-a49a-ef4b20784eb3' },
  { label: 'GN Mic Attenuation', uuid: '32c9322d-6b17-11cf-0234-6f0da5eafd75' },
  { label: 'GN Stream Attenuation', uuid: '054e99c7-ff34-1c12-59cd-e2c20d2e6743' },
  { label: 'GN Hi State', uuid: '8d552f91-15d0-4628-a03f-1a64fc88fa51' },
  { label: 'GN Feature Support', uuid: '650c3a00-cb6d-467d-a20b-3544f189d8af' },
  { label: 'ASHA Volume', uuid: '00e4ca9e-ab14-41e4-8823-f9e70c7e91df' },
  { label: 'ASHA Read Only Props', uuid: 'f0d28fea-5d20-4087-84a8-6b6f2fb08de0' },
];

// ── Types ──

type ProbeStatus = 'UNKNOWN' | 'READABLE' | 'WRITABLE' | 'NOTIFY' | 'NOT_FOUND';

interface CharInfo {
  uuid: string;
  properties: string[];
}

interface ServiceInfo {
  uuid: string;
  characteristics: CharInfo[];
}

interface LogEntry {
  uuid: string;
  operation: string;
  sent: string | null;
  received: string | null;
  timestamp: string;
}

type BleProbeScreenProps = {
  route: RouteProp<RootStackParamList, 'BleProbe'>;
};

// ── Component ──

type TabId = 'probe' | 'auto-report';

export function BleProbeScreen({ route }: BleProbeScreenProps) {
  const { deviceId } = route.params;

  // Tab state
  const [activeTab, setActiveTab] = useState<TabId>('probe');

  // Section 1: discovered services
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [expandedServices, setExpandedServices] = useState<Set<string>>(new Set());

  // Section 2: UUID probe statuses & data
  const [probeStatuses, setProbeStatuses] = useState<Map<string, ProbeStatus>>(
    () => new Map(CANDIDATE_UUIDS.map((c) => [c.uuid, 'UNKNOWN'])),
  );
  const [probeData, setProbeData] = useState<Map<string, string>>(new Map());
  const [writeInputs, setWriteInputs] = useState<Map<string, string>>(new Map());
  const [activeSubscriptions, setActiveSubscriptions] = useState<Set<string>>(new Set());

  // Section 3: GN handle tester
  const [handleId, setHandleId] = useState('');
  const [handlePayload, setHandlePayload] = useState('');
  const [gnNotifyLog, setGnNotifyLog] = useState<string[]>([]);
  const [gnNotifySubscribed, setGnNotifySubscribed] = useState(false);

  // Auto-discovery state
  const [autoReport, setAutoReport] = useState<AutoDiscoveryReport | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoCurrent, setAutoCurrent] = useState(0);
  const [autoTotal, setAutoTotal] = useState(0);
  const [autoLabel, setAutoLabel] = useState('');
  const [autoError, setAutoError] = useState<string | null>(null);
  const autoAbortRef = useRef(false);

  // Char→service map built during discovery
  const charServiceMapRef = useRef(new Map<string, string>());

  // Log for export
  const logRef = useRef<LogEntry[]>([]);

  // Subscription refs for cleanup
  const subscriptionsRef = useRef<Map<string, Subscription>>(new Map());

  const addLog = useCallback(
    (uuid: string, operation: string, sent: string | null, received: string | null) => {
      logRef.current.push({
        uuid,
        operation,
        sent,
        received,
        timestamp: new Date().toISOString(),
      });
    },
    [],
  );

  // ── Section 1: Discover all services & characteristics ──

  useEffect(() => {
    let cancelled = false;

    async function discover() {
      try {
        const manager = getBleManager();
        const isConnected = await manager.isDeviceConnected(deviceId);
        if (!isConnected) {
          Alert.alert('Connection Error', 'Device not connected');
          return;
        }
        const device = await manager.discoverAllServicesAndCharacteristicsForDevice(deviceId);
        if (cancelled) return;

        const svcList = await device.services();
        const result: ServiceInfo[] = [];

        for (const svc of svcList) {
          const chars = await device.characteristicsForService(svc.uuid);
          const charInfos: CharInfo[] = chars.map((c) => {
            // Build property list from characteristic flags
            const props: string[] = [];
            if (c.isReadable) props.push('READ');
            if (c.isWritableWithResponse) props.push('WRITE');
            if (c.isWritableWithoutResponse) props.push('WRITE_NO_RESP');
            if (c.isNotifiable) props.push('NOTIFY');
            if (c.isIndicatable) props.push('INDICATE');

            charServiceMapRef.current.set(c.uuid.toLowerCase(), svc.uuid);
            return { uuid: c.uuid, properties: props };
          });

          result.push({ uuid: svc.uuid, characteristics: charInfos });
        }

        if (!cancelled) {
          setServices(result);

          // Update probe statuses for UUIDs not found on the device
          const allCharUuids = new Set(
            result.flatMap((s) => s.characteristics.map((c) => c.uuid.toLowerCase())),
          );
          setProbeStatuses((prev) => {
            const next = new Map(prev);
            for (const candidate of CANDIDATE_UUIDS) {
              if (!allCharUuids.has(candidate.uuid.toLowerCase())) {
                next.set(candidate.uuid, 'NOT_FOUND');
              }
            }
            return next;
          });
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Discovery failed';
          Alert.alert('Discovery Error', msg);
        }
      }
    }

    void discover();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  // Cleanup subscriptions on unmount
  useEffect(() => {
    return () => {
      for (const sub of subscriptionsRef.current.values()) {
        sub.remove();
      }
    };
  }, []);

  const toggleService = (uuid: string) => {
    setExpandedServices((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  };

  // ── Section 2: Probe operations ──

  const findService = (charUuid: string): string | null => {
    return charServiceMapRef.current.get(charUuid.toLowerCase()) ?? null;
  };

  const probeRead = async (uuid: string) => {
    const serviceUuid = findService(uuid);
    if (!serviceUuid) {
      Alert.alert('Not Found', `Characteristic ${uuid} not discovered on device.`);
      return;
    }
    try {
      const manager = getBleManager();
      const isConnected = await manager.isDeviceConnected(deviceId);
      if (!isConnected) throw new Error('Device not connected');

      const char = await manager.readCharacteristicForDevice(deviceId, serviceUuid, uuid);
      if (!char.value) {
        setProbeData((prev) => new Map(prev).set(uuid, '(empty)'));
        addLog(uuid, 'read', null, '(empty)');
        return;
      }

      const bytes = base64ToBytes(char.value);
      const display = `hex: ${toHex(bytes)}\ndec: ${toDec(bytes)}\nraw: [${bytes.join(', ')}]`;
      setProbeData((prev) => new Map(prev).set(uuid, display));
      setProbeStatuses((prev) => new Map(prev).set(uuid, 'READABLE'));
      addLog(uuid, 'read', null, toHex(bytes));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Read failed';
      setProbeData((prev) => new Map(prev).set(uuid, `ERROR: ${msg}`));
      addLog(uuid, 'read', null, `ERROR: ${msg}`);
    }
  };

  const probeSubscribe = async (uuid: string) => {
    const serviceUuid = findService(uuid);
    if (!serviceUuid) {
      Alert.alert('Not Found', `Characteristic ${uuid} not discovered on device.`);
      return;
    }

    // Toggle off if already subscribed
    if (activeSubscriptions.has(uuid)) {
      const sub = subscriptionsRef.current.get(uuid);
      if (sub) {
        sub.remove();
        subscriptionsRef.current.delete(uuid);
      }
      setActiveSubscriptions((prev) => {
        const next = new Set(prev);
        next.delete(uuid);
        return next;
      });
      return;
    }

    try {
      const manager = getBleManager();
      const isConnected = await manager.isDeviceConnected(deviceId);
      if (!isConnected) {
        Alert.alert('Error', 'Device not connected');
        return;
      }

      const sub = manager.monitorCharacteristicForDevice(
        deviceId,
        serviceUuid,
        uuid,
        (error, characteristic) => {
          if (error) {
            const errMsg = `NOTIFY ERROR: ${error.message}`;
            setProbeData((prev) => new Map(prev).set(uuid, errMsg));
            addLog(uuid, 'notify', null, errMsg);
            return;
          }
          if (characteristic?.value) {
            const bytes = base64ToBytes(characteristic.value);
            const display = `[${new Date().toLocaleTimeString()}] hex: ${toHex(bytes)}\ndec: ${toDec(bytes)}`;
            setProbeData((prev) => {
              const existing = prev.get(uuid) ?? '';
              const lines = existing.split('\n').slice(-20); // Keep last 20 lines
              return new Map(prev).set(uuid, [...lines, display].join('\n'));
            });
            setProbeStatuses((prev) => new Map(prev).set(uuid, 'NOTIFY'));
            addLog(uuid, 'notify', null, toHex(bytes));
          }
        },
      );

      subscriptionsRef.current.set(uuid, sub);
      setActiveSubscriptions((prev) => new Set(prev).add(uuid));
      setProbeStatuses((prev) => new Map(prev).set(uuid, 'NOTIFY'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Subscribe failed';
      Alert.alert('Subscribe Error', msg);
    }
  };

  const probeWrite = async (uuid: string) => {
    const serviceUuid = findService(uuid);
    if (!serviceUuid) {
      Alert.alert('Not Found', `Characteristic ${uuid} not discovered on device.`);
      return;
    }

    const hexInput = writeInputs.get(uuid) ?? '';
    const bytes = parseHexInput(hexInput);
    if (!bytes || bytes.length === 0) {
      Alert.alert('Invalid Input', 'Enter hex bytes, e.g. "03 05 01"');
      return;
    }

    try {
      const manager = getBleManager();
      const isConnected = await manager.isDeviceConnected(deviceId);
      if (!isConnected) throw new Error('Device not connected');

      await manager.writeCharacteristicWithResponseForDevice(
        deviceId,
        serviceUuid,
        uuid,
        bytesToBase64(bytes),
      );

      const hexStr = toHex(bytes);
      setProbeData((prev) => new Map(prev).set(uuid, `WROTE: ${hexStr}`));
      setProbeStatuses((prev) => new Map(prev).set(uuid, 'WRITABLE'));
      addLog(uuid, 'write', hexStr, 'OK');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Write failed';
      setProbeData((prev) => new Map(prev).set(uuid, `WRITE ERROR: ${msg}`));
      addLog(uuid, 'write', toHex(bytes ?? []), `ERROR: ${msg}`);
    }
  };

  // ── Section 3: GN Handle Protocol ──

  const setupGnNotify = useCallback(async () => {
    if (gnNotifySubscribed) return;

    const serviceUuid = findService(GN_NOTIFY_CHAR);
    if (!serviceUuid) return;

    const manager = getBleManager();
    const isConnected = await manager.isDeviceConnected(deviceId);
    if (!isConnected) return;

    const sub = manager.monitorCharacteristicForDevice(
      deviceId,
      serviceUuid,
      GN_NOTIFY_CHAR,
      (error, characteristic) => {
        if (error) {
          setGnNotifyLog((prev) => [
            ...prev.slice(-50),
            `[${new Date().toLocaleTimeString()}] ERROR: ${error.message}`,
          ]);
          return;
        }
        if (characteristic?.value) {
          const bytes = base64ToBytes(characteristic.value);
          const entry = `[${new Date().toLocaleTimeString()}] << ${toHex(bytes)}`;
          setGnNotifyLog((prev) => [...prev.slice(-50), entry]);
          addLog(GN_NOTIFY_CHAR, 'gn_notify', null, toHex(bytes));
        }
      },
    );

    subscriptionsRef.current.set('gn_notify_handle', sub);
    setGnNotifySubscribed(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, gnNotifySubscribed, addLog]);

  const sendGnCommand = async () => {
    const serviceUuid = findService(GN_COMMAND_CHAR);
    if (!serviceUuid) {
      Alert.alert('Not Found', 'GN Command characteristic not discovered.');
      return;
    }

    const handleBytes = parseHexInput(handleId);
    if (!handleBytes || handleBytes.length !== 1) {
      Alert.alert('Invalid Handle', 'Enter a single hex byte, e.g. "05"');
      return;
    }

    const payloadBytes = handlePayload.trim() ? parseHexInput(handlePayload) : [];
    if (payloadBytes === null) {
      Alert.alert('Invalid Payload', 'Enter hex bytes, e.g. "01 02"');
      return;
    }

    const frame = [0x03, handleBytes[0], ...payloadBytes];

    // Auto-subscribe to GN notify
    void setupGnNotify();

    try {
      const manager = getBleManager();
      const isConnected = await manager.isDeviceConnected(deviceId);
      if (!isConnected) throw new Error('Device not connected');

      await manager.writeCharacteristicWithResponseForDevice(
        deviceId,
        serviceUuid,
        GN_COMMAND_CHAR,
        bytesToBase64(frame),
      );

      const hexStr = toHex(frame);
      setGnNotifyLog((prev) => [
        ...prev.slice(-50),
        `[${new Date().toLocaleTimeString()}] >> ${hexStr}`,
      ]);
      addLog(GN_COMMAND_CHAR, 'gn_write', hexStr, 'OK');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Write failed';
      setGnNotifyLog((prev) => [
        ...prev.slice(-50),
        `[${new Date().toLocaleTimeString()}] WRITE ERROR: ${msg}`,
      ]);
      addLog(GN_COMMAND_CHAR, 'gn_write', toHex(frame), `ERROR: ${msg}`);
    }
  };

  // ── Section 4: Export ──

  const exportLog = () => {
    const json = JSON.stringify(logRef.current, null, 2);
    void Share.share({ message: json, title: 'BLE Probe Log' });
  };

  // ── Auto-Discovery ──

  const startAutoDiscovery = useCallback(async () => {
    if (autoRunning) return;
    setAutoRunning(true);
    setAutoError(null);
    setAutoReport(null);
    setAutoCurrent(0);
    setAutoTotal(0);
    setAutoLabel('Starting...');
    autoAbortRef.current = false;

    try {
      const report = await runAutoDiscovery(
        deviceId,
        (current, total, label) => {
          setAutoCurrent(current);
          setAutoTotal(total);
          setAutoLabel(label);
        },
      );
      if (!autoAbortRef.current) {
        setAutoReport(report);
      }
    } catch (err) {
      if (!autoAbortRef.current) {
        setAutoError(err instanceof Error ? err.message : 'Discovery failed');
      }
    } finally {
      setAutoRunning(false);
    }
  }, [deviceId, autoRunning]);

  const shareAutoReport = useCallback(() => {
    if (!autoReport) return;
    const json = JSON.stringify(autoReport, null, 2);
    const markdown = generateMarkdownReport(autoReport);
    const combined = `${markdown}\n\n---\n\n## Raw JSON\n\`\`\`json\n${json}\n\`\`\``;
    void Share.share({ message: combined, title: 'BLE Auto-Discovery Report' });
  }, [autoReport]);

  // Auto-start discovery when services are loaded (background, low priority)
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (services.length > 0 && !autoStartedRef.current) {
      autoStartedRef.current = true;
      // Delay to let UI settle first
      const timer = setTimeout(() => {
        void startAutoDiscovery();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [services, startAutoDiscovery]);

  // ── Render helpers ──

  const statusColor = (status: ProbeStatus): string => {
    switch (status) {
      case 'READABLE':
        return '#2E7D32';
      case 'WRITABLE':
        return '#1565C0';
      case 'NOTIFY':
        return '#6A1B9A';
      case 'NOT_FOUND':
        return '#B71C1C';
      default:
        return '#757575';
    }
  };

  return (
    <View style={styles.container}>
      {/* ── Tab Bar ── */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'probe' && styles.tabActive]}
          onPress={() => setActiveTab('probe')}
          activeOpacity={0.7}
        >
          <Text style={[styles.tabText, activeTab === 'probe' && styles.tabTextActive]}>
            Probe
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'auto-report' && styles.tabActive]}
          onPress={() => setActiveTab('auto-report')}
          activeOpacity={0.7}
        >
          <Text style={[styles.tabText, activeTab === 'auto-report' && styles.tabTextActive]}>
            Auto-Report
            {autoRunning ? ' ...' : autoReport ? ' ✓' : ''}
          </Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'probe' ? (
      <ScrollView style={styles.scrollContent}>
      {/* ── Section 1: Discovered Services ── */}
      <Text style={styles.sectionTitle}>Discovered Services & Characteristics</Text>
      {services.length === 0 ? (
        <Text style={styles.muted}>Discovering...</Text>
      ) : (
        services.map((svc) => (
          <View key={svc.uuid} style={styles.card}>
            <TouchableOpacity
              onPress={() => toggleService(svc.uuid)}
              activeOpacity={0.7}
            >
              <Text style={styles.serviceUuid}>
                {expandedServices.has(svc.uuid) ? '[-]' : '[+]'} {svc.uuid}
              </Text>
              <Text style={styles.charCount}>
                {svc.characteristics.length} characteristic
                {svc.characteristics.length !== 1 ? 's' : ''}
              </Text>
            </TouchableOpacity>
            {expandedServices.has(svc.uuid) &&
              svc.characteristics.map((ch) => (
                <View key={ch.uuid} style={styles.charRow}>
                  <Text style={styles.charUuid}>{ch.uuid}</Text>
                  <Text style={styles.charProps}>{ch.properties.join(' | ')}</Text>
                </View>
              ))}
          </View>
        ))
      )}

      {/* ── Section 2: UUID Probe Panel ── */}
      <Text style={styles.sectionTitle}>UUID Probe Panel</Text>
      {CANDIDATE_UUIDS.map((candidate) => {
        const status = probeStatuses.get(candidate.uuid) ?? 'UNKNOWN';
        const data = probeData.get(candidate.uuid);
        const writeVal = writeInputs.get(candidate.uuid) ?? '';
        const isSubscribed = activeSubscriptions.has(candidate.uuid);
        const isNotFound = status === 'NOT_FOUND';

        return (
          <View
            key={candidate.uuid}
            style={[styles.card, isNotFound && styles.cardDimmed]}
          >
            <View style={styles.probeHeader}>
              <Text style={styles.probeLabel}>{candidate.label}</Text>
              <View
                style={[
                  styles.badge,
                  { backgroundColor: statusColor(status) },
                ]}
              >
                <Text style={styles.badgeText}>{status}</Text>
              </View>
            </View>
            <Text style={styles.probeUuid}>{candidate.uuid}</Text>

            {!isNotFound && (
              <>
                <View style={styles.buttonRow}>
                  <TouchableOpacity
                    style={styles.probeBtn}
                    onPress={() => void probeRead(candidate.uuid)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.probeBtnText}>Read</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.probeBtn,
                      isSubscribed && styles.probeBtnActive,
                    ]}
                    onPress={() => void probeSubscribe(candidate.uuid)}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.probeBtnText,
                        isSubscribed && styles.probeBtnTextActive,
                      ]}
                    >
                      {isSubscribed ? 'Unsubscribe' : 'Subscribe'}
                    </Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.writeRow}>
                  <TextInput
                    style={styles.hexInput}
                    placeholder="hex: 03 05 01"
                    placeholderTextColor="#AAA"
                    value={writeVal}
                    onChangeText={(text) =>
                      setWriteInputs((prev) => new Map(prev).set(candidate.uuid, text))
                    }
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity
                    style={styles.writeBtn}
                    onPress={() => void probeWrite(candidate.uuid)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.writeBtnText}>Write</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {data && <Text style={styles.probeData}>{data}</Text>}
          </View>
        );
      })}

      {/* ── Section 3: GN Handle Protocol Tester ── */}
      <Text style={styles.sectionTitle}>GN Handle Protocol Tester</Text>
      <View style={styles.card}>
        <Text style={styles.gnDesc}>
          Sends [0x03, handleId, ...payload] to GN_COMMAND_CHAR.{'\n'}
          Auto-subscribes to GN_NOTIFY_CHAR for responses.
        </Text>

        <View style={styles.gnInputRow}>
          <View style={styles.gnInputGroup}>
            <Text style={styles.gnInputLabel}>Handle ID (hex)</Text>
            <TextInput
              style={styles.hexInput}
              placeholder="e.g. 05"
              placeholderTextColor="#AAA"
              value={handleId}
              onChangeText={setHandleId}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <View style={[styles.gnInputGroup, { flex: 2 }]}>
            <Text style={styles.gnInputLabel}>Payload (hex bytes)</Text>
            <TextInput
              style={styles.hexInput}
              placeholder="e.g. 01 02"
              placeholderTextColor="#AAA"
              value={handlePayload}
              onChangeText={setHandlePayload}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>

        <TouchableOpacity
          style={styles.sendBtn}
          onPress={() => void sendGnCommand()}
          activeOpacity={0.7}
        >
          <Text style={styles.sendBtnText}>
            Send [0x03, {handleId || '??'}, {handlePayload || '...'}]
          </Text>
        </TouchableOpacity>

        {gnNotifyLog.length > 0 && (
          <View style={styles.gnLogBox}>
            <Text style={styles.gnLogTitle}>
              GN Notify Log {gnNotifySubscribed ? '(live)' : ''}
            </Text>
            {gnNotifyLog.map((line, i) => (
              <Text key={i} style={styles.gnLogLine}>
                {line}
              </Text>
            ))}
          </View>
        )}
      </View>

      {/* ── Section 4: Export ── */}
      <TouchableOpacity
        style={styles.exportBtn}
        onPress={exportLog}
        activeOpacity={0.7}
      >
        <Text style={styles.exportBtnText}>Copy Log ({logRef.current.length} entries)</Text>
      </TouchableOpacity>

      <View style={styles.bottomSpacer} />
    </ScrollView>
      ) : (
      <ScrollView style={styles.scrollContent}>
        {/* ── Auto-Report Tab ── */}
        <Text style={styles.sectionTitle}>Auto-Discovery Report</Text>

        {/* Progress indicator */}
        {autoRunning && (
          <View style={styles.card}>
            <View style={styles.progressRow}>
              <ActivityIndicator size="small" color="#0066CC" />
              <Text style={styles.progressText}>
                Probing {autoCurrent}/{autoTotal} characteristics...
              </Text>
            </View>
            <Text style={styles.progressLabel}>{autoLabel}</Text>
            {autoTotal > 0 && (
              <View style={styles.progressBarBg}>
                <View
                  style={[
                    styles.progressBarFill,
                    { width: `${Math.round((autoCurrent / autoTotal) * 100)}%` },
                  ]}
                />
              </View>
            )}
          </View>
        )}

        {/* Error */}
        {autoError && (
          <View style={[styles.card, styles.errorCard]}>
            <Text style={styles.errorText}>{autoError}</Text>
          </View>
        )}

        {/* Manual trigger button */}
        <TouchableOpacity
          style={[styles.autoDiscoverBtn, autoRunning && styles.autoDiscoverBtnDisabled]}
          onPress={() => void startAutoDiscovery()}
          activeOpacity={0.7}
          disabled={autoRunning}
        >
          <Text style={styles.autoDiscoverBtnText}>
            {autoRunning ? 'Running...' : autoReport ? 'Re-run Auto-Discover' : 'Auto-Discover'}
          </Text>
        </TouchableOpacity>

        {/* Report display */}
        {autoReport && (
          <>
            {/* Summary card */}
            <View style={styles.card}>
              <Text style={styles.reportSummaryTitle}>Summary</Text>
              <Text style={styles.reportSummaryText}>
                Services: {autoReport.services.length}
                {'  |  '}Characteristics:{' '}
                {autoReport.services.reduce((n, s) => n + s.characteristics.length, 0)}
                {'  |  '}GN handles: {Object.keys(autoReport.gnHandleMap).length}
              </Text>
              <Text style={styles.reportTimestamp}>{autoReport.timestamp}</Text>
            </View>

            {/* Per-service/characteristic results */}
            {autoReport.services.map((svc) => (
              <View key={svc.uuid} style={styles.card}>
                <Text style={styles.serviceUuid}>{svc.uuid}</Text>
                {svc.characteristics.map((ch) => (
                  <View key={ch.uuid} style={styles.reportCharBlock}>
                    <Text style={styles.reportCharUuid}>{ch.uuid}</Text>
                    <Text style={styles.reportCharProps}>
                      {ch.properties.join(' | ')}
                    </Text>
                    {ch.readValue && (
                      <Text style={styles.reportValue}>
                        Read: {ch.readValue}
                      </Text>
                    )}
                    {ch.readInterpretations.length > 0 && (
                      <View style={styles.reportInterpretations}>
                        {ch.readInterpretations.map((interp, i) => (
                          <Text key={i} style={styles.reportInterpLine}>
                            {interp}
                          </Text>
                        ))}
                      </View>
                    )}
                    {ch.notifications.length > 0 && (
                      <Text style={styles.reportValue}>
                        Notifications ({ch.notifications.length}):{' '}
                        {ch.notifications.join(', ')}
                      </Text>
                    )}
                    {ch.writeResult && (
                      <Text style={styles.reportWriteResult}>
                        Write: {ch.writeResult}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            ))}

            {/* GN Handle Map */}
            {Object.keys(autoReport.gnHandleMap).length > 0 && (
              <View style={styles.card}>
                <Text style={styles.reportSummaryTitle}>GN Handle Map</Text>
                {Object.entries(autoReport.gnHandleMap).map(([handle, resp]) => (
                  <View key={handle} style={styles.gnHandleRow}>
                    <Text style={styles.gnHandleKey}>{handle}</Text>
                    <Text style={styles.gnHandleValue}>{resp}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Share Report button */}
            <TouchableOpacity
              style={styles.shareBtn}
              onPress={shareAutoReport}
              activeOpacity={0.7}
            >
              <Text style={styles.shareBtnText}>Share Report</Text>
            </TouchableOpacity>
          </>
        )}

        <View style={styles.bottomSpacer} />
      </ScrollView>
      )}
    </View>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  scrollContent: {
    flex: 1,
    padding: 12,
  },
  // Tab bar
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#FFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#DDD',
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#0066CC',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#999',
  },
  tabTextActive: {
    color: '#0066CC',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1A1A1A',
    marginTop: 16,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  muted: {
    color: '#999',
    fontStyle: 'italic',
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  card: {
    backgroundColor: '#FFF',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
  },
  cardDimmed: {
    opacity: 0.5,
  },

  // Section 1
  serviceUuid: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#0066CC',
    fontWeight: '600',
  },
  charCount: {
    fontSize: 11,
    color: '#999',
    marginTop: 2,
  },
  charRow: {
    marginLeft: 12,
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#EEE',
  },
  charUuid: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#333',
  },
  charProps: {
    fontSize: 10,
    color: '#0066CC',
    marginTop: 1,
  },

  // Section 2
  probeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  probeLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1A1A1A',
    flex: 1,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#FFF',
  },
  probeUuid: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#666',
    marginBottom: 8,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 6,
  },
  probeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: '#F0F0F0',
    borderWidth: 1,
    borderColor: '#DDD',
  },
  probeBtnActive: {
    backgroundColor: '#6A1B9A',
    borderColor: '#6A1B9A',
  },
  probeBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
  },
  probeBtnTextActive: {
    color: '#FFF',
  },
  writeRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  hexInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#DDD',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    fontFamily: 'monospace',
    color: '#333',
    backgroundColor: '#FAFAFA',
  },
  writeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: '#1565C0',
  },
  writeBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFF',
  },
  probeData: {
    marginTop: 8,
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#2E7D32',
    backgroundColor: '#F5FFF5',
    padding: 8,
    borderRadius: 4,
  },

  // Section 3
  gnDesc: {
    fontSize: 12,
    color: '#666',
    marginBottom: 10,
    lineHeight: 18,
  },
  gnInputRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  gnInputGroup: {
    flex: 1,
  },
  gnInputLabel: {
    fontSize: 11,
    color: '#666',
    marginBottom: 4,
    fontWeight: '500',
  },
  sendBtn: {
    backgroundColor: '#E65100',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  sendBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFF',
    fontFamily: 'monospace',
  },
  gnLogBox: {
    marginTop: 10,
    backgroundColor: '#1A1A1A',
    borderRadius: 6,
    padding: 10,
  },
  gnLogTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6A1B9A',
    marginBottom: 6,
  },
  gnLogLine: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#4CAF50',
    lineHeight: 16,
  },

  // Section 4
  exportBtn: {
    marginTop: 16,
    backgroundColor: '#0066CC',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  exportBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFF',
  },
  // Auto-report styles
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  progressText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
  },
  progressLabel: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#666',
    marginBottom: 8,
  },
  progressBarBg: {
    height: 4,
    backgroundColor: '#E0E0E0',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: 4,
    backgroundColor: '#0066CC',
    borderRadius: 2,
  },
  errorCard: {
    borderLeftWidth: 3,
    borderLeftColor: '#B71C1C',
  },
  errorText: {
    fontSize: 13,
    color: '#B71C1C',
  },
  autoDiscoverBtn: {
    backgroundColor: '#0066CC',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 12,
  },
  autoDiscoverBtnDisabled: {
    backgroundColor: '#999',
  },
  autoDiscoverBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFF',
  },
  reportSummaryTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 4,
  },
  reportSummaryText: {
    fontSize: 12,
    color: '#333',
    marginBottom: 2,
  },
  reportTimestamp: {
    fontSize: 10,
    color: '#999',
    marginTop: 2,
  },
  reportCharBlock: {
    marginLeft: 8,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#EEE',
  },
  reportCharUuid: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#333',
    fontWeight: '600',
  },
  reportCharProps: {
    fontSize: 10,
    color: '#0066CC',
    marginTop: 1,
    marginBottom: 4,
  },
  reportValue: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#2E7D32',
    marginTop: 2,
  },
  reportInterpretations: {
    marginLeft: 8,
    marginTop: 2,
  },
  reportInterpLine: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#6A1B9A',
  },
  reportWriteResult: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#1565C0',
    marginTop: 2,
  },
  gnHandleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#EEE',
  },
  gnHandleKey: {
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '600',
    color: '#333',
  },
  gnHandleValue: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#2E7D32',
    flex: 1,
    textAlign: 'right',
  },
  shareBtn: {
    backgroundColor: '#2E7D32',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  shareBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFF',
  },
  bottomSpacer: {
    height: 40,
  },
});
