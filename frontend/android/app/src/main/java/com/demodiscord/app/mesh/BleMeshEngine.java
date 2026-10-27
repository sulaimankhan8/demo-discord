package com.demodiscord.app.mesh;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.SystemClock;
import android.util.Log;

import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * BLE link layer for the offline mesh. Each phone advertises a GATT service (so others can
 * find and connect to it) and scans for the same service (so it can connect to others), at the
 * same time. It only finds phones, keeps links open and moves raw frames; all mesh logic
 * (routing, dedup, signatures) lives in the web code (frontend/lib/mesh).
 *
 * Duplicate links: each phone puts a random 8-byte node id in its scan response (iPhones put
 * "M" + the id in hex in their local name instead, since iOS can't advertise service data). The phone with
 * the lower id connects; the other waits (and connects anyway after a while if nothing happens).
 * After connecting, the central sends a hello frame [0xFF][node id] so the peripheral knows who
 * it is. Mesh frames always start with 0x00 or 0x01, so they never clash with the hello.
 *
 * All state is touched on the main thread only. Public methods must be called on it, and
 * Bluetooth callbacks are posted to it.
 */
@SuppressLint("MissingPermission") // The plugin checks permissions before calling start().
public class BleMeshEngine {

    public interface Listener {
        void onLinkUp(String linkId, int maxFrameBytes, String role);
        void onLinkDown(String linkId);
        void onData(String linkId, byte[] data);
        void onStateChanged();
    }

    public static final UUID DEFAULT_SERVICE_UUID = UUID.fromString("f47b5e2d-4a9e-4c5b-9e1a-3b2c8d7e6f01");
    public static final UUID DEFAULT_CHARACTERISTIC_UUID = UUID.fromString("f47b5e2d-4a9e-4c5b-9e1a-3b2c8d7e6f02");
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private static final String TAG = "BleMesh";
    private static final byte HELLO = (byte) 0xFF;
    private static final int NODE_ID_BYTES = 8;
    private static final int MAX_QUEUE = 512;
    private static final int MAX_SEND_RETRIES = 50;
    private static final int REQUESTED_MTU = 517;
    private static final int MAX_ATTRIBUTE_BYTES = 512;
    private static final long WRITE_TIMEOUT_MS = 2_000;
    private static final long CONNECT_TIMEOUT_MS = 12_000;
    private static final long RETRY_COOLDOWN_MS = 10_000;
    private static final long FALLBACK_CONNECT_MS = 15_000;
    private static final long SCAN_RESTART_MS = 20 * 60_000;

    private static final class Link {
        final String id;
        final String role; // "central" (we connected) or "peripheral" (they connected to us)
        final String address;
        BluetoothDevice device;
        BluetoothGatt gatt;
        BluetoothGattCharacteristic characteristic;
        byte[] nodeId;
        int mtu = 23;
        boolean up;
        boolean busy;
        int retries;
        final ArrayDeque<byte[]> queue = new ArrayDeque<>();
        Runnable writeTimeout;
        Runnable connectTimeout;

        Link(String id, String role, String address) {
            this.id = id;
            this.role = role;
            this.address = address;
        }

        int maxFrameBytes() {
            return Math.max(20, Math.min(mtu - 3, MAX_ATTRIBUTE_BYTES));
        }
    }

    private final Context context;
    private final Listener listener;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, Link> links = new HashMap<>();
    private final Map<String, Long> cooldownUntil = new HashMap<>();
    private final Map<String, Long> firstSeen = new HashMap<>();

    private UUID serviceUuid = DEFAULT_SERVICE_UUID;
    private UUID characteristicUuid = DEFAULT_CHARACTERISTIC_UUID;
    private int maxLinks = 7;
    private byte[] nodeId = new byte[NODE_ID_BYTES];

    private BluetoothManager manager;
    private BluetoothAdapter adapter;
    private BluetoothGattServer server;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothLeScanner scanner;
    private boolean running;
    private boolean receiverRegistered;
    private boolean advertising;
    private boolean scanning;
    private String pendingAddress;
    private String lastError;

    public BleMeshEngine(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    /* ---------------- lifecycle ---------------- */

    /** Starts the mesh radio. Returns null on success, or an error code. */
    public String start(UUID service, UUID characteristic, int maxLinks) {
        if (running) return null;
        manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null || !context.getPackageManager().hasSystemFeature("android.hardware.bluetooth_le")) {
            return "UNSUPPORTED";
        }
        if (!adapter.isEnabled()) return "BLUETOOTH_OFF";

        this.serviceUuid = service;
        this.characteristicUuid = characteristic;
        this.maxLinks = Math.max(1, maxLinks);
        new SecureRandom().nextBytes(nodeId);
        running = true;
        lastError = null;
        registerStateReceiver();
        startRadio();
        return null;
    }

    public void stop() {
        if (!running) return;
        running = false;
        stopRadio();
        unregisterStateReceiver();
        cooldownUntil.clear();
        firstSeen.clear();
        listener.onStateChanged();
    }

    public boolean isRunning() {
        return running;
    }

    private void startRadio() {
        advertiser = adapter.getBluetoothLeAdvertiser();
        scanner = adapter.getBluetoothLeScanner();
        openServer(); // advertising starts once the service is registered
        startScan();
        handler.postDelayed(scanRestart, SCAN_RESTART_MS);
        listener.onStateChanged();
    }

    private void stopRadio() {
        handler.removeCallbacks(scanRestart);
        stopScan();
        stopAdvertising();
        for (Link link : new ArrayList<>(links.values())) removeLink(link);
        pendingAddress = null;
        if (server != null) {
            try {
                server.close();
            } catch (Exception ignored) {
            }
            server = null;
        }
    }

    /** Android quietly weakens scans that run for a long time; restart ours now and then. */
    private final Runnable scanRestart = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            stopScan();
            startScan();
            handler.postDelayed(this, SCAN_RESTART_MS);
        }
    };

    /* ---------------- state ---------------- */

    public boolean isBluetoothOn() {
        return adapter != null && adapter.isEnabled();
    }

    public boolean isAdvertising() {
        return advertising;
    }

    public boolean isScanning() {
        return scanning;
    }

    public String getLastError() {
        return lastError;
    }

    public List<Map<String, Object>> describeLinks() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Link l : links.values()) {
            if (!l.up) continue;
            Map<String, Object> m = new HashMap<>();
            m.put("linkId", l.id);
            m.put("role", l.role);
            m.put("maxFrameBytes", l.maxFrameBytes());
            out.add(m);
        }
        return out;
    }

    private int upLinkCount() {
        int n = 0;
        for (Link l : links.values()) if (l.up) n++;
        return n;
    }

    private void setError(String message) {
        lastError = message;
        Log.w(TAG, message);
        listener.onStateChanged();
    }

    /* ---------------- Bluetooth on/off ---------------- */

    private final BroadcastReceiver stateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent intent) {
            int state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR);
            handler.post(() -> {
                if (!running) return;
                if (state == BluetoothAdapter.STATE_TURNING_OFF || state == BluetoothAdapter.STATE_OFF) {
                    stopRadio();
                    advertising = false;
                    scanning = false;
                    listener.onStateChanged();
                } else if (state == BluetoothAdapter.STATE_ON) {
                    lastError = null;
                    startRadio();
                }
            });
        }
    };

    private void registerStateReceiver() {
        if (receiverRegistered) return;
        IntentFilter filter = new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(stateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            context.registerReceiver(stateReceiver, filter);
        }
        receiverRegistered = true;
    }

    private void unregisterStateReceiver() {
        if (!receiverRegistered) return;
        try {
            context.unregisterReceiver(stateReceiver);
        } catch (Exception ignored) {
        }
        receiverRegistered = false;
    }

    /* ---------------- peripheral role: GATT server + advertising ---------------- */

    private void openServer() {
        server = manager.openGattServer(context, serverCallback);
        if (server == null) {
            setError("Couldn't open the Bluetooth GATT server. Other phones can't connect to this one.");
            return;
        }
        BluetoothGattService service = new BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        BluetoothGattCharacteristic ch = new BluetoothGattCharacteristic(
            characteristicUuid,
            BluetoothGattCharacteristic.PROPERTY_WRITE
                | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE
                | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_WRITE
        );
        ch.addDescriptor(new BluetoothGattDescriptor(
            CCCD_UUID,
            BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE
        ));
        service.addCharacteristic(ch);
        if (!server.addService(service)) setError("Couldn't register the mesh Bluetooth service.");
    }

    private BluetoothGattCharacteristic serverCharacteristic() {
        if (server == null) return null;
        BluetoothGattService s = server.getService(serviceUuid);
        return s == null ? null : s.getCharacteristic(characteristicUuid);
    }

    private void startAdvertising() {
        if (advertiser == null || !adapter.isMultipleAdvertisementSupported()) {
            setError("This phone can't advertise over Bluetooth. It can still connect to other phones.");
            return;
        }
        ParcelUuid uuid = new ParcelUuid(serviceUuid);
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .setTimeout(0)
            .build();
        AdvertiseData data = new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(uuid)
            .build();
        AdvertiseData scanResponse = new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceData(uuid, nodeId)
            .build();
        try {
            advertiser.startAdvertising(settings, data, scanResponse, advertiseCallback);
        } catch (Exception e) {
            setError("Couldn't start Bluetooth advertising: " + e.getMessage());
        }
    }

    private void stopAdvertising() {
        if (advertiser != null && advertising) {
            try {
                advertiser.stopAdvertising(advertiseCallback);
            } catch (Exception ignored) {
            }
        }
        advertising = false;
    }

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            handler.post(() -> {
                advertising = true;
                listener.onStateChanged();
            });
        }

        @Override
        public void onStartFailure(int errorCode) {
            handler.post(() -> {
                advertising = false;
                setError("Bluetooth advertising failed (code " + errorCode + "). Other phones may not find this one.");
            });
        }
    };

    private final BluetoothGattServerCallback serverCallback = new BluetoothGattServerCallback() {
        @Override
        public void onServiceAdded(int status, BluetoothGattService service) {
            handler.post(() -> {
                if (!running) return;
                if (status == BluetoothGatt.GATT_SUCCESS) startAdvertising();
                else setError("Couldn't register the mesh Bluetooth service (status " + status + ").");
            });
        }

        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            String address = device.getAddress();
            handler.post(() -> {
                String id = "p:" + address;
                if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    Link link = links.get(id);
                    if (link != null) removeLink(link);
                } else if (newState == BluetoothProfile.STATE_CONNECTED && !links.containsKey(id)) {
                    // Android also reports our own outgoing connections here, so this link only
                    // goes "up" once the other phone subscribes to notifications.
                    Link link = new Link(id, "peripheral", address);
                    link.device = device;
                    links.put(id, link);
                }
            });
        }

        @Override
        public void onMtuChanged(BluetoothDevice device, int mtu) {
            String address = device.getAddress();
            handler.post(() -> {
                Link link = peripheralLink(device, address);
                link.mtu = mtu;
            });
        }

        @Override
        public void onDescriptorReadRequest(BluetoothDevice device, int requestId, int offset, BluetoothGattDescriptor descriptor) {
            Link link = links.get("p:" + device.getAddress());
            byte[] value = link != null && link.up
                ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE;
            respond(device, requestId, value);
        }

        @Override
        public void onDescriptorWriteRequest(BluetoothDevice device, int requestId, BluetoothGattDescriptor descriptor,
                                             boolean preparedWrite, boolean responseNeeded, int offset, byte[] value) {
            if (responseNeeded) respond(device, requestId, null);
            if (!CCCD_UUID.equals(descriptor.getUuid())) return;
            String address = device.getAddress();
            boolean enable = value != null && value.length > 0 && value[0] != 0;
            handler.post(() -> {
                Link link = peripheralLink(device, address);
                if (!enable) {
                    removeLink(link);
                    return;
                }
                if (link.up) return;
                if (upLinkCount() >= maxLinks) {
                    // Too many links already: drop this one so the other phone looks elsewhere.
                    try {
                        server.cancelConnection(device);
                    } catch (Exception ignored) {
                    }
                    return;
                }
                link.up = true;
                listener.onLinkUp(link.id, link.maxFrameBytes(), link.role);
                listener.onStateChanged();
            });
        }

        @Override
        public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId, BluetoothGattCharacteristic characteristic,
                                                 boolean preparedWrite, boolean responseNeeded, int offset, byte[] value) {
            if (responseNeeded) respond(device, requestId, null);
            if (value == null || value.length == 0) return;
            String address = device.getAddress();
            byte[] copy = Arrays.copyOf(value, value.length);
            handler.post(() -> {
                Link link = links.get("p:" + address);
                if (link == null || !link.up) return;
                if (copy[0] == HELLO && copy.length == 1 + NODE_ID_BYTES) {
                    link.nodeId = Arrays.copyOfRange(copy, 1, copy.length);
                    return;
                }
                listener.onData(link.id, copy);
            });
        }

        @Override
        public void onNotificationSent(BluetoothDevice device, int status) {
            String address = device.getAddress();
            handler.post(() -> {
                Link link = links.get("p:" + address);
                if (link != null) writeDone(link);
            });
        }
    };

    private Link peripheralLink(BluetoothDevice device, String address) {
        String id = "p:" + address;
        Link link = links.get(id);
        if (link == null) {
            link = new Link(id, "peripheral", address);
            link.device = device;
            links.put(id, link);
        }
        return link;
    }

    private void respond(BluetoothDevice device, int requestId, byte[] value) {
        try {
            if (server != null) server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, value);
        } catch (Exception ignored) {
        }
    }

    /* ---------------- central role: scanning + connecting ---------------- */

    private void startScan() {
        if (scanner == null) {
            setError("Bluetooth scanning isn't available on this phone.");
            return;
        }
        List<ScanFilter> filters = Collections.singletonList(
            new ScanFilter.Builder().setServiceUuid(new ParcelUuid(serviceUuid)).build()
        );
        ScanSettings settings = new ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build();
        try {
            scanner.startScan(filters, settings, scanCallback);
            scanning = true;
        } catch (Exception e) {
            scanning = false;
            setError("Couldn't start Bluetooth scanning: " + e.getMessage());
        }
    }

    private void stopScan() {
        if (scanner != null && scanning) {
            try {
                scanner.stopScan(scanCallback);
            } catch (Exception ignored) {
            }
        }
        scanning = false;
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            handler.post(() -> onFound(result));
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            handler.post(() -> {
                for (ScanResult r : results) onFound(r);
            });
        }

        @Override
        public void onScanFailed(int errorCode) {
            handler.post(() -> {
                scanning = false;
                setError("Bluetooth scanning failed (code " + errorCode + ").");
            });
        }
    };

    private void onFound(ScanResult result) {
        if (!running || pendingAddress != null) return;
        BluetoothDevice device = result.getDevice();
        String address = device.getAddress();
        if (links.containsKey("c:" + address)) return;
        if (upLinkCount() >= maxLinks) return;

        long now = SystemClock.elapsedRealtime();
        Long cooldown = cooldownUntil.get(address);
        if (cooldown != null && cooldown > now) return;

        byte[] peerId = peerNodeId(result.getScanRecord());
        if (peerId != null && peerId.length == NODE_ID_BYTES) {
            if (Arrays.equals(peerId, nodeId)) return;
            if (isLinkedTo(peerId)) return; // they already connected to us
            if (compare(nodeId, peerId) > 0) {
                // The other phone has the lower id and should connect to us. Connect anyway if
                // it still hasn't after a while (it may not be able to see us).
                Long first = firstSeen.get(address);
                if (first == null) {
                    firstSeen.put(address, now);
                    return;
                }
                if (now - first < FALLBACK_CONNECT_MS) return;
            }
        }
        connect(device, peerId);
    }

    /**
     * Reads a phone's node id: service data (Android) or an "M" + hex local name (iPhones can't
     * advertise service data, so they put the id in the name instead).
     */
    private byte[] peerNodeId(ScanRecord record) {
        if (record == null) return null;
        byte[] id = record.getServiceData(new ParcelUuid(serviceUuid));
        if (id != null && id.length == NODE_ID_BYTES) return id;
        String name = record.getDeviceName();
        if (name == null || name.length() != 1 + NODE_ID_BYTES * 2 || name.charAt(0) != 'M') return null;
        byte[] out = new byte[NODE_ID_BYTES];
        for (int i = 0; i < NODE_ID_BYTES; i++) {
            int hi = Character.digit(name.charAt(1 + i * 2), 16);
            int lo = Character.digit(name.charAt(2 + i * 2), 16);
            if (hi < 0 || lo < 0) return null;
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    private boolean isLinkedTo(byte[] peerId) {
        for (Link l : links.values()) if (l.up && l.nodeId != null && Arrays.equals(l.nodeId, peerId)) return true;
        return false;
    }

    private static int compare(byte[] a, byte[] b) {
        for (int i = 0; i < Math.min(a.length, b.length); i++) {
            int x = a[i] & 0xff;
            int y = b[i] & 0xff;
            if (x != y) return x < y ? -1 : 1;
        }
        return a.length - b.length;
    }

    private void connect(BluetoothDevice device, byte[] peerId) {
        String address = device.getAddress();
        Link link = new Link("c:" + address, "central", address);
        link.device = device;
        link.nodeId = peerId;
        links.put(link.id, link);
        pendingAddress = address;
        firstSeen.remove(address);

        BluetoothGatt gatt = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            : device.connectGatt(context, false, gattCallback);
        if (gatt == null) {
            failLink(link);
            return;
        }
        link.gatt = gatt;
        link.connectTimeout = () -> {
            if (!link.up) failLink(link);
        };
        handler.postDelayed(link.connectTimeout, CONNECT_TIMEOUT_MS);
    }

    private Link centralLink(BluetoothGatt gatt) {
        Link link = links.get("c:" + gatt.getDevice().getAddress());
        return link != null && link.gatt == gatt ? link : null;
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            handler.post(() -> {
                Link link = centralLink(gatt);
                if (link == null) {
                    gatt.close();
                    return;
                }
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    if (!gatt.requestMtu(REQUESTED_MTU)) gatt.discoverServices();
                } else {
                    failLink(link);
                }
            });
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            handler.post(() -> {
                Link link = centralLink(gatt);
                if (link == null) return;
                if (status == BluetoothGatt.GATT_SUCCESS) link.mtu = mtu;
                if (!gatt.discoverServices()) failLink(link);
            });
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            handler.post(() -> {
                Link link = centralLink(gatt);
                if (link == null) return;
                BluetoothGattService service = gatt.getService(serviceUuid);
                BluetoothGattCharacteristic ch = service == null ? null : service.getCharacteristic(characteristicUuid);
                BluetoothGattDescriptor cccd = ch == null ? null : ch.getDescriptor(CCCD_UUID);
                if (status != BluetoothGatt.GATT_SUCCESS || cccd == null) {
                    failLink(link);
                    return;
                }
                link.characteristic = ch;
                gatt.setCharacteristicNotification(ch, true);
                boolean ok;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    ok = gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS;
                } else {
                    cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    ok = gatt.writeDescriptor(cccd);
                }
                if (!ok) failLink(link);
            });
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            handler.post(() -> {
                Link link = centralLink(gatt);
                if (link == null || link.up) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    failLink(link);
                    return;
                }
                handler.removeCallbacks(link.connectTimeout);
                if (link.address.equals(pendingAddress)) pendingAddress = null;
                if (upLinkCount() >= maxLinks) {
                    removeLink(link);
                    return;
                }
                link.up = true;
                byte[] hello = new byte[1 + NODE_ID_BYTES];
                hello[0] = HELLO;
                System.arraycopy(nodeId, 0, hello, 1, NODE_ID_BYTES);
                link.queue.addFirst(hello);
                listener.onLinkUp(link.id, link.maxFrameBytes(), link.role);
                listener.onStateChanged();
                pump(link);
            });
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            handler.post(() -> {
                Link link = centralLink(gatt);
                if (link != null) writeDone(link);
            });
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            received(gatt, value);
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            // Android 12 and older call this one; Android 13+ calls the one above.
            received(gatt, characteristic.getValue());
        }

        private void received(BluetoothGatt gatt, byte[] value) {
            if (value == null || value.length == 0) return;
            byte[] copy = Arrays.copyOf(value, value.length);
            handler.post(() -> {
                Link link = centralLink(gatt);
                if (link != null && link.up) listener.onData(link.id, copy);
            });
        }
    };

    /** A connection attempt that failed: drop it and wait a bit before trying that phone again. */
    private void failLink(Link link) {
        if (!link.up) cooldownUntil.put(link.address, SystemClock.elapsedRealtime() + RETRY_COOLDOWN_MS);
        removeLink(link);
    }

    private void removeLink(Link link) {
        if (links.get(link.id) != link) return;
        links.remove(link.id);
        if (link.writeTimeout != null) handler.removeCallbacks(link.writeTimeout);
        if (link.connectTimeout != null) handler.removeCallbacks(link.connectTimeout);
        if (link.address.equals(pendingAddress) && "central".equals(link.role)) pendingAddress = null;
        if (link.gatt != null) {
            try {
                link.gatt.disconnect();
                link.gatt.close();
            } catch (Exception ignored) {
            }
        }
        link.queue.clear();
        if (link.up) {
            link.up = false;
            listener.onLinkDown(link.id);
            listener.onStateChanged();
        }
    }

    /* ---------------- sending ---------------- */

    /** Queues a frame for a link. Returns false if the link is gone or its queue is full. */
    public boolean send(String linkId, byte[] frame) {
        Link link = links.get(linkId);
        if (link == null || !link.up || frame.length == 0 || frame.length > link.maxFrameBytes()) return false;
        if (link.queue.size() >= MAX_QUEUE) return false;
        link.queue.add(frame);
        pump(link);
        return true;
    }

    /** BLE allows one write in flight per link, so frames go out one at a time. */
    private void pump(Link link) {
        if (link.busy || link.queue.isEmpty() || links.get(link.id) != link) return;
        byte[] next = link.queue.poll();
        boolean ok = "central".equals(link.role) ? writeAsCentral(link, next) : notifyAsPeripheral(link, next);
        if (!ok) {
            // The stack is busy (e.g. another operation in progress); try again shortly.
            if (++link.retries > MAX_SEND_RETRIES) {
                link.retries = 0;
                pump(link);
                return;
            }
            link.queue.addFirst(next);
            handler.postDelayed(() -> pump(link), 20);
            return;
        }
        link.retries = 0;
        link.busy = true;
        link.writeTimeout = () -> writeDone(link);
        handler.postDelayed(link.writeTimeout, WRITE_TIMEOUT_MS);
    }

    private void writeDone(Link link) {
        if (link.writeTimeout != null) handler.removeCallbacks(link.writeTimeout);
        link.writeTimeout = null;
        link.busy = false;
        pump(link);
    }

    @SuppressWarnings("deprecation")
    private boolean writeAsCentral(Link link, byte[] value) {
        if (link.gatt == null || link.characteristic == null) return false;
        int type = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return link.gatt.writeCharacteristic(link.characteristic, value, type) == BluetoothStatusCodes.SUCCESS;
            }
            link.characteristic.setWriteType(type);
            link.characteristic.setValue(value);
            return link.gatt.writeCharacteristic(link.characteristic);
        } catch (Exception e) {
            return false;
        }
    }

    @SuppressWarnings("deprecation")
    private boolean notifyAsPeripheral(Link link, byte[] value) {
        BluetoothGattCharacteristic ch = serverCharacteristic();
        if (server == null || ch == null || link.device == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return server.notifyCharacteristicChanged(link.device, ch, false, value) == BluetoothStatusCodes.SUCCESS;
            }
            ch.setValue(value);
            return server.notifyCharacteristicChanged(link.device, ch, false);
        } catch (Exception e) {
            return false;
        }
    }
}
