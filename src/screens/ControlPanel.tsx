/**
 * ControlPanel — volume, program, mute controls wired to the BLE adapter.
 * Visual feedback: spinner while writing, checkmark on success, error on failure.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import type { Brand, Program } from '../ble/types';
import { useDeviceStore } from '../store/deviceStore';

interface ControlPanelProps {
  brand: Brand;
}

/** Feedback state for a single control */
type FeedbackState = 'idle' | 'busy' | 'ok' | 'error';

interface ControlFeedback {
  state: FeedbackState;
  message?: string;
}

/** Small inline feedback indicator */
function FeedbackBadge({ feedback }: { feedback: ControlFeedback }) {
  if (feedback.state === 'idle') return null;

  if (feedback.state === 'busy') {
    return (
      <View style={badgeStyles.container}>
        <ActivityIndicator size="small" color="#0066CC" />
      </View>
    );
  }

  if (feedback.state === 'ok') {
    return (
      <View style={badgeStyles.container}>
        <Text style={badgeStyles.ok}>OK</Text>
      </View>
    );
  }

  return (
    <View style={badgeStyles.container}>
      <Text style={badgeStyles.error}>Failed</Text>
      {feedback.message ? (
        <Text style={badgeStyles.errorMsg} numberOfLines={2}>
          {feedback.message}
        </Text>
      ) : null}
    </View>
  );
}

const badgeStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
    gap: 4,
  },
  ok: {
    fontSize: 13,
    fontWeight: '700',
    color: '#2E8B57',
  },
  error: {
    fontSize: 13,
    fontWeight: '700',
    color: '#CC3333',
  },
  errorMsg: {
    fontSize: 11,
    color: '#CC3333',
    flexShrink: 1,
  },
});

/** Run an adapter call, manage feedback state, and log the BLE op */
function useAdapterCall() {
  const logBleOp = useDeviceStore((s) => s.logBleOp);

  return useCallback(
    async (
      opName: string,
      setFeedback: (fb: ControlFeedback) => void,
      fn: () => Promise<void>,
    ) => {
      setFeedback({ state: 'busy' });
      logBleOp(opName, 'in progress...');
      try {
        await fn();
        logBleOp(opName, 'OK');
        setFeedback({ state: 'ok' });
        setTimeout(() => setFeedback({ state: 'idle' }), 1500);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        logBleOp(opName, `FAILED: ${msg}`);
        setFeedback({ state: 'error', message: msg });
        setTimeout(() => setFeedback({ state: 'idle' }), 4000);
      }
    },
    [logBleOp],
  );
}

