//go:build !windows

package main

import "errors"

// macOS Keychain / Linux secret-service sealing isn't wired up yet, so the web side keeps
// mesh secrets unsealed there (as older phone builds do).
const storageKeySupported = false

func loadStorageKey(string) ([]byte, error) {
	return nil, errors.New("not supported")
}

func openBluetoothSettings() {}
