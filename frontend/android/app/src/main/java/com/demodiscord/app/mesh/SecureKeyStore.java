package com.demodiscord.app.mesh;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The offline mesh's storage key (docs/10 C7). A random 32-byte key the web side uses to seal
 * the keys it keeps in IndexedDB and localStorage. The key itself is stored wrapped by an AES key
 * that lives in the Android Keystore and never leaves it, so copying the app's files isn't
 * enough to read the mesh keys. Deleting it (panic wipe) makes everything sealed with it
 * unreadable at once.
 */
final class SecureKeyStore {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "mesh-storage-wrap";
    private static final String PREFS = "mesh_secure";
    private static final String ENTRY = "storage_key";
    private static final int IV_BYTES = 12;

    private SecureKeyStore() {}

    /** Returns the storage key, making one the first time. */
    static synchronized byte[] getOrCreate(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SecretKey wrap = wrappingKey();
        String stored = prefs.getString(ENTRY, null);
        if (stored != null) {
            byte[] blob = Base64.decode(stored, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, wrap, new GCMParameterSpec(128, blob, 0, IV_BYTES));
            return cipher.doFinal(blob, IV_BYTES, blob.length - IV_BYTES);
        }
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, wrap);
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(key);
        byte[] blob = new byte[iv.length + sealed.length];
        System.arraycopy(iv, 0, blob, 0, iv.length);
        System.arraycopy(sealed, 0, blob, iv.length, sealed.length);
        prefs.edit().putString(ENTRY, Base64.encodeToString(blob, Base64.NO_WRAP)).apply();
        return key;
    }

    /** Forgets the storage key and its wrapping key (panic wipe). */
    static synchronized void delete(Context context) throws Exception {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(ENTRY).apply();
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
    }

    private static SecretKey wrappingKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(
            new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }
}
