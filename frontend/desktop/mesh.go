package main

// Bluetooth link layer for the offline mesh on desktop. It speaks the same GATT protocol as
// the phone apps (android/.../mesh/BleMeshEngine.java):
//
//   - Phones advertise service f47b…6f01 with one characteristic f47b…6f02 (write + notify),
//     and put an 8-byte node id in the scan response (iPhones: local name "M" + hex id).
//   - The connecting side (central) enables notifications, then writes a hello
//     [0xFF][8-byte node id]. After that, frames go both ways: central → writes,
//     peripheral → notifications.
//
// The desktop is central only: it scans for phones and connects to them. Windows can't
// advertise a service with its own GATT server reliably, so phones can't connect to a
// desktop, and two desktops can't link over Bluetooth directly (they reach each other
// through a phone, or the internet bridge). Phones always accept connections, so
// desktop ↔ phone works whatever the node ids are.
//
// All mesh logic (routing, dedup, signatures) stays in the web code, as on the phones.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"tinygo.org/x/bluetooth"
)

const (
	defaultServiceUUID        = "f47b5e2d-4a9e-4c5b-9e1a-3b2c8d7e6f01"
	defaultCharacteristicUUID = "f47b5e2d-4a9e-4c5b-9e1a-3b2c8d7e6f02"

	helloByte        = 0xFF
	nodeIDBytes      = 8
	maxQueue         = 512
	maxAttributeSize = 512
	connectTimeout   = 12 * time.Second
	attemptTimeout   = 25 * time.Second
	retryCooldown    = 10 * time.Second
	scanRetryDelay   = 3 * time.Second
)

type LinkInfo struct {
	LinkID        string `json:"linkId"`
	Role          string `json:"role"`
	MaxFrameBytes int    `json:"maxFrameBytes"`
}

// MeshState matches BleMeshState in BleLinkTransport.ts.
type MeshState struct {
	Running     bool       `json:"running"`
	BluetoothOn bool       `json:"bluetoothOn"`
	Advertising bool       `json:"advertising"`
	Scanning    bool       `json:"scanning"`
	Error       string     `json:"error,omitempty"`
	Links       []LinkInfo `json:"links"`
	PowerMode   string     `json:"powerMode"`
}

type link struct {
	id       string
	addr     bluetooth.Address
	nodeID   []byte
	device   bluetooth.Device
	ch       bluetooth.DeviceCharacteristic
	maxFrame int
	queue    chan []byte
	done     chan struct{}
}

// attempt is one connection in progress. A stuck attempt is abandoned after attemptTimeout so
// scanning can move on; if it finishes later, its connection is closed.
type attempt struct {
	addr      string
	abandoned bool
}

type Mesh struct {
	emit    func(event string, data any)
	adapter *bluetooth.Adapter

	mu          sync.Mutex
	enabled     bool
	running     bool
	stopCh      chan struct{}
	serviceUUID bluetooth.UUID
	charUUID    bluetooth.UUID
	maxLinks    int
	nodeID      []byte
	links       map[string]*link
	cooldown    map[string]time.Time
	pending     *attempt
	bluetoothOn bool
	scanning    bool
	lastError   string
}

func NewMesh(emit func(event string, data any)) *Mesh {
	return &Mesh{
		emit:     emit,
		adapter:  bluetooth.DefaultAdapter,
		links:    map[string]*link{},
		cooldown: map[string]time.Time{},
	}
}

/* ---------------- lifecycle ---------------- */

func (m *Mesh) Start(opts StartOptions) error {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return nil
	}
	svc, err := parseUUID(opts.ServiceUUID, defaultServiceUUID)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	chr, err := parseUUID(opts.CharacteristicUUID, defaultCharacteristicUUID)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	if !m.enabled {
		// Initializes WinRT. It reports an error if this thread was already set up (the web
		// view does that), which is fine; real Bluetooth problems show up when scanning.
		_ = m.adapter.Enable()
		m.adapter.SetConnectionStateHandler(m.onConnectionState)
		m.enabled = true
	}
	m.serviceUUID, m.charUUID = svc, chr
	m.maxLinks = opts.MaxLinks
	if m.maxLinks <= 0 {
		m.maxLinks = 7
	}
	m.nodeID = make([]byte, nodeIDBytes)
	_, _ = rand.Read(m.nodeID)
	m.running = true
	m.bluetoothOn = true
	m.lastError = ""
	m.stopCh = make(chan struct{})
	stop := m.stopCh
	m.mu.Unlock()

	go m.scanLoop(stop)
	m.emitState()
	return nil
}

