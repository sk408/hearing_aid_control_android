/**
 * Hearing Aid Controller — React Native Android App
 * Entry point with navigation setup.
 */
import React, { useEffect } from 'react';
import { StatusBar, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { restorePersistedBonds } from './src/ble/gn/gnBondState';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { HomeScreen } from './src/screens/HomeScreen';
import { DeviceScreen } from './src/screens/DeviceScreen';
import { BleProbeScreen } from './src/screens/BleProbeScreen';
import type { DiscoveredDevice } from './src/ble/types';

export type RootStackParamList = {
  Home: undefined;
  Device: { device: DiscoveredDevice };
  BleProbe: { deviceId: string };
};

const Stack = createStackNavigator<RootStackParamList>();

function App(): React.JSX.Element {
  const isDarkMode = useColorScheme() === 'dark';

  useEffect(() => {
    restorePersistedBonds();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
        <NavigationContainer>
          <Stack.Navigator
            initialRouteName="Home"
            screenOptions={{
              headerStyle: { backgroundColor: '#0066CC' },
              headerTintColor: '#FFF',
              headerTitleStyle: { fontWeight: '600' },
            }}>
            <Stack.Screen
              name="Home"
              component={HomeScreen}
              options={{ title: 'Hearing Aid Controller' }}
            />
            <Stack.Screen
              name="Device"
              component={DeviceScreen}
              options={({ route }) => ({
                title: route.params.device.name ?? 'Device',
              })}
            />
            <Stack.Screen
              name="BleProbe"
              component={BleProbeScreen}
              options={{ title: 'BLE Probe' }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default App;
