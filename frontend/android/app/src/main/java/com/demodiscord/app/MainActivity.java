package com.demodiscord.app;

import android.os.Bundle;

import com.demodiscord.app.mesh.BleMeshPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge starts.
        registerPlugin(BleMeshPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
