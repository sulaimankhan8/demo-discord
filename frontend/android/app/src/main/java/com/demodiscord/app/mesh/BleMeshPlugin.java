package com.demodiscord.app.mesh;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.Map;
import java.util.UUID;

/**
 * Capacitor bridge for the offline mesh's Bluetooth link layer. The web side is
 * frontend/lib/mesh/transports/BleLinkTransport.ts. Frames cross the bridge as base64.
 */
@CapacitorPlugin(
    name = "BleMesh",
    permissions = {
        @Permission(alias = "bluetooth", strings = {
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT
        }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class BleMeshPlugin extends Plugin implements BleMeshEngine.Listener {

    private final Handler main = new Handler(Looper.getMainLooper());
    private BleMeshEngine engine;

    @Override
    public void load() {
        engine = new BleMeshEngine(getContext(), this);
    }

    /* ---------------- permissions ---------------- */

    /** Android 12+ uses the Bluetooth permissions; older versions need location to scan. */
    private String[] requiredAliases() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? new String[] { "bluetooth" } : new String[] { "location" };
    }

    private boolean hasMeshPermissions() {
        for (String alias : requiredAliases()) {
            if (getPermissionState(alias) != PermissionState.GRANTED) return false;
        }
        return true;
    }

    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        if (hasMeshPermissions()) {
            resolveGranted(call);
            return;
        }
        String[] aliases = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ? new String[] { "bluetooth", "notifications" } // notifications: for the "mesh running" notice
            : requiredAliases();
        requestPermissionForAliases(aliases, call, "permissionsDone");
    }

    @PermissionCallback
    private void permissionsDone(PluginCall call) {
        resolveGranted(call);
    }

    private void resolveGranted(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasMeshPermissions());
        call.resolve(result);
    }

    /* ---------------- lifecycle ---------------- */

    @PluginMethod
    public void start(PluginCall call) {
        if (!hasMeshPermissions()) {
            call.reject("Bluetooth permission wasn't granted.", "PERMISSION");
            return;
        }
        UUID service;
        UUID characteristic;
        try {
            service = UUID.fromString(call.getString("serviceUuid", BleMeshEngine.DEFAULT_SERVICE_UUID.toString()));
            characteristic = UUID.fromString(call.getString("characteristicUuid", BleMeshEngine.DEFAULT_CHARACTERISTIC_UUID.toString()));
        } catch (IllegalArgumentException e) {
            call.reject("Invalid service UUID.", "BAD_ARGUMENT");
            return;
        }
        int maxLinks = call.getInt("maxLinks", 7);
        main.post(() -> {
            String error = engine.start(service, characteristic, maxLinks);
            if ("BLUETOOTH_OFF".equals(error)) {
                call.reject("Bluetooth is off.", error);
            } else if ("UNSUPPORTED".equals(error)) {
                call.reject("This phone doesn't support Bluetooth Low Energy.", error);
            } else if (error != null) {
                call.reject(error, error);
            } else {
                startForegroundService();
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            engine.stop();
            stopForegroundService();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        main.post(() -> {
            engine.stop();
            stopForegroundService();
        });
    }

    /* ---------------- data ---------------- */

    @PluginMethod
    public void send(PluginCall call) {
        String linkId = call.getString("linkId");
        String data = call.getString("data");
        if (linkId == null || data == null) {
            call.reject("linkId and data are required.", "BAD_ARGUMENT");
            return;
        }
        byte[] frame;
        try {
            frame = Base64.decode(data, Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            call.reject("data must be base64.", "BAD_ARGUMENT");
            return;
        }
        main.post(() -> {
            JSObject result = new JSObject();
            result.put("queued", engine.send(linkId, frame));
            call.resolve(result);
        });
    }

    @PluginMethod
    public void getState(PluginCall call) {
        main.post(() -> call.resolve(stateObject()));
    }

    /** Shows Android's "Turn on Bluetooth?" dialog. */
    @PluginMethod
    public void enableBluetooth(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("bluetooth") != PermissionState.GRANTED) {
            call.reject("Bluetooth permission wasn't granted.", "PERMISSION");
            return;
        }
        try {
            Intent intent = new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't open the Bluetooth dialog.", "UNAVAILABLE");
        }
    }

    private JSObject stateObject() {
        JSObject state = new JSObject();
        state.put("running", engine.isRunning());
        state.put("bluetoothOn", engine.isBluetoothOn());
        state.put("advertising", engine.isAdvertising());
        state.put("scanning", engine.isScanning());
        String error = engine.getLastError();
        if (error != null) state.put("error", error);
        JSArray links = new JSArray();
        for (Map<String, Object> link : engine.describeLinks()) {
            JSObject l = new JSObject();
            for (Map.Entry<String, Object> e : link.entrySet()) l.put(e.getKey(), e.getValue());
            links.put(l);
        }
        state.put("links", links);
        return state;
    }

    /* ---------------- engine events → web ---------------- */

    @Override
    public void onLinkUp(String linkId, int maxFrameBytes, String role) {
        JSObject e = new JSObject();
        e.put("linkId", linkId);
        e.put("maxFrameBytes", maxFrameBytes);
        e.put("role", role);
        notifyListeners("linkUp", e);
    }

    @Override
    public void onLinkDown(String linkId) {
        JSObject e = new JSObject();
        e.put("linkId", linkId);
        notifyListeners("linkDown", e);
    }

    @Override
    public void onData(String linkId, byte[] data) {
        JSObject e = new JSObject();
        e.put("linkId", linkId);
        e.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
        notifyListeners("data", e);
    }

    @Override
    public void onStateChanged() {
        notifyListeners("state", stateObject());
    }

    /* ---------------- foreground service ---------------- */

    private void startForegroundService() {
        try {
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), MeshForegroundService.class));
        } catch (Exception e) {
            // Not fatal: the mesh still works while the app is open.
        }
    }

    private void stopForegroundService() {
        try {
            getContext().stopService(new Intent(getContext(), MeshForegroundService.class));
        } catch (Exception ignored) {
        }
    }
}
