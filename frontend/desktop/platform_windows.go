package main

import (
	"crypto/rand"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

const storageKeySupported = true

// loadStorageKey reads the key sealed with DPAPI (only this Windows user can unseal it), or
// creates and saves a new one.
func loadStorageKey(path string) ([]byte, error) {
	if sealed, err := os.ReadFile(path); err == nil {
		key, err := unprotect(sealed)
		if err == nil && len(key) == 32 {
			return key, nil
		}
		// Unreadable (e.g. copied from another user): make a new one. Sealed data from the old
		// key can't be read anyway.
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	sealed, err := protect(key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, sealed, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

func protect(data []byte) ([]byte, error) {
	in := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	return takeBlob(out), nil
}

func unprotect(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty")
	}
	in := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	return takeBlob(out), nil
}

func takeBlob(b windows.DataBlob) []byte {
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(b.Data)))
	return append([]byte(nil), unsafe.Slice(b.Data, b.Size)...)
}

func openBluetoothSettings() {
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", "ms-settings:bluetooth").Start()
}