func (m *Mesh) Stop() {
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return
	}
	m.running = false
	close(m.stopCh)
	if m.pending != nil {
		m.pending.abandoned = true
		m.pending = nil
	}
	links := make([]*link, 0, len(m.links))
	for _, l := range m.links {
		links = append(links, l)
	}
	m.links = map[string]*link{}
	m.cooldown = map[string]time.Time{}
	m.mu.Unlock()

	_ = m.adapter.StopScan()
	for _, l := range links {
		close(l.done)
		_ = l.device.Disconnect()
		m.emit("linkDown", map[string]string{"linkId": l.id})
	}
	m.emitState()
}

func (m *Mesh) State() MeshState {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := MeshState{
		Running:     m.running,
		BluetoothOn: m.bluetoothOn,
		Scanning:    m.scanning,
		Error:       m.lastError,
		Links:       []LinkInfo{},
		PowerMode:   "foreground",
	}
	for _, l := range m.links {
		s.Links = append(s.Links, LinkInfo{LinkID: l.id, Role: "central", MaxFrameBytes: l.maxFrame})
	}
	return s
}

func (m *Mesh) emitState() {
	m.emit("state", m.State())
}

/* ---------------- scanning ---------------- */

// scanLoop keeps a scan running. Scan blocks until StopScan or an error; an error usually
// means Bluetooth is off or missing, so it says so and tries again every few seconds.
func (m *Mesh) scanLoop(stop chan struct{}) {
	for {
		m.setScanning(true, "")
		err := m.adapter.Scan(m.onScan)
		select {
		case <-stop:
			m.setScanning(false, "")
			return
		default:
		}
		if err != nil {
			log.Printf("blemesh: scan stopped: %v", err)
			m.mu.Lock()
			m.bluetoothOn = false
			m.mu.Unlock()
		}
		m.setScanning(false, "")
		select {
		case <-stop:
			return
		case <-time.After(scanRetryDelay):
		}
	}
}

func (m *Mesh) setScanning(on bool, errText string) {
	m.mu.Lock()
	changed := m.scanning != on || m.lastError != errText
	m.scanning = on
	m.lastError = errText
	m.mu.Unlock()
	if changed {
		m.emitState()
	}
}

func (m *Mesh) onScan(_ *bluetooth.Adapter, result bluetooth.ScanResult) {
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return
	}
	wasOff := !m.bluetoothOn
	m.bluetoothOn = true
	if !result.HasServiceUUID(m.serviceUUID) {
		m.mu.Unlock()
		if wasOff {
			m.emitState()
		}
		return
	}
	addr := result.Address.String()
	id := "c:" + addr
	skip := m.pending != nil || m.links[id] != nil || len(m.links) >= m.maxLinks
	if until, ok := m.cooldown[addr]; ok && time.Now().Before(until) {
		skip = true
	}
	peerID := m.peerNodeID(result)
	if peerID != nil && (string(peerID) == string(m.nodeID) || m.isLinkedTo(peerID)) {
		skip = true
	}
	var a *attempt
	if !skip {
		a = &attempt{addr: addr}
		m.pending = a
	}
	m.mu.Unlock()

	if wasOff {
		m.emitState()
	}
	if a != nil {
		go m.connect(a, result.Address, peerID)
	}
}

// peerNodeID reads a phone's node id: service data (Android) or an "M" + hex local name (iOS).
func (m *Mesh) peerNodeID(result bluetooth.ScanResult) []byte {
	for _, sd := range result.ServiceData() {
		if sd.UUID == m.serviceUUID && len(sd.Data) == nodeIDBytes {
			return append([]byte(nil), sd.Data...)
		}
	}
	name := result.LocalName()
	if len(name) == 1+nodeIDBytes*2 && name[0] == 'M' {
		if id, err := hex.DecodeString(name[1:]); err == nil {
			return id
		}
	}
	return nil
}

func (m *Mesh) isLinkedTo(peerID []byte) bool {
	for _, l := range m.links {
		if l.nodeID != nil && string(l.nodeID) == string(peerID) {
			return true
		}
	}
	return false
}

/* ---------------- connecting ---------------- */

