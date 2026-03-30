/**
 * ControlPanel — dual hearing aid control panel with linked/unlinked modes.
 * When linked: single volume slider controls both aids.
 * When unlinked: separate sliders for left and right.
 * Programs always sync both. Battery shown per device.
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
import type { Program } from '../ble/types';
import { useDeviceStore } from '../store/deviceStore';
import type { DeviceSlot } from '../store/deviceStore';
import type { HearingAidAdapter, DriverState } from '../adapters/types';

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

/** Run an operation on one or both adapters */
async function runOnAdapters(
  adapters: HearingAidAdapter[],
  fn: (adapter: HearingAidAdapter) => Promise<void>,
): Promise<void> {
  await Promise.all(adapters.map(fn));
}

export function ControlPanel() {
  const leftDevice = useDeviceStore((s) => s.leftDevice);
  const rightDevice = useDeviceStore((s) => s.rightDevice);
  const linked = useDeviceStore((s) => s.linked);
  const setLinked = useDeviceStore((s) => s.setLinked);
  const updateDriverState = useDeviceStore((s) => s.updateDriverState);
  const logBleOp = useDeviceStore((s) => s.logBleOp);
  const runCall = useAdapterCall();

  // Derive adapters
  const leftAdapter = leftDevice?.adapter ?? null;
  const rightAdapter = rightDevice?.adapter ?? null;
  const bothAdapters = [leftAdapter, rightAdapter].filter(Boolean) as HearingAidAdapter[];
  const hasAny = bothAdapters.length > 0;
  const hasBoth = leftAdapter != null && rightAdapter != null;

  // Local UI state
  const [volume, setVolume] = useState(
    leftDevice?.driverState?.volume ?? rightDevice?.driverState?.volume ?? 50,
  );
  const [leftVolume, setLeftVolume] = useState(leftDevice?.driverState?.volume ?? 50);
  const [rightVolume, setRightVolume] = useState(rightDevice?.driverState?.volume ?? 50);
  const [muted, setMuted] = useState(
    leftDevice?.driverState?.muted ?? rightDevice?.driverState?.muted ?? false,
  );
  const [program, setProgram] = useState(
    leftDevice?.driverState?.activeProgram ?? rightDevice?.driverState?.activeProgram ?? 0,
  );
  const [programs, setPrograms] = useState<Program[]>([
    { index: 0, name: 'Program 1' },
    { index: 1, name: 'Program 2' },
    { index: 2, name: 'Program 3' },
    { index: 3, name: 'Program 4' },
  ]);

  // Feedback per control
  const [volumeFb, setVolumeFb] = useState<ControlFeedback>({ state: 'idle' });
  const [leftVolumeFb, setLeftVolumeFb] = useState<ControlFeedback>({ state: 'idle' });
  const [rightVolumeFb, setRightVolumeFb] = useState<ControlFeedback>({ state: 'idle' });
  const [muteFb, setMuteFb] = useState<ControlFeedback>({ state: 'idle' });
  const [programFb, setProgramFb] = useState<ControlFeedback>({ state: 'idle' });
  const [refreshFb, setRefreshFb] = useState<ControlFeedback>({ state: 'idle' });

  // Sync local state when driver state updates
  const prevLeft = useRef(leftDevice?.driverState);
  const prevRight = useRef(rightDevice?.driverState);

  useEffect(() => {
    const ld = leftDevice?.driverState;
    if (ld && ld !== prevLeft.current) {
      if (ld.volume !== undefined) {
        setLeftVolume(ld.volume);
        if (linked) setVolume(ld.volume);
      }
      if (ld.muted !== undefined) setMuted(ld.muted);
      if (ld.activeProgram !== undefined) setProgram(ld.activeProgram);
    }
    prevLeft.current = ld;
  }, [leftDevice?.driverState, linked]);

  useEffect(() => {
    const rd = rightDevice?.driverState;
    if (rd && rd !== prevRight.current) {
      if (rd.volume !== undefined) {
        setRightVolume(rd.volume);
        if (linked && !leftDevice) setVolume(rd.volume);
      }
      if (rd.muted !== undefined && !leftDevice) setMuted(rd.muted);
      if (rd.activeProgram !== undefined && !leftDevice) setProgram(rd.activeProgram);
    }
    prevRight.current = rd;
  }, [rightDevice?.driverState, linked, leftDevice]);

  // Load programs from first available adapter
  useEffect(() => {
    const adapter = leftAdapter ?? rightAdapter;
    if (!adapter) return;
    void adapter.getPrograms().then(setPrograms).catch(() => {});
  }, [leftAdapter, rightAdapter]);

  // ── Handlers ──

  const handleLinkedVolumeEnd = useCallback(
    (value: number) => {
      const rounded = Math.round(value);
      setVolume(rounded);
      if (!hasAny) return;
      void runCall('setVolume (both)', setVolumeFb, () =>
        runOnAdapters(bothAdapters, (a) => a.setVolume(rounded)),
      );
    },
    [hasAny, bothAdapters, runCall],
  );

  const handleLeftVolumeEnd = useCallback(
    (value: number) => {
      const rounded = Math.round(value);
      setLeftVolume(rounded);
      if (!leftAdapter) return;
      void runCall('setVolume (left)', setLeftVolumeFb, () =>
        leftAdapter.setVolume(rounded),
      );
    },
    [leftAdapter, runCall],
  );

  const handleRightVolumeEnd = useCallback(
    (value: number) => {
      const rounded = Math.round(value);
      setRightVolume(rounded);
      if (!rightAdapter) return;
      void runCall('setVolume (right)', setRightVolumeFb, () =>
        rightAdapter.setVolume(rounded),
      );
    },
    [rightAdapter, runCall],
  );

  const handleMuteToggle = useCallback(
    (value: boolean) => {
      setMuted(value);
      if (!hasAny) return;
      void runCall('setMute', setMuteFb, () =>
        runOnAdapters(bothAdapters, (a) => a.setMute(value)),
      );
    },
    [hasAny, bothAdapters, runCall],
  );

  const handleProgramSelect = useCallback(
    (index: number) => {
      setProgram(index);
      if (!hasAny) return;
      // Programs always sync both aids
      void runCall('setProgram', setProgramFb, () =>
        runOnAdapters(bothAdapters, (a) => a.setProgram(index)),
      );
    },
    [hasAny, bothAdapters, runCall],
  );

  const handleRefresh = useCallback(() => {
    if (!hasAny) return;
    void (async () => {
      setRefreshFb({ state: 'busy' });
      logBleOp('refreshState', 'in progress...');
      try {
        if (leftAdapter) {
          const state = await leftAdapter.refreshState();
          updateDriverState('left', state);
        }
        if (rightAdapter) {
          const state = await rightAdapter.refreshState();
          updateDriverState('right', state);
        }
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
  }, [hasAny, leftAdapter, rightAdapter, updateDriverState, logBleOp]);

  return (
    <View style={styles.container}>
      {/* Linked toggle — only shown when both devices connected */}
      {hasBoth && (
        <View style={styles.section}>
          <View style={styles.linkedRow}>
            <Text style={styles.linkedLabel}>
              Linked
            </Text>
            <Switch
              value={linked}
              onValueChange={setLinked}
              trackColor={{ false: '#DDD', true: '#0066CC' }}
              thumbColor="#FFF"
            />
          </View>
          <Text style={styles.linkedHint}>
            {linked
              ? 'Controls affect both hearing aids'
              : 'Control each hearing aid independently'}
          </Text>
        </View>
      )}

      {/* Volume — linked mode */}
      {(linked || !hasBoth) && (
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
              onSlidingComplete={handleLinkedVolumeEnd}
              minimumTrackTintColor="#0066CC"
              maximumTrackTintColor="#DDD"
              thumbTintColor="#0066CC"
              disabled={muted || !hasAny || volumeFb.state === 'busy'}
            />
            <Text style={styles.sliderLabel}>100</Text>
          </View>
          <Text style={styles.valueText}>{volume}%</Text>
        </View>
      )}

      {/* Volume — unlinked mode (separate sliders) */}
      {!linked && hasBoth && (
        <>
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Volume — Left</Text>
              <FeedbackBadge feedback={leftVolumeFb} />
            </View>
            <View style={styles.sliderRow}>
              <Text style={styles.sliderLabel}>0</Text>
              <Slider
                style={styles.slider}
                minimumValue={0}
                maximumValue={100}
                step={1}
                value={leftVolume}
                onValueChange={setLeftVolume}
                onSlidingComplete={handleLeftVolumeEnd}
                minimumTrackTintColor="#0066CC"
                maximumTrackTintColor="#DDD"
                thumbTintColor="#0066CC"
                disabled={muted || !leftAdapter || leftVolumeFb.state === 'busy'}
              />
              <Text style={styles.sliderLabel}>100</Text>
            </View>
            <Text style={styles.valueText}>{leftVolume}%</Text>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Volume — Right</Text>
              <FeedbackBadge feedback={rightVolumeFb} />
            </View>
            <View style={styles.sliderRow}>
              <Text style={styles.sliderLabel}>0</Text>
              <Slider
                style={styles.slider}
                minimumValue={0}
                maximumValue={100}
                step={1}
                value={rightVolume}
                onValueChange={setRightVolume}
                onSlidingComplete={handleRightVolumeEnd}
                minimumTrackTintColor="#CC6600"
                maximumTrackTintColor="#DDD"
                thumbTintColor="#CC6600"
                disabled={muted || !rightAdapter || rightVolumeFb.state === 'busy'}
              />
              <Text style={styles.sliderLabel}>100</Text>
            </View>
            <Text style={styles.valueText}>{rightVolume}%</Text>
          </View>
        </>
      )}

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
            disabled={!hasAny || muteFb.state === 'busy'}
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
              disabled={!hasAny || programFb.state === 'busy'}>
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
        disabled={!hasAny || refreshFb.state === 'busy'}>
        <Text style={styles.refreshText}>Refresh State</Text>
        <FeedbackBadge feedback={refreshFb} />
      </TouchableOpacity>

      {/* Battery — per device */}
      {leftDevice?.driverState?.batteryPercent !== undefined && (
        <View style={styles.batteryRow}>
          <Text style={styles.batteryText}>
            Left Battery: {leftDevice.driverState.batteryPercent}%
          </Text>
        </View>
      )}
      {rightDevice?.driverState?.batteryPercent !== undefined && (
        <View style={styles.batteryRow}>
          <Text style={styles.batteryText}>
            Right Battery: {rightDevice.driverState.batteryPercent}%
          </Text>
        </View>
      )}

      {!hasAny && (
        <Text style={styles.stubNote}>
          No hearing aids connected. Go back to scan and connect.
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
  linkedRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  linkedLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0066CC',
  },
  linkedHint: {
    fontSize: 12,
    color: '#999',
    marginTop: 4,
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
