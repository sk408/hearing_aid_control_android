package com.hearingaidcontrol

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Exposes Android's BluetoothDevice.createBond() to JavaScript.
 *
 * react-native-ble-plx provides no bonding API. On Android 6+, the OS no
 * longer auto-initiates bonding when a GATT op returns GATT_INSUF_AUTHENTICATION —
 * the app must call createBond() explicitly to trigger the system pairing dialog.
 */
class BleBondModule(private val reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "BleBond"

    /**
     * All devices paired with Android that are BLE-capable (LE, dual-mode, or unknown type).
     * Classic-only peripherals are omitted — they cannot be used with GATT / this app.
     * Address format matches react-native-ble-plx (e.g. AA:BB:CC:DD:EE:FF).
     */
    @SuppressLint("MissingPermission")
    @ReactMethod
    fun getBondedBleDevices(promise: Promise) {
        try {
            val adapter = BluetoothAdapter.getDefaultAdapter()
                ?: return promise.reject("BT_UNAVAILABLE", "Bluetooth not available")

            val out = Arguments.createArray()
            for (device in adapter.bondedDevices) {
                if (device.bondState != BluetoothDevice.BOND_BONDED) continue

                val type = device.type
                // Skip BR/EDR-only — not addressable as BLE peripherals here
                if (type == BluetoothDevice.DEVICE_TYPE_CLASSIC) continue

                val row = Arguments.createMap()
                row.putString("address", device.address?.uppercase())
                row.putString("name", device.name)
                row.putInt("deviceType", type)
                out.pushMap(row)
            }
            promise.resolve(out)
        } catch (e: Exception) {
            promise.reject("BONDED_LIST_FAILED", e.message ?: "Unknown error")
        }
    }

    /** Returns the Android bond state integer: 10=NONE, 11=BONDING, 12=BONDED */
    @SuppressLint("MissingPermission")
    @ReactMethod
    fun getBondState(macAddress: String, promise: Promise) {
        try {
            val adapter = BluetoothAdapter.getDefaultAdapter()
                ?: return promise.reject("BT_UNAVAILABLE", "Bluetooth not available")
            promise.resolve(adapter.getRemoteDevice(macAddress).bondState)
        } catch (e: Exception) {
            promise.reject("GET_BOND_STATE_FAILED", e.message ?: "Unknown error")
        }
    }

    /**
     * Initiates Android BLE bonding.  Resolves when BOND_BONDED, rejects on
     * rejection / timeout (60 s).  If already bonded, resolves immediately.
     */
    @SuppressLint("MissingPermission")
    @ReactMethod
    fun createBond(macAddress: String, promise: Promise) {
        try {
            val adapter = BluetoothAdapter.getDefaultAdapter()
                ?: return promise.reject("BT_UNAVAILABLE", "Bluetooth not available")
            val device = adapter.getRemoteDevice(macAddress)

            if (device.bondState == BluetoothDevice.BOND_BONDED) {
                promise.resolve("BONDED")
                return
            }

            var settled = false

            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    if (intent.action != BluetoothDevice.ACTION_BOND_STATE_CHANGED) return

                    val changed: BluetoothDevice? =
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            intent.getParcelableExtra(
                                BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                        } else {
                            @Suppress("DEPRECATION")
                            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                        }

                    if (changed?.address != macAddress) return

                    val bondState = intent.getIntExtra(
                        BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR)
                    val prevState = intent.getIntExtra(
                        BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, BluetoothDevice.ERROR)

                    when {
                        bondState == BluetoothDevice.BOND_BONDED && !settled -> {
                            settled = true
                            safeUnregister(this)
                            promise.resolve("BONDED")
                        }
                        bondState == BluetoothDevice.BOND_NONE
                                && prevState == BluetoothDevice.BOND_BONDING
                                && !settled -> {
                            settled = true
                            safeUnregister(this)
                            promise.reject("BOND_REJECTED", "Pairing was rejected or failed")
                        }
                    }
                }
            }

            val filter = IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                reactContext.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
            } else {
                reactContext.registerReceiver(receiver, filter)
            }

            // 60-second safety timeout
            Handler(Looper.getMainLooper()).postDelayed({
                if (!settled) {
                    settled = true
                    safeUnregister(receiver)
                    promise.reject("BOND_TIMEOUT", "Pairing timed out after 60 seconds")
                }
            }, 60_000L)

            val started = device.createBond()
            if (!started && !settled) {
                settled = true
                safeUnregister(receiver)
                promise.reject("BOND_START_FAILED", "createBond() returned false")
            }
        } catch (e: Exception) {
            promise.reject("BOND_FAILED", e.message ?: "Unknown error")
        }
    }

    private fun safeUnregister(receiver: BroadcastReceiver) {
        try { reactContext.unregisterReceiver(receiver) } catch (_: Exception) {}
    }
}