export function ControlPanel({ brand }: ControlPanelProps) {
  const adapter = useDeviceStore((s) => s.adapter);
  const driverState = useDeviceStore((s) => s.driverState);
  const setDriverState = useDeviceStore((s) => s.setDriverState);
  const logBleOp = useDeviceStore((s) => s.logBleOp);
  const runCall = useAdapterCall();

  // Local UI state — initialized from driver state when available
  const [volume, setVolume] = useState(driverState?.volume ?? 50);
  const [muted, setMuted] = useState(driverState?.muted ?? false);
  const [program, setProgram] = useState(driverState?.activeProgram ?? 0);
  const [programs, setPrograms] = useState<Program[]>([
    { index: 0, name: 'Program 1' },
    { index: 1, name: 'Program 2' },
    { index: 2, name: 'Program 3' },
    { index: 3, name: 'Program 4' },
  ]);

  // Feedback per control
  const [volumeFb, setVolumeFb] = useState<ControlFeedback>({ state: 'idle' });
  const [muteFb, setMuteFb] = useState<ControlFeedback>({ state: 'idle' });
  const [programFb, setProgramFb] = useState<ControlFeedback>({ state: 'idle' });
  const [refreshFb, setRefreshFb] = useState<ControlFeedback>({ state: 'idle' });

  // Sync local state when driver state updates
  const prevDriverState = useRef(driverState);
  useEffect(() => {
    if (driverState && driverState !== prevDriverState.current) {
      if (driverState.volume !== undefined) setVolume(driverState.volume);
      if (driverState.muted !== undefined) setMuted(driverState.muted);
      if (driverState.activeProgram !== undefined) setProgram(driverState.activeProgram);
    }
    prevDriverState.current = driverState;
  }, [driverState]);

  // Load programs from adapter on mount
  useEffect(() => {
    if (!adapter) return;
    void adapter.getPrograms().then(setPrograms).catch(() => {});
  }, [adapter]);

  // ── Handlers ──

  const handleVolumeChangeEnd = useCallback(
    (value: number) => {
      const rounded = Math.round(value);
      setVolume(rounded);
      if (!adapter) return;
      void runCall('setVolume', setVolumeFb, () => adapter.setVolume(rounded));
    },
    [adapter, runCall],
  );

  const handleMuteToggle = useCallback(
    (value: boolean) => {
      setMuted(value);
      if (!adapter) return;
      void runCall('setMute', setMuteFb, () => adapter.setMute(value));
    },
    [adapter, runCall],
  );

  const handleProgramSelect = useCallback(
    (index: number) => {
      setProgram(index);
      if (!adapter) return;
      void runCall('setProgram', setProgramFb, () => adapter.setProgram(index));
    },
    [adapter, runCall],
  );

  const handleRefresh = useCallback(() => {
    if (!adapter) return;
    void (async () => {
      setRefreshFb({ state: 'busy' });
      logBleOp('refreshState', 'in progress...');
      try {
        const state = await adapter.refreshState();
        setDriverState(state);
        logBleOp('refreshState', 'OK');
        setRefreshFb({ state: 'ok' });
        setTimeout(() => setRefreshFb({ state: 'idle' }), 1500);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        logBleOp('refreshState', `FAILED: ${msg}`);
        setRefreshFb({ state: 'error', message: msg });
        setTimeout(() => setRefreshFb({ state: 'idle' }), 4000);
      }
    })();
  }, [adapter, setDriverState, logBleOp]);

  const noAdapter = !adapter;

  return (
    <View style={styles.container}>
      {/* Volume */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Volume</Text>
          <FeedbackBadge feedback={volumeFb} />
        </View>
        <View style={styles.sliderRow}>
          <Text style={styles.sliderLabel}>0</Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={100}
            step={1}
            value={volume}
            onValueChange={setVolume}
            onSlidingComplete={handleVolumeChangeEnd}
            minimumTrackTintColor="#0066CC"
            maximumTrackTintColor="#DDD"
            thumbTintColor="#0066CC"
            disabled={muted || noAdapter || volumeFb.state === 'busy'}
          />
          <Text style={styles.sliderLabel}>100</Text>
        </View>
        <Text style={styles.valueText}>{volume}%</Text>
      </View>

      {/* Mute */}
      <View style={styles.section}>
        <View style={styles.muteRow}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Mute</Text>
            <FeedbackBadge feedback={muteFb} />
          </View>
          <Switch
            value={muted}
            onValueChange={handleMuteToggle}
            trackColor={{ false: '#DDD', true: '#CC3333' }}
            thumbColor="#FFF"
            disabled={noAdapter || muteFb.state === 'busy'}
          />
        </View>
      </View>

      {/* Programs */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Program</Text>
          <FeedbackBadge feedback={programFb} />
        </View>
        <View style={styles.programRow}>
          {programs.map((p) => (
            <TouchableOpacity
              key={p.index}
              style={[
                styles.programButton,
                p.index === program && styles.programButtonActive,
              ]}
              onPress={() => handleProgramSelect(p.index)}
              activeOpacity={0.7}
              disabled={noAdapter || programFb.state === 'busy'}
            >
              <Text
                style={[
                  styles.programText,
                  p.index === program && styles.programTextActive,
                ]}>
                {p.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Refresh */}
      <TouchableOpacity
        style={styles.refreshButton}
        onPress={handleRefresh}
        activeOpacity={0.7}
        disabled={noAdapter || refreshFb.state === 'busy'}
      >
        <Text style={styles.refreshText}>Refresh State</Text>
        <FeedbackBadge feedback={refreshFb} />
      </TouchableOpacity>

      {/* Battery */}
      {driverState?.batteryPercent !== undefined && (
        <View style={styles.batteryRow}>
          <Text style={styles.batteryText}>
            Battery: {driverState.batteryPercent}%
          </Text>
        </View>
      )}

      {noAdapter && (
        <Text style={styles.stubNote}>
          Adapter not connected. Controls disabled.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  section: {
    backgroundColor: '#FFF',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  slider: {
    flex: 1,
    marginHorizontal: 8,
  },
  sliderLabel: {
    fontSize: 12,
    color: '#999',
    width: 28,
    textAlign: 'center',
  },
  valueText: {
    textAlign: 'center',
    fontSize: 14,
    color: '#0066CC',
    fontWeight: '600',
    marginTop: 4,
  },
  muteRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  programRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  programButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#F0F0F0',
    borderWidth: 1,
    borderColor: '#DDD',
  },
  programButtonActive: {
    backgroundColor: '#0066CC',
    borderColor: '#0066CC',
  },
  programText: {
    fontSize: 14,
    color: '#333',
    fontWeight: '500',
  },
  programTextActive: {
    color: '#FFF',
  },
  refreshButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFF',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  refreshText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0066CC',
  },
  batteryRow: {
    backgroundColor: '#FFF',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
    alignItems: 'center',
  },
  batteryText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  stubNote: {
    textAlign: 'center',
    color: '#999',
    fontSize: 12,
    marginTop: 8,
    fontStyle: 'italic',
  },
});
