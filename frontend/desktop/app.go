package main

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is bound to the web page as window.go.main.App. Its methods mirror the phone apps'
// BleMesh plugin (frontend/lib/mesh/transports/BleLinkTransport.ts), so the web mesh code
// runs unchanged. Events go out as "blemesh:<name>".
type App struct {
	ctx  context.Context
	mesh *Mesh
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.mesh = NewMesh(func(event string, data any) {
		runtime.EventsEmit(a.ctx, "blemesh:"+event, data)
	})
}

func (a *App) shutdown(context.Context) {
	if a.mesh != nil {
		a.mesh.Stop()
	}
}

// userDataPath is where the web view keeps localStorage and IndexedDB.
func userDataPath() string {
	return filepath.Join(appDir(), "webview")
}

func appDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "DemoDiscord")
}

/* ---------------- BleMesh plugin methods ---------------- */

type StartOptions struct {
	ServiceUUID        string `json:"serviceUuid"`
	CharacteristicUUID string `json:"characteristicUuid"`
	MaxLinks           int    `json:"maxLinks"`
}

type Granted struct {
	Granted bool `json:"granted"`
}

// EnsurePermissions: desktops have no Bluetooth permission prompt for apps.
func (a *App) EnsurePermissions() Granted {
	return Granted{Granted: true}
}

func (a *App) Start(opts StartOptions) error {
	return a.mesh.Start(opts)
}

func (a *App) Stop() error {
	a.mesh.Stop()
	return nil
}

type SendResult struct {
	Queued bool `json:"queued"`
}

func (a *App) Send(linkID string, data string) (SendResult, error) {
	frame, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return SendResult{}, errors.New("bad frame")
	}
	return SendResult{Queued: a.mesh.Send(linkID, frame)}, nil
}

func (a *App) GetState() MeshState {
	return a.mesh.State()
}

// EnableBluetooth: an app can't turn the radio on here; open Windows' Bluetooth settings instead.
func (a *App) EnableBluetooth() error {
	openBluetoothSettings()
	return nil
}

type Capabilities struct {
	Power      bool `json:"power"`
	Battery    bool `json:"battery"`
	StorageKey bool `json:"storageKey"`
}

func (a *App) GetCapabilities() Capabilities {
	return Capabilities{StorageKey: storageKeySupported}
}

type PowerOptions struct {
	Mode     string `json:"mode"`
	MaxLinks int    `json:"maxLinks"`
}

// SetPowerMode is accepted but ignored: desktops are usually plugged in, so the radio always
// works at full speed. (GetCapabilities says power=false, so the web side doesn't call it.)
func (a *App) SetPowerMode(PowerOptions) error {
	return nil
}

type StorageKey struct {
	Key string `json:"key"`
}

// GetStorageKey returns the 32-byte key that seals mesh secrets at rest, protected by the
// operating system's user key store (DPAPI on Windows). Created on first use.
func (a *App) GetStorageKey() (StorageKey, error) {
	key, err := loadStorageKey(filepath.Join(appDir(), "storage.key"))
	if err != nil {
		return StorageKey{}, err
	}
	return StorageKey{Key: base64.StdEncoding.EncodeToString(key)}, nil
}

func (a *App) DeleteStorageKey() error {
	err := os.Remove(filepath.Join(appDir(), "storage.key"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
