/**
 * ControlPanel — volume, program, mute controls.
 * All controls are stubs — TODO: wire to actual adapter methods.
 */
import React, { useState } from 'react';
import { StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import Slider from '@react-native-community/slider';
import type { Brand } from '../ble/types';

interface ControlPanelProps {
  brand: Brand;
}

export function ControlPanel({ brand }: ControlPanelProps) {
  const [volume, setVolume] = useState(50);
  const [muted, setMuted] = useState(false);
  const [program, setProgram] = useState(0);

  // TODO: Replace local state with actual adapter calls (SPEC.md §4)
  const handleVolumeChange = (value: number) => {
    setVolume(Math.round(value));
    // TODO: adapter.setVolume(value) — see SPEC.md §2.x for brand-specific protocol
  };

  const handleMuteToggle = (value: boolean) => {
    setMuted(value);
    // TODO: adapter.setMute(value) — see SPEC.md §2.x for brand-specific protocol
  };

  const handleProgramSelect = (index: number) => {
    setProgram(index);
    // TODO: adapter.setProgram(index) — see SPEC.md §2.x for brand-specific protocol
  };

  // Placeholder programs — TODO: read from adapter.getPrograms()
  const programs = ['Normal', 'Noisy', 'Music', 'Phone'];

  return (
    <View style={styles.container}>
      {/* Volume */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Volume</Text>
        <View style={styles.sliderRow}>
          <Text style={styles.sliderLabel}>0</Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={100}
            step={1}
            value={volume}
            onValueChange={handleVolumeChange}
            minimumTrackTintColor="#0066CC"
            maximumTrackTintColor="#DDD"
            thumbTintColor="#0066CC"
            disabled={muted}
          />
          <Text style={styles.sliderLabel}>100</Text>
        </View>
        <Text style={styles.valueText}>{volume}%</Text>
      </View>

      {/* Mute */}
      <View style={styles.section}>
        <View style={styles.muteRow}>
          <Text style={styles.sectionTitle}>Mute</Text>
          <Switch
            value={muted}
            onValueChange={handleMuteToggle}
            trackColor={{ false: '#DDD', true: '#CC3333' }}
            thumbColor={muted ? '#FFF' : '#FFF'}
          />
        </View>
      </View>

      {/* Programs */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Program</Text>
        <View style={styles.programRow}>
          {programs.map((name, index) => (
            <TouchableOpacity
              key={index}
              style={[
                styles.programButton,
                index === program && styles.programButtonActive,
              ]}
              onPress={() => handleProgramSelect(index)}
              activeOpacity={0.7}>
              <Text
                style={[
                  styles.programText,
                  index === program && styles.programTextActive,
                ]}>
                {name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <Text style={styles.stubNote}>
        Controls are UI-only stubs. BLE writes not yet implemented.
      </Text>
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
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1A1A1A',
    marginBottom: 8,
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
  stubNote: {
    textAlign: 'center',
    color: '#999',
    fontSize: 12,
    marginTop: 8,
    fontStyle: 'italic',
  },
});