func (m *Mesh) connect(a *attempt, addr bluetooth.Address, peerID []byte) {
	watchdog := time.AfterFunc(attemptTimeout, func() { m.finishAttempt(a, true) })
	defer watchdog.Stop()

	device, err := m.adapter.Connect(addr, bluetooth.ConnectionParams{
		ConnectionTimeout: bluetooth.NewDuration(connectTimeout),
		Priority:          bluetooth.ConnectionPriorityThroughput,
	})
	if err != nil {
		log.Printf("blemesh: connect %s: %v", a.addr, err)
		m.finishAttempt(a, true)
		return
	}
	ch, err := m.findCharacteristic(device)
	if err != nil {
		log.Printf("blemesh: %s: %v", a.addr, err)
		_ = device.Disconnect()
		m.finishAttempt(a, true)
		return
	}
	maxFrame := 20
	if mtu, err := ch.GetMTU(); err == nil && int(mtu)-3 > maxFrame {
		maxFrame = min(int(mtu)-3, maxAttributeSize)
	}

	l := &link{
		id:       "c:" + a.addr,
		addr:     addr,
		nodeID:   peerID,
		device:   device,
		ch:       ch,
		maxFrame: maxFrame,
		queue:    make(chan []byte, maxQueue),
		done:     make(chan struct{}),
	}

	m.mu.Lock()
	if a.abandoned || !m.running || len(m.links) >= m.maxLinks {
		if m.pending == a {
			m.pending = nil
		}
		m.mu.Unlock()
		_ = device.Disconnect()
		return
	}
	m.pending = nil
	m.links[l.id] = l
	m.mu.Unlock()

	// linkUp before any data, as the web side expects.
	m.emit("linkUp", map[string]any{"linkId": l.id, "maxFrameBytes": l.maxFrame, "role": "central"})
	m.emitState()

	err = ch.EnableNotifications(func(buf []byte) {
		if len(buf) == 0 {
			return
		}
		m.mu.Lock()
		up := m.links[l.id] == l
		m.mu.Unlock()
		if up {
			m.emit("data", map[string]string{"linkId": l.id, "data": base64.StdEncoding.EncodeToString(buf)})
		}
	})
	if err != nil {
		log.Printf("blemesh: %s: notifications: %v", a.addr, err)
		m.cooldownAddr(a.addr)
		m.dropLink(l)
		return
	}

	hello := append([]byte{helloByte}, m.nodeID...)
	l.queue <- hello
	go m.writer(l)
}

func (m *Mesh) findCharacteristic(device bluetooth.Device) (bluetooth.DeviceCharacteristic, error) {
	services, err := device.DiscoverServices([]bluetooth.UUID{m.serviceUUID})
	if err != nil || len(services) == 0 {
		return bluetooth.DeviceCharacteristic{}, errors.New("mesh service not found")
	}
	chars, err := services[0].DiscoverCharacteristics([]bluetooth.UUID{m.charUUID})
	if err != nil || len(chars) == 0 {
		return bluetooth.DeviceCharacteristic{}, errors.New("mesh characteristic not found")
	}
	return chars[0], nil
}

// finishAttempt clears a pending attempt; failed attempts wait before that device is tried again.
func (m *Mesh) finishAttempt(a *attempt, failed bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pending == a {
		m.pending = nil
		a.abandoned = true
	}
	if failed {
		m.cooldown[a.addr] = time.Now().Add(retryCooldown)
	}
}

func (m *Mesh) cooldownAddr(addr string) {
	m.mu.Lock()
	m.cooldown[addr] = time.Now().Add(retryCooldown)
	m.mu.Unlock()
}

func (m *Mesh) onConnectionState(device bluetooth.Device, state bluetooth.ConnectionState) {
	if state.Connected {
		return
	}
	id := "c:" + device.Address.String()
	m.mu.Lock()
	l := m.links[id]
	m.mu.Unlock()
	if l != nil {
		m.dropLink(l)
	}
}

func (m *Mesh) dropLink(l *link) {
	m.mu.Lock()
	if m.links[l.id] != l {
		m.mu.Unlock()
		return
	}
	delete(m.links, l.id)
	close(l.done)
	m.mu.Unlock()

	go func() { _ = l.device.Disconnect() }()
	m.emit("linkDown", map[string]string{"linkId": l.id})
	m.emitState()
}

/* ---------------- sending ---------------- */

// Send queues a frame. Returns false if the link is gone, the frame is too big, or the queue is full.
func (m *Mesh) Send(linkID string, frame []byte) bool {
	m.mu.Lock()
	l := m.links[linkID]
	m.mu.Unlock()
	if l == nil || len(frame) == 0 || len(frame) > l.maxFrame {
		return false
	}
	select {
	case l.queue <- frame:
		return true
	default:
		return false
	}
}

// writer sends one frame at a time (BLE allows one write in flight per link).
func (m *Mesh) writer(l *link) {
	failures := 0
	for {
		select {
		case <-l.done:
			return
		case frame := <-l.queue:
			_, err := l.ch.WriteWithoutResponse(frame)
			if err != nil && strings.Contains(err.Error(), "not supported") {
				_, err = l.ch.Write(frame)
			}
			if err == nil {
				failures = 0
				continue
			}
			failures++
			log.Printf("blemesh: %s: write: %v", l.id, err)
			if failures >= 5 {
				m.dropLink(l)
				return
			}
		}
	}
}

func parseUUID(s, fallback string) (bluetooth.UUID, error) {
	if s == "" {
		s = fallback
	}
	return bluetooth.ParseUUID(s)
}
