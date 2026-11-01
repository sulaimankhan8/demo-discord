# The Go, Java and Swift code, explained from zero

This guide is for someone who knows TypeScript/JavaScript but not Go, Java or Swift.
It explains **why** this code exists, **what** each file does, and then walks through every
file block by block (with line numbers) so you can open the file next to this guide and follow along.

Grouping: lines that belong together (an `import` list, a struct, a small function) are
explained as one block. Every block is covered, and every line that does something
non-obvious gets its own note.

---

## Contents

0. [The big picture: why this code exists at all](#0-the-big-picture)
1. [Bluetooth words you need (glossary)](#1-bluetooth-glossary)
2. [How the phones find each other and connect (the protocol)](#2-the-protocol)
3. [How the website talks to native code (the bridge)](#3-the-bridge)
4. [Crash course: Go, Java and Swift for a TypeScript developer](#4-crash-course)
5. [Go code (desktop app)](#5-go-code-desktop-app)
6. [Java code (Android app)](#6-java-code-android-app)
7. [Swift code (iPhone app)](#7-swift-code-iphone-app)
8. [The story of one message, end to end](#8-the-story-of-one-message)
9. [Files you can ignore](#9-files-you-can-ignore)
10. [Same idea in three languages (cheat sheet)](#10-cheat-sheet)

---

## 0. The big picture

Your app is a website (Next.js + TypeScript). The **offline mesh** lets phones send chat
messages to each other **with no internet**, by passing them over Bluetooth from phone to phone.

The problem: **a website cannot do this.** A browser:

- cannot *advertise* ("shout I'm here!") over Bluetooth, so other phones can't find it,
- cannot accept incoming Bluetooth connections,
- cannot keep Bluetooth running when the screen is off,
- on iPhone (Safari) cannot use Bluetooth at all.

So each platform gets a small **native "radio driver"**, written in the language that platform
requires:

| Platform | Language | Why that language | Where |
|---|---|---|---|
| Android | **Java** | Android's Bluetooth API is a Java API | `frontend/android/app/src/main/java/com/demodiscord/app/` |
| iPhone | **Swift** | Apple's Bluetooth API (CoreBluetooth) is used from Swift | `frontend/ios/App/App/` |
| Windows desktop | **Go** | Wails (the desktop-window tool) uses Go, and Go has a good Bluetooth library | `frontend/desktop/` |

The most important idea in this whole guide:

> **The native code is dumb on purpose.** It only does three things:
> 1. find nearby phones running the app,
> 2. keep connections ("links") to them open,
> 3. move raw bytes ("frames") in and out of those links.
>
> All the clever parts (who the message is for, routing, removing duplicates, signatures,
> encryption) live in **your TypeScript** in `frontend/lib/mesh/`. That code runs unchanged on all
> three platforms.

Analogy: the TypeScript code is the **post office** (it reads addresses and decides where letters
go). The native code is the **delivery van** (it just drives letters between buildings and doesn't
read them).

Because of this, the three native versions are **twins**: the Android Java, the iPhone Swift and
the desktop Go all offer the exact same 11 functions and 4 events to the website.

---

## 1. Bluetooth glossary

The code uses **Bluetooth Low Energy (BLE)**, the kind used by fitness bands and smartwatches.

| Word | Plain meaning |
|---|---|
| **Advertise** | Repeatedly broadcast a tiny packet saying "I exist, and I offer service X." Like a lighthouse. |
| **Scan** | Listen for those advertisements. Like looking for lighthouses. |
| **Scan response** | A second small packet an advertiser gives when a scanner asks for more. Used here to carry the phone's node id. |
| **Central** | The side that **starts** a connection (it scanned, found someone, and connected). |
| **Peripheral** | The side that **was connected to** (it was advertising and someone connected). |
| **GATT** | The set of rules for how two connected BLE devices exchange data. |
| **GATT server** | The "mailbox" a peripheral offers. Other devices connect to it and read/write it. |
| **Service** | A named group inside a GATT server. Ours is named `f47b5e2d-…-6f01`. |
| **Characteristic** | One slot inside a service that can hold data. Ours is `f47b5e2d-…-6f02`. All mesh data goes through it. |
| **UUID** | A long unique id like `f47b5e2d-4a9e-4c5b-9e1a-3b2c8d7e6f01`. All copies of the app agree on these two UUIDs, which is how they recognise each other and ignore your headphones. |
| **Write** | Central → peripheral: the central puts bytes into the peripheral's characteristic. |
| **Write without response** | Same, but no "got it" receipt. Faster. |
| **Notify** | Peripheral → central: the peripheral pushes bytes to the central. |
| **CCCD** (`0x2902`) | A tiny on/off switch attached to a characteristic. The central writes "1" to it to say "please send me notifications." This is how a link "turns on." |
| **MTU** | Maximum bytes per Bluetooth packet. Starts at 23; phones can negotiate up to 517. Usable data is MTU − 3. |
| **Frame** | One chunk of bytes the TypeScript wants sent. The native code never looks inside it. |
| **Link** | One open connection to one other phone. Max 7 at once by default. |
| **Base64** | A way to write bytes as text (`"AAEC..."`). Needed because the website ↔ native bridge only passes text/JSON. |

Every phone is **both** central and peripheral at the same time: it advertises (so others can
connect to it) and scans (so it can connect to others). The desktop is **central only**.

---

## 2. The protocol

This is the agreement all three platforms follow, so an Android, an iPhone and a PC can talk.

**Step 1 — Advertise.** Each phone advertises our service UUID, plus its **node id**: 8 random
bytes made fresh every time the mesh starts.
- Android puts the node id in "service data" in the scan response.
- iPhone isn't allowed to advertise service data, so it puts the id in its **name**: `"M"` +
  the id as 16 hex characters, e.g. `M1a2b3c4d5e6f7a8b`.
- Everyone knows how to read both forms.

**Step 2 — Decide who connects.** If phone A and phone B both see each other, they might *both*
connect, creating two links between the same pair (wasting a slot). Rule:
- The phone with the **lower node id connects**. The other waits.
- If the waiting phone still has no link after **15 seconds** (maybe the other can't see it),
  it connects anyway.
- The desktop ignores this rule and always connects, since phones can never connect to a desktop.

**Step 3 — Connect.** The central connects, finds our service and characteristic, and turns on
notifications (writes "1" to the CCCD). Now the link is **up**.

**Step 4 — Hello.** The central immediately sends a **hello frame**: `[0xFF][its 8-byte node id]`.
That tells the peripheral who connected. The native code swallows this frame; it never reaches
TypeScript. (Real mesh frames always start with `0x00` or `0x01`, so they can't be confused with
the hello.)

**Step 5 — Data.** From now on:
- central → peripheral: **writes**
- peripheral → central: **notifications**

Link ids look like `"c:AA:BB:CC:DD:EE:FF"` (we are **c**entral) or `"p:…"` (we are **p**eripheral).

**Safety rules everywhere:**
- Only **one connection attempt at a time** (Bluetooth chips get confused otherwise).
- A phone that failed to connect gets a **10-second cooldown** before retrying.
- A connection attempt that takes over **12 seconds** is abandoned.
- Each link has a **send queue** of up to **512 frames**. Bluetooth allows one write in flight per
  link, so frames go out one at a time.

---

## 3. The bridge

The TypeScript side ([BleLinkTransport.ts](../frontend/lib/mesh/transports/BleLinkTransport.ts))
calls a plugin named **`BleMesh`**:

- On phones it comes from **Capacitor**: `registerPlugin("BleMesh")`. Capacitor is the tool that
  wraps your website in a phone app and lets JavaScript call Java/Swift.
- On desktop it comes from **Wails**: `window.go.main.App`, wrapped by
  [desktop.ts](../frontend/lib/desktop.ts) to look exactly like the Capacitor plugin.

Every call returns a **Promise**. The native side either **resolves** (success) or **rejects**
(error) it.

**Functions (JS → native):**

| Function | What it does | Android | iPhone | Desktop |
|---|---|---|---|---|
| `ensurePermissions()` | Ask for Bluetooth permission → `{granted}` | real prompt | real prompt | always yes |
| `start({serviceUuid, characteristicUuid, maxLinks})` | Turn the mesh radio on | ✔ | ✔ | ✔ |
| `stop()` | Turn it off, drop all links | ✔ | ✔ | ✔ |
| `send({linkId, data})` | Queue one base64 frame on a link → `{queued}` | ✔ | ✔ | ✔ |
| `getState()` | Is it running? Scanning? Which links? | ✔ | ✔ | ✔ |
| `enableBluetooth()` | Help the user turn Bluetooth on | system dialog | opens Settings | opens Settings |
| `getCapabilities()` | Which of the next features this build has | all true | all true | storage key only |
| `setPowerMode({mode, maxLinks})` | Save battery in background / low battery | ✔ | ✔ | ignored |
| `getBattery()` | Battery level and charging | ✔ | ✔ | — |
| `getStorageKey()` | Get a secret 32-byte key kept by the OS's safe | Keystore | Keychain | Windows DPAPI |
| `deleteStorageKey()` | Destroy that key (panic wipe) | ✔ | ✔ | ✔ |

**Events (native → JS):**

| Event | Data | Meaning |
|---|---|---|
| `linkUp` | `{linkId, maxFrameBytes, role}` | A new link is ready |
| `linkDown` | `{linkId}` | A link closed |
| `data` | `{linkId, data}` (base64) | A frame arrived |
| `state` | the same object as `getState()` | Something changed (for the UI) |

If you understand these two tables, you understand what every native file is *for*. The rest is
how each platform does it.

---

## 4. Crash course

Only the syntax you need to read this code, compared to TypeScript.

### 4.1 Go

```go
package main                       // which "module" this file belongs to. "main" = the program itself.
import "time"                      // like: import * as time from "time"

const maxQueue = 512               // const maxQueue = 512
var x int = 5                      // let x: number = 5
y := 5                             // let y = 5   (":=" declares AND assigns; type is inferred)

type Link struct {                 // interface Link {
    ID   string                    //   ID: string
    Size int `json:"size"`         //   size: number  (the `json:"size"` tag = the key name in JSON)
}                                  // }

func add(a int, b int) int {       // function add(a: number, b: number): number {
    return a + b
}

func (m *Mesh) Start() error {     // a METHOD on Mesh. Like: class Mesh { Start(): Error | null {...} }
    ...                            // "m" plays the role of "this".
}
```

Things that look strange at first:

| Go | Meaning |
|---|---|
| **Capital first letter** (`Start`, `Send`) | Public (exported). Lowercase (`scanLoop`) = private to this package. |
| `nil` | `null` |
| `val, err := f()` | Functions can return **two** values. The last is usually an error. |
| `if err != nil { return err }` | Go has no exceptions. You check errors by hand after every call. |
| `_ = f()` | Call `f` and deliberately ignore the result. |
| `*Mesh` | A **pointer**: "a reference to a Mesh" (like objects in JS, which are always references). |
| `&App{}` | Create an App and give back a pointer to it. |
| `[]byte` | A list of bytes (like `Uint8Array`). |
| `map[string]*link` | Like `Map<string, Link>` / `Record<string, Link>`. |
| `for { ... }` | Loop forever (`while (true)`). |
| `for _, l := range m.links` | `for (const l of m.links.values())` |
| `defer x()` | Run `x()` when this function exits, however it exits (like a `finally`). |
| `go f()` | Run `f` **in the background, at the same time** (a "goroutine"). Like starting an async task you don't await. |
| `chan []byte` | A **channel**: a thread-safe queue/pipe between goroutines. `ch <- v` puts in, `v := <-ch` takes out (waits if empty). |
| `close(ch)` | Close a channel. Everyone waiting on it wakes up. Used as a "stop!" broadcast. |
| `select { case ...: case ...: }` | Wait for whichever channel is ready first. With `default:` it doesn't wait at all. |
| `sync.Mutex` / `m.mu.Lock()` / `Unlock()` | A lock. Because goroutines run truly in parallel, two could change `m.links` at the same instant and corrupt it. Lock = "only one at a time in here." JavaScript never needs this because it's single-threaded. |
| `//go:embed` / `//go:build` | Special comments that are instructions to the Go compiler. |

### 4.2 Java

```java
package com.demodiscord.app.mesh;            // folder/namespace of this file
import android.bluetooth.BluetoothAdapter;   // import { BluetoothAdapter } from "android/bluetooth"

public class Engine {                        // export class Engine {
    private static final int MAX = 512;      //   private static readonly MAX = 512
    private boolean running;                 //   private running: boolean = false
    public String start(int maxLinks) {      //   public start(maxLinks: number): string {
        if (running) return null;
        ...
    }
}
```

| Java | Meaning |
|---|---|
| Type **before** the name: `int count`, `String name` | TS writes `count: number` |
| `void` | returns nothing |
| `static final` | a constant that belongs to the class, not each object |
| `byte[]` | array of bytes (`Uint8Array`) |
| `Map<String, Link> links = new HashMap<>()` | `const links = new Map<string, Link>()` |
| `interface Listener { void onData(...); }` | A TS interface: a list of methods a class promises to have |
| `implements Listener` | "this class has all of Listener's methods" |
| `extends Plugin` | inherits from `Plugin` (like TS `extends`) |
| `@Override`, `@PluginMethod` | **Annotations**: labels for tools. `@Override` = "this replaces a parent method." `@PluginMethod` = "Capacitor, let JavaScript call this." |
| `() -> { ... }` | arrow function |
| `new Runnable() { public void run() {...} }` | an object with one method, created on the spot (an "anonymous class"). Basically a function you can schedule. |
| `try { } catch (Exception e) { }` | same as JS |
| `Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU` | "is this phone Android 13 or newer?" Android changes its APIs often, so code picks old vs new style. (S = 12, TIRAMISU = 13, Q = 10, O = 8, M = 6.) |
| `handler.post(() -> ...)` | Run this on the **main thread** soon. Like `queueMicrotask`. |
| `handler.postDelayed(r, 2000)` | `setTimeout(r, 2000)` |
| `handler.removeCallbacks(r)` | `clearTimeout` |

**Why `handler.post` is everywhere:** Android delivers Bluetooth events on random background
threads. If two threads changed `links` at once, it would break. So every Bluetooth callback
immediately "posts" its work to the main thread. Since everything then runs on one thread (like
JavaScript), no locks are needed. (Go solves the same problem with a Mutex instead.)

### 4.3 Swift

```swift
import CoreBluetooth                       // import Apple's Bluetooth library

final class Engine: NSObject {             // class Engine extends NSObject  ("final" = can't be subclassed)
    static let maxQueue = 512              // static readonly maxQueue = 512
    private var running = false            // private running = false
    let id: String                         // readonly id: string
    var peripheral: CBPeripheral?          // peripheral: CBPeripheral | undefined

    func send(_ linkId: String, _ frame: Data) -> Bool {   // send(linkId: string, frame: Data): boolean
        ...
    }
}
```

| Swift | Meaning |
|---|---|
| `let` / `var` | `const` / `let` |
| `Type?` (optional) | "might be nil" (`T \| null`) |
| `x?.foo()` | optional chaining, same as JS |
| `x ?? 7` | same as JS |
| `if let v = x { ... }` | "if x isn't nil, call it v and run this" |
| `guard let v = x else { return }` | "if x IS nil, leave now; otherwise continue with v." Used for early-exit checks. |
| `guard cond else { return }` | `if (!cond) return;` |
| `nil` | `null` |
| `self` | `this` |
| `Self.foo` | a static member of this class |
| `{ x in ... }` | arrow function `(x) => {...}` |
| `$0` | the first argument of a short closure: `filter { $0.up }` = `filter(l => l.up)` |
| `[weak self]` | Inside a closure: don't keep `self` alive just because this closure exists (avoids memory leaks). Then `guard let self = self` checks it still exists. |
| `weak var delegate` | same idea for a property |
| `protocol` | TS interface |
| `extension Engine: SomeProtocol { ... }` | "add these methods to Engine, which make it satisfy SomeProtocol." Used to group code. |
| **delegate** | Apple's callback pattern: "object X, here's who to call when things happen." Like passing an object of event handlers. |
| `@objc` | Make this visible to Objective-C (Apple's older language). Capacitor finds plugin methods by name through it. |
| `@escaping` | "This callback will be stored and called later, not right now." |
| `===` | "same object" (identity) |
| `"text \(value)"` | template string `` `text ${value}` `` |
| `throws`, `try`, `do { } catch { }` | exceptions |
| `Data` | bytes (`Uint8Array`) |
| `[String: Any]` | a dictionary / JS object |
| `private(set) var x` | others can read `x`, only this class can change it |
| `switch x { case .a: ... case .b: ... }` | switch with no fall-through; `.a` is an enum case |
| `// MARK: - Something` | just a section heading for Xcode's menu |

---

## 5. Go code (desktop app)

Folder: `frontend/desktop/` (5 files). Built with `npm run desktop`.

What it is: **Wails** opens a native window containing a web view (a built-in browser, Edge
WebView2 on Windows) that shows the same static website the phone apps use. The Go code adds the
Bluetooth driver so the PC can join the mesh.

### 5.1 [main.go](../frontend/desktop/main.go) — the program's starting point (49 lines)

**Lines 1–5 — comment.** Says what this is, and that the built website (`frontend/out`) is copied
into `dist/` first, because Go can only bundle files that are inside its own folder.

**Line 6 — `package main`.** This file is part of the program itself (not a library). Every Go
program starts at a function `main` inside `package main`.

**Lines 8–17 — imports.**
- `embed` — lets Go bake files into the `.exe`.
- `io/fs` — tools for working with folders of files.
- `log` — printing errors.
- the four `wails` lines — the desktop-window library and its option types.

**Lines 19–20 — embed the website.**
```go
//go:embed all:dist
var dist embed.FS
```
That comment is an **instruction to the compiler**: "take the whole `dist` folder and put it
inside the program." `dist` becomes a virtual folder in memory. Result: the `.exe` is one file that
contains the whole website. `all:` means include hidden files too.

**Line 22 — `func main()`.** Program starts here.

**Lines 23–26.**
```go
assets, err := fs.Sub(dist, "dist")
if err != nil { log.Fatal(err) }
```
The embedded files have paths like `dist/index.html`. `fs.Sub` gives a view where they're just
`index.html`. If that fails, `log.Fatal` prints the error and quits. (You'll see this
`if err != nil` pattern everywhere in Go.)

**Line 28 — `app := NewApp()`.** Creates the `App` object from `app.go`: the thing JavaScript
will call.

**Lines 29–45 — open the window.** `wails.Run(...)` opens the window and keeps the program
running until it's closed. The settings:
- `Title`, `Width: 1280`, `Height: 820` — window title and starting size.
- `MinWidth: 380`, `MinHeight: 560` — smallest allowed size (380 ≈ phone width, so the mobile
  layout still fits).
- `BackgroundColour` — near-black (R10 G10 B12), shown for a split second before the page loads,
  so there's no white flash.
- `AssetServer: {Assets: assets}` — "serve the website from the embedded files."
- `OnStartup: app.startup`, `OnShutdown: app.shutdown` — functions Wails calls when the window
  opens/closes.
- `Bind: []interface{}{app}` — **the key line.** It exposes every public method of `app` to
  JavaScript as `window.go.main.App.MethodName()`. `[]interface{}{app}` is just "a list
  containing app" (`interface{}` = "any type").
- `Windows: { WebviewUserDataPath: userDataPath() }` — Windows-only setting: always store the web
  view's data (localStorage, IndexedDB) in the same folder, so your mesh identity and message
  history survive restarts and updates.

**Lines 46–48.** If the window failed to open, print and quit.

### 5.2 [app.go](../frontend/desktop/app.go) — the plugin JavaScript calls (140 lines)

This file is the Go version of "the `BleMesh` plugin." Each method here matches one function in
the bridge table (section 3). Wails turns each `(result, error)` return into a Promise that
resolves or rejects.

**Lines 3–11 — imports.** `context` (a Wails handle), `base64`, `errors`, `os` (files/folders),
`path/filepath` (building paths like `a\b\c`), and Wails' `runtime` (for sending events).

**Lines 16–19 — `type App struct`.**
- `ctx` — Wails' handle for this window. Needed to send events to the page.
- `mesh *Mesh` — the Bluetooth engine from `mesh.go`.

**Lines 21–23 — `NewApp()`.** Returns a new, empty App. (Go has no `constructor` keyword; a
`NewX` function is the convention.)

**Lines 25–30 — `startup`.** Runs when the window opens.
```go
a.mesh = NewMesh(func(event string, data any) {
    runtime.EventsEmit(a.ctx, "blemesh:"+event, data)
})
```
Creates the mesh engine and gives it an **emit function**. Whenever the engine wants to tell the
website something (e.g. `"linkUp"`), it calls this, which sends a Wails event named
`"blemesh:linkUp"` to the page. [desktop.ts](../frontend/lib/desktop.ts) listens for those.
This is how **Go → JavaScript** works.

**Lines 32–36 — `shutdown`.** When the window closes, stop the mesh (disconnect everything).

**Lines 38–49 — where data lives.**
- `appDir()` — `os.UserConfigDir()` is `C:\Users\<you>\AppData\Roaming` on Windows. Result:
  `...\AppData\Roaming\DemoDiscord`. If that fails, use the temp folder.
- `userDataPath()` — `...\DemoDiscord\webview` (used in main.go).

**Lines 53–57 — `StartOptions`.** The shape of the object JavaScript passes to `start()`:
```go
ServiceUUID string `json:"serviceUuid"`
```
The `json:"serviceUuid"` tag means "the JSON key `serviceUuid` fills this field." The field name
is capitalised because Go only fills public fields.

**Lines 59–61, 64–66 — `EnsurePermissions`.** Windows has no per-app Bluetooth permission prompt,
so this always answers `{granted: true}`.

**Lines 68–75 — `Start` / `Stop`.** Just forward to the mesh engine.

**Lines 77–87 — `Send`.**
```go
frame, err := base64.StdEncoding.DecodeString(data)
```
JavaScript sends the frame as base64 text. Turn it back into bytes. If it isn't valid base64,
reject with `"bad frame"`. Otherwise ask the engine to queue it and return `{queued: true/false}`.

**Lines 89–91 — `GetState`.** Return the engine's current state (shape is in mesh.go).

**Lines 93–97 — `EnableBluetooth`.** An app can't switch the PC's Bluetooth on, so this opens
Windows Settings → Bluetooth instead (function is in platform_windows.go).

**Lines 99–107 — `GetCapabilities`.** Returns `{power: false, battery: false, storageKey: …}`.
In Go, any field you don't set is automatically its "zero value" (`false` for booleans). So only
`storageKey` can be true, and only on Windows (`storageKeySupported` comes from the platform file).
The website checks this so it doesn't call features the desktop doesn't have.

**Lines 109–118 — `SetPowerMode`.** Accepted but does nothing: PCs are usually plugged in.

**Lines 120–132 — `GetStorageKey`.** Loads (or creates on first use) a secret 32-byte key from
`...\DemoDiscord\storage.key`. The file is encrypted by Windows so only your Windows account can
read it. Returns it to JavaScript as base64. The website uses this key to encrypt the mesh secrets
it stores in IndexedDB.

**Lines 134–140 — `DeleteStorageKey`.** Deletes that file (panic wipe). If it's already gone
(`os.ErrNotExist`), that's fine, not an error.

### 5.3 [mesh.go](../frontend/desktop/mesh.go) — the desktop Bluetooth engine (496 lines)

The real work. Remember: **the desktop only scans and connects** (central). It never advertises,
because Windows can't reliably run its own GATT server. So phones can't connect *to* a PC, and two
PCs can't link directly; they reach each other through a phone or the internet.

**Lines 3–18 — comment.** A summary of the protocol from section 2.

**Lines 20–31 — imports.**
- `crypto/rand` — secure random numbers (for the node id).
- `encoding/base64`, `encoding/hex` — text encodings.
- `errors`, `log`, `strings`.
- `sync` — the Mutex lock.
- `time` — timers and durations.
- `tinygo.org/x/bluetooth` — an open-source library that does the actual Windows Bluetooth
  calls. Without it we'd have to talk to Windows' Bluetooth API directly.

**Lines 33–45 — constants.**
| Name | Value | Meaning |
|---|---|---|
| `defaultServiceUUID` | `…6f01` | our service's id |
| `defaultCharacteristicUUID` | `…6f02` | our characteristic's id |
| `helloByte` | `0xFF` | first byte of the hello frame |
| `nodeIDBytes` | `8` | node ids are 8 bytes |
| `maxQueue` | `512` | max waiting frames per link |
| `maxAttributeSize` | `512` | max bytes in one frame |
| `connectTimeout` | 12 s | give up connecting after this |
| `attemptTimeout` | 25 s | give up on a whole attempt (connect + setup) after this |
| `retryCooldown` | 10 s | wait before retrying a phone that failed |
| `scanRetryDelay` | 3 s | wait before restarting a scan that stopped |

**Lines 47–62 — `LinkInfo` and `MeshState`.** The shapes sent to JavaScript by `getState()` and
the `state` event. `omitempty` on `Error` = leave the key out of the JSON when there's no error.

**Lines 64–73 — `type link struct`.** One connection to one phone:
- `id` — like `"c:AA:BB:CC:DD:EE:FF"`.
- `addr` — the phone's Bluetooth address.
- `nodeID` — the phone's 8-byte node id (if we saw it).
- `device` — the library's handle for the connection.
- `ch` — the phone's characteristic (where we write, and where notifications come from).
- `maxFrame` — biggest frame allowed on this link.
- `queue chan []byte` — the waiting line of frames to send (a channel, so the sender goroutine can
  wait on it safely).
- `done chan struct{}` — a "this link is dead" signal. It's never sent anything; it just gets
  **closed**, and closing wakes up whoever is waiting on it. (`struct{}` = an empty value that
  takes no memory.)

**Lines 75–80 — `type attempt`.** One connection attempt in progress. `abandoned` becomes true if
we gave up on it, so if it finishes late, we know to throw the connection away.

**Lines 82–100 — `type Mesh struct`.** The engine's memory:
- `emit` — the function from app.go that sends events to JavaScript.
- `adapter` — the PC's Bluetooth radio.
- `mu` — the lock. Many things run at the same time here: the scan callback, a connect goroutine,
  one writer goroutine per link, and JavaScript calling `Send`. All of them read/change the fields
  below, so they must hold `mu` while doing so.
- `enabled` — have we initialised the radio yet (only done once).
- `running` — is the mesh on.
- `stopCh` — closed when the mesh stops (the "everyone stop" broadcast).
- `serviceUUID`, `charUUID`, `maxLinks`, `nodeID` — settings for this run.
- `links` — open links by id.
- `cooldown` — address → time we may retry it.
- `pending` — the one attempt in progress, or nil.
- `bluetoothOn`, `scanning`, `lastError` — status for the UI.

**Lines 102–109 — `NewMesh`.** Creates the engine with the default radio and empty maps.

#### Start and stop (lines 113–203)

**`Start` (113–153).**
1. Lock. If already running, unlock and return (calling start twice is harmless).
2. Lines 119–128: turn the UUID strings into UUID values (`parseUUID` uses the default if the
   string is empty). On error, **unlock first** then return the error. Forgetting to unlock would
   freeze the app forever ("deadlock"), so every early return unlocks.
3. Lines 129–135: first time only: `adapter.Enable()` initialises Windows Bluetooth. It may
   complain that it's already initialised (the web view did that), which is fine, so the error is
   ignored (`_ =`). Then register `onConnectionState`, which the library calls whenever any device
   disconnects.
4. Lines 136–140: save settings; `maxLinks` defaults to 7.
5. Lines 141–142: make a new random 8-byte node id.
6. Lines 143–147: mark running, clear the error, make a fresh stop channel, and keep a local copy
   (`stop`) to give to the scanner.
7. Unlock.
8. Line 150: `go m.scanLoop(stop)` — start scanning **in the background**.
9. Line 151: tell JavaScript the new state.

**`Stop` (155–182).**
1. Lock. If not running, return.
2. `running = false`; `close(m.stopCh)` tells the scan loop to quit.
3. Mark any pending attempt as abandoned.
4. Lines 167–172: copy all links into a plain list, then reset the maps.
5. Unlock. The slow work below (disconnecting) happens **without** the lock, so nothing else is
   blocked while it runs.
6. Stop scanning. For each link: `close(l.done)` stops its writer goroutine, disconnect, and send
   `linkDown` to JavaScript.
7. Send the new state.

**`State` (184–199).** Lock, and `defer m.mu.Unlock()` so it unlocks automatically when the
function returns. Builds a `MeshState`. `Advertising` is never set (stays false) because the desktop
doesn't advertise. Every link's role is `"central"`.

**`emitState` (201–203).** Sends the `state` event.

#### Scanning (lines 207–308)

**`scanLoop` (209–232)** — runs in the background for as long as the mesh is on.
```go
for {
    m.setScanning(true, "")
    err := m.adapter.Scan(m.onScan)
```
`Scan` **blocks** (sits on this line) and calls `onScan` once for every advertisement it hears,
until scanning is stopped or fails. When it returns:
- Lines 213–218: check without waiting (`select` + `default`) whether we were told to stop. If so,
  mark not-scanning and exit.
- Lines 219–224: if it returned an error, Bluetooth is probably off or missing; log it and mark
  `bluetoothOn = false`.
- Lines 226–230: wait 3 seconds, **or** exit immediately if stop happens during the wait. Then
  loop and scan again. This is how the PC recovers by itself when you turn Bluetooth back on.

**`setScanning` (234–243).** Updates `scanning` and `lastError`. Only emits a `state` event if
something actually changed, so JavaScript isn't spammed.

**`onScan` (245–283)** — called for **every** BLE advertisement nearby (headphones, watches, TVs…
many per second). It decides whether to connect.
1. Lock. If not running, ignore.
2. Lines 251–252: we just heard something, so Bluetooth must be on. Remember if it was "off" before
   so we can tell JavaScript it came back.
3. Lines 253–259: not advertising our service UUID? Not our app. Ignore.
4. Line 260–261: the link id would be `"c:" + address`.
5. Line 262: **skip** if we're already connecting to someone, already linked to this address, or
   already have the maximum number of links.
6. Lines 263–265: skip if this address is in cooldown.
7. Lines 266–269: read its node id. Skip if it's **our own** id, or if we're already linked to that
   same phone under a different address (phones sometimes change addresses).
8. Lines 270–274: if not skipping, create an `attempt` and mark it pending (so no other connect
   starts).
9. Unlock. If Bluetooth just came back, emit state.
10. Line 281: `go m.connect(...)` — connect **in the background** so scanning isn't blocked.

**`peerNodeID` (286–299).** Reads a phone's node id from its advertisement:
- Android: in "service data" under our UUID, exactly 8 bytes. `append([]byte(nil), sd.Data...)`
  makes a copy (the library may reuse that memory).
- iPhone: local name is `"M"` + 16 hex characters → decode the hex into 8 bytes.
- Neither → `nil` (unknown).

**`isLinkedTo` (301–308).** Is any link's node id equal to this one?

#### Connecting (lines 312–445)

**`connect` (312–386)** — runs in its own goroutine for one phone.
1. Line 313: a **watchdog**: if the whole thing isn't done in 25 s, `finishAttempt(a, true)` marks
   it abandoned and puts the address in cooldown, so scanning can move on. `defer watchdog.Stop()`
   cancels the watchdog when `connect` finishes.
2. Lines 316–319: connect, with a 12 s timeout and "throughput" priority (ask for a fast connection).
3. Lines 320–324: failed → log, finish the attempt as failed (cooldown), return.
4. Lines 325–331: find our service and characteristic on the phone. Not there → disconnect, fail.
5. Lines 332–335: work out the max frame size. Default 20 bytes. If the connection's MTU is known,
   use MTU − 3 (3 bytes are Bluetooth's own header), capped at 512.
6. Lines 337–346: build the `link` with a queue that can hold 512 frames and a fresh `done` channel.
7. Lines 348–359: lock and **check again**, because time has passed: was the attempt abandoned by
   the watchdog? Did the mesh stop? Are we now full? If any, throw the connection away. Otherwise
   clear `pending` and register the link.
8. Line 362: send `linkUp` to JavaScript **before** any data, because the website expects that order.
9. Lines 365–375: **turn on notifications** and give a function to run for every incoming packet:
   if this link is still the current one, send a `data` event with the bytes as base64.
10. Lines 376–381: couldn't turn on notifications → cooldown and drop the link.
11. Lines 383–385: put the **hello frame** `[0xFF][our node id]` first in the queue and start this
    link's writer goroutine.

**`findCharacteristic` (388–398).** Ask the phone for our service (by UUID), then for our
characteristic inside it. Returns an error if either is missing.

**`finishAttempt` (401–411).** If this attempt is still the pending one, clear it and mark it
abandoned. If it failed, set a 10 s cooldown for that address.

**`cooldownAddr` (413–417).** Set a 10 s cooldown (used when notifications failed).

**`onConnectionState` (419–430).** The library calls this when any device connects or disconnects.
Connections we ignore (we handle those in `connect`). On disconnect, find our link for that address
and drop it.

**`dropLink` (432–445).**
1. Lock. If this link isn't the current one for its id (already dropped, or replaced), do nothing.
   This prevents dropping twice.
2. Remove it, `close(l.done)` (stops its writer).
3. Unlock, disconnect in the background (can be slow), send `linkDown` and new state.

#### Sending (lines 450–489)

**`Send` (450–463)** — called when JavaScript sends a frame.
- No such link, empty frame, or frame too big → `false`.
- ```go
  select {
  case l.queue <- frame:  return true
  default:                return false
  }
  ```
  "Try to put the frame in the queue; if the queue is full (512), don't wait, just say false."
  The website then knows this link is overloaded.

**`writer` (466–489)** — one per link, runs in the background until the link dies.
- Waits for either `done` (link closed → exit) or a frame from the queue.
- Sends it with `WriteWithoutResponse` (fast, no receipt). If the phone says that's "not
  supported", falls back to normal `Write`.
- Success resets the failure counter. Failure logs it; **5 failures in a row** → drop the link.
- One frame at a time because BLE allows only one write in flight per link.

**`parseUUID` (491–496).** Uses `fallback` if the string is empty, then parses it.

### 5.4 [platform_windows.go](../frontend/desktop/platform_windows.go) — Windows-only parts (72 lines)

Go rule: a file ending in `_windows.go` is **only compiled on Windows**. So these functions exist
in two versions: this one and platform_other.go.

**Lines 3–12 — imports.** `crypto/rand`, `errors`, `os`, `os/exec` (run other programs),
`path/filepath`, `unsafe` (raw memory access, needed to talk to Windows' C-style functions), and
`golang.org/x/sys/windows` (Go wrappers for Windows system calls).

**Line 14.** `storageKeySupported = true` on Windows.

**`loadStorageKey` (18–42).** Gets the secret 32-byte key, making it the first time.
1. Lines 19–26: if `storage.key` exists, try to decrypt it. If that works and it's 32 bytes, return
   it. If it can't be decrypted (e.g. the file was copied from another Windows user), fall through
   and make a new key; data sealed with the old key was unreadable anyway.
2. Lines 27–30: make 32 secure random bytes.
3. Lines 31–34: encrypt them with `protect`.
4. Lines 35–37: create the folder. `0o700` = permissions: only the owner can access it.
5. Lines 38–40: write the encrypted key. `0o600` = only the owner can read/write the file.
6. Return the key (the unencrypted one, to JavaScript).

**`protect` / `unprotect` (44–63).** Use **DPAPI** (`CryptProtectData` / `CryptUnprotectData`),
Windows' built-in encryption that uses a secret tied to **your Windows login**. Only your account on
this PC can decrypt it; copying the file to another PC is useless.
- `windows.DataBlob{Size, Data}` — the "size + pointer to bytes" format Windows expects.
  `&data[0]` = address of the first byte.
- The many `nil, nil, 0, nil` are optional arguments we don't use.
- `CRYPTPROTECT_UI_FORBIDDEN` — never show a popup.
- `unprotect` refuses empty input first (line 54), because `&data[0]` would crash on an empty list.

**`takeBlob` (65–68).** Windows allocated the output memory itself. This copies those bytes into a
normal Go byte list, then `LocalFree` gives Windows its memory back (via `defer`, so it runs after
the copy). `unsafe.Slice(b.Data, b.Size)` = "treat this pointer as a list of Size bytes."

**`openBluetoothSettings` (70–72).** Runs the command
`rundll32 url.dll,FileProtocolHandler ms-settings:bluetooth`, which is a standard trick to open the
Windows Settings page `ms-settings:bluetooth`. `.Start()` = launch it without waiting.

### 5.5 [platform_other.go](../frontend/desktop/platform_other.go) — macOS/Linux stubs (15 lines)

**Line 1 — `//go:build !windows`.** Compile this file on everything **except** Windows.

**Lines 9–15.** `storageKeySupported = false`, `loadStorageKey` always errors "not supported",
`openBluetoothSettings` does nothing. These exist only so the program still compiles on Mac/Linux.
The comment notes that Keychain (Mac) / secret-service (Linux) support isn't written yet, so there
the website keeps mesh secrets unencrypted, like older phone builds.

---

## 6. Java code (Android app)

Folder: `frontend/android/app/src/main/java/com/demodiscord/app/`.

### 6.1 [MainActivity.java](../frontend/android/app/src/main/java/com/demodiscord/app/MainActivity.java) (15 lines)

On Android an **Activity** is one screen. This is the app's only screen.

- **Line 1** `package` — the folder/namespace.
- **Lines 3–6** imports. `BridgeActivity` is Capacitor's ready-made screen that contains a web view
  showing your website and connects JavaScript to plugins.
- **Line 8** `public class MainActivity extends BridgeActivity` — our screen *is* Capacitor's
  screen, plus one change:
- **Lines 9–14** `onCreate` runs when Android creates the screen. `registerPlugin(BleMeshPlugin.class)`
  tells Capacitor about our plugin. It must happen **before** `super.onCreate(...)` (which starts
  the bridge), as the comment says. Plugins from npm register themselves; our own local plugin
  must be registered by hand.

### 6.2 [BleMeshPlugin.java](../frontend/android/app/src/main/java/com/demodiscord/app/mesh/BleMeshPlugin.java) — the bridge (311 lines)

The doorway between JavaScript and the Bluetooth engine. It does **no Bluetooth itself**. It
checks inputs, converts base64, and passes calls to `BleMeshEngine`, then passes engine events
back to JavaScript.

**Lines 3–26 — imports.** Android pieces (permissions, Bluetooth adapter, battery, Base64…) and
Capacitor pieces (`Plugin`, `PluginCall`, `JSObject`, annotations).

**Lines 32–43 — `@CapacitorPlugin(...)`.** A label Capacitor reads:
- `name = "BleMesh"` — the name JavaScript uses in `registerPlugin("BleMesh")`.
- `permissions` — three groups with short nicknames ("aliases"):
  - `"bluetooth"`: `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT` (Android 12+).
  - `"location"`: `ACCESS_FINE_LOCATION` (Android 11 and older required location to scan, because
    Bluetooth scans can reveal where you are).
  - `"notifications"`: `POST_NOTIFICATIONS` (Android 13+, for the "mesh is on" notice).

**Line 44.** `extends Plugin` (a Capacitor plugin) `implements BleMeshEngine.Listener` (it has the 4
event methods the engine calls: link up/down, data, state changed).

**Lines 46–47.** `main` = a handle for running code on the main thread. `engine` = the Bluetooth engine.

**Lines 49–52 — `load()`.** Capacitor calls this once. Creates the engine and passes `this` as
its listener (so the engine's events come back here).

**Permissions (56–89).**
- `requiredAliases()` — Android 12+ (`S`) needs `"bluetooth"`; older needs `"location"`.
- `hasMeshPermissions()` — true if all of those are granted.
- `ensurePermissions(call)` — `@PluginMethod` means JavaScript can call it.
  `PluginCall call` is the JavaScript call: you read arguments from it and answer with
  `call.resolve(...)` or `call.reject(...)`. If already granted, answer at once. Otherwise ask the
  user (on Android 13+ also for notifications); when they answer, Capacitor runs `permissionsDone`
  (named in the request; `@PermissionCallback` marks it).
- `resolveGranted` — answers `{granted: true/false}`.

**`start` (93–122).**
1. No permission → reject with code `"PERMISSION"`.
2. Read `serviceUuid` / `characteristicUuid` (with defaults) and turn them into `UUID` objects. A
   badly formatted string throws `IllegalArgumentException` → reject `"BAD_ARGUMENT"`.
3. Read `maxLinks` (default 7).
4. `main.post(...)` — on the main thread, call `engine.start(...)`. It returns `null` for success or
   an error code. Turn codes into friendly reject messages. On success, start the **foreground
   service** (6.3) and resolve.

**`stop` (124–131).** Stop the engine and the foreground service.

**`handleOnDestroy` (133–139).** Capacitor calls this when the app is being closed; same cleanup.

**`send` (143–163).** Read `linkId` and `data`. Missing → reject. Decode base64 (`NO_WRAP` = no
line breaks) → bad → reject. Then on the main thread `engine.send(...)` and answer `{queued}`.

**`getState` (165–168).** Answer with `stateObject()`.

**`enableBluetooth` (171–184).** On Android 12+ needs the Bluetooth permission. Then starts an
**Intent** with `ACTION_REQUEST_ENABLE`. An Intent is a message to Android asking it to do
something; this one shows Android's "Allow app to turn on Bluetooth?" dialog.

**`getCapabilities` (189–196).** This build supports everything: `{power, battery, storageKey}`
all true.

**`setPowerMode` (198–206).** Pass the mode and link limit to the engine.

**`getBattery` (208–222).** A known Android trick: `registerReceiver(null, ACTION_BATTERY_CHANGED)`
returns the last battery announcement without really subscribing. From it:
- `level / scale` = battery as 0.0–1.0 (default 1.0 if unknown),
- `charging` = status is CHARGING or FULL.

**`getStorageKey` / `deleteStorageKey` (224–243).** Ask `SecureKeyStore` (6.4) for the key and
return it as base64, or delete it.

**`stateObject` (245–262).** Build the state JSON: running, bluetoothOn, advertising, scanning,
powerMode, error (only if there is one), and a list of links. The engine gives links as Java maps;
this copies them into Capacitor's JSON objects.

**Events → web (266–293).** The four `Listener` methods. Each builds a small JSON object and calls
`notifyListeners("eventName", obj)`, which fires the JavaScript `addListener` callbacks. `onData`
turns bytes into base64.

**Foreground service (297–310).** Start/stop `MeshForegroundService`. Wrapped in `try/catch`
because Android may refuse (e.g. if the app is in the background); that's not fatal, the mesh still
works while the app is open.

### 6.3 [MeshForegroundService.java](../frontend/android/app/src/main/java/com/demodiscord/app/mesh/MeshForegroundService.java) (73 lines)

**Why it exists:** Android aggressively kills background apps to save battery. If the app were
killed, the phone would stop relaying messages when the screen turns off. A **foreground service**
is Android's official way to say "this app is doing something the user knows about, keep it alive."
The price: it must show a permanent notification.

- **Lines 23–24** — notification channel id and a notification number (any fixed number).
- **`onStartCommand` (27–52)** — runs when the plugin starts the service:
  - `createChannel()` — Android 8+ requires notifications to belong to a "channel" the user can
    mute in settings.
  - Lines 30–33 — a **PendingIntent**: a pre-approved "open the app" action Android can run later
    when the user taps the notification. `FLAG_IMMUTABLE` is required on new Android versions.
  - Lines 35–42 — build the notification: Bluetooth icon, title "Offline mesh is on", text,
    `setOngoing(true)` (can't be swiped away), low priority (no sound), tap opens the app.
  - Line 44 — on Android 10+ declare the service type `CONNECTED_DEVICE` (required, and must match
    the manifest).
  - Lines 45–50 — become a foreground service. If Android refuses, stop the service quietly.
  - `START_NOT_STICKY` — if Android kills the service anyway, don't restart it automatically.
- **`createChannel` (54–61)** — skip on Android < 8 or if the channel already exists; otherwise
  create "Offline mesh" with low importance.
- **`onDestroy` (63–67)** — remove the notification.
- **`onBind` (69–72)** — returns null: nothing connects to this service directly; it only exists to
  keep the app alive.

### 6.4 [SecureKeyStore.java](../frontend/android/app/src/main/java/com/demodiscord/app/mesh/SecureKeyStore.java) (81 lines)

**Why it exists:** the website stores mesh secrets (your mesh identity keys) in IndexedDB. Anyone
who copies the app's files could read them. So the website encrypts them with a **storage key**, and
this file keeps that storage key safe.

**How:** Android has a **Keystore**, a safe (often a separate security chip) where keys can be
*used* but never *taken out*. So there are two keys:
1. a **wrapping key** (AES-256) created inside the Keystore, which never leaves it,
2. the **storage key** (32 random bytes), which the website needs. It is stored encrypted
   ("wrapped") by the wrapping key, in SharedPreferences (Android's small key-value storage, like
   localStorage).

Copying the files gives you only the wrapped blob, which is useless without the phone's Keystore.

- **Lines 25–29** — names: the Keystore, the wrapping key's name, the prefs file, the entry, and
  `IV_BYTES = 12`.
- **Line 31** — private constructor: nobody creates this object; it's just a holder for static
  functions.
- **`getOrCreate` (34–55)** — `synchronized` = only one thread may run this at a time.
  - Lines 35–37: open the prefs, get the wrapping key, read the stored blob.
  - Lines 38–43, **stored key exists**: decode base64. The blob is `[12-byte IV][encrypted key]`.
    Decrypt with **AES-GCM**: the IV is the first 12 bytes, 128 is the size of the tamper-check tag,
    and the rest is decrypted. Return the 32-byte key.
  - Lines 44–54, **first time**: make 32 random bytes. Encrypt with the wrapping key; the Keystore
    picks a random IV. Glue IV + encrypted bytes together, save as base64, return the key.
  - **IV** ("initialisation vector") = random bytes used once per encryption, so encrypting the same
    data twice looks different. Not secret, but needed to decrypt, which is why it's stored with the
    data. **GCM** = an encryption mode that also detects if anyone changed the data.
- **`delete` (58–63)** — panic wipe: remove the stored blob **and** delete the wrapping key from the
  Keystore. After this, anything the website encrypted with the storage key is unreadable forever.
- **`wrappingKey` (65–80)** — load the wrapping key from the Keystore if it exists; otherwise
  generate one there: AES, for encrypt+decrypt, GCM mode, no padding, 256 bits.

### 6.5 [BleMeshEngine.java](../frontend/android/app/src/main/java/com/demodiscord/app/mesh/BleMeshEngine.java) — the Android Bluetooth engine (909 lines)

The biggest file. Unlike the desktop, a phone does **both** roles:
- **peripheral role:** run a GATT server and advertise, so others can connect to us;
- **central role:** scan and connect to others.

**Lines 47–61 — header comment.** Summary of section 2, and the rule "all state is touched on the
main thread only."

**Line 62 — `@SuppressLint("MissingPermission")`.** Stops Android's code checker from warning about
permissions in every Bluetooth call; the plugin checks permissions before calling `start()`.

**Lines 65–70 — `interface Listener`.** The 4 events the engine reports (the plugin implements these).

**Lines 72–87 — constants.**
- The two UUIDs, plus `CCCD_UUID` `00002902-…`: the standard Bluetooth id for the "notifications
  on/off" switch.
- `HELLO = 0xFF`, `NODE_ID_BYTES = 8`, `MAX_QUEUE = 512`.
- `MAX_SEND_RETRIES = 50` — how many times to retry a frame when Android's Bluetooth is busy.
- `REQUESTED_MTU = 517` — ask for the biggest packets allowed.
- `MAX_ATTRIBUTE_BYTES = 512`.
- `WRITE_TIMEOUT_MS = 2000` — if Android never says "write done", carry on after 2 s anyway.
- `CONNECT_TIMEOUT_MS = 12000`, `RETRY_COOLDOWN_MS = 10000`, `FALLBACK_CONNECT_MS = 15000`.
- `SCAN_RESTART_MS = 20 min` — see `scanRestart` below.
- (`2_000` is just `2000`; underscores make numbers readable.)

**Lines 89–114 — `class Link`.** One connection:
- `id`, `role` ("central"/"peripheral"), `address` — fixed (`final`).
- `device`, `gatt` (our connection object when we're central), `characteristic`.
- `nodeId` — the other phone's id.
- `mtu = 23` — Bluetooth's default until negotiated.
- `up` — link is ready. Links are created *before* they're ready (while connecting) and only
  become `up` once notifications are on.
- `busy` — a write is in flight.
- `retries` — retry counter for the current frame.
- `queue` — an `ArrayDeque`, a list you can add to/take from at both ends.
- `writeTimeout`, `connectTimeout` — saved timers so they can be cancelled.
- `maxFrameBytes()` — MTU − 3, kept between 20 and 512.

**Lines 116–147 — engine fields.**
- `context` — Android's handle to the app.
- `handler` — runs code on the main thread (see 4.2).
- `links`, `cooldownUntil` (address → time), `firstSeen` (address → when we first saw a phone we're
  waiting for; used by the 15 s fallback).
- settings: `serviceUuid`, `characteristicUuid`, `maxLinks`, `nodeId`.
- power mode: `"foreground"`, `"background"`, `"low"`; duty cycle 5 s on / 10 s off.
- Bluetooth objects: `manager`, `adapter` (the radio), `server` (our GATT server), `advertiser`,
  `scanner`.
- status flags, `pendingAddress` (the one phone we're connecting to now), `lastError`.

**Constructor (149–152).** Saves the *application* context (not the screen's), so the engine doesn't
keep a closed screen in memory.

#### Lifecycle (156–264)

**`start` (157–175).**
1. Already running → success.
2. Get the Bluetooth manager and adapter. No adapter, or phone has no BLE → `"UNSUPPORTED"`.
3. Bluetooth off → `"BLUETOOTH_OFF"`.
4. Save settings, make a random node id (`SecureRandom`).
5. Mark running, listen for Bluetooth on/off, start the radio. Return `null` (= success).

**`stop` (177–185).** Mark not running, stop the radio, stop listening for on/off, clear the maps,
report state.

**`startRadio` (191–198).** Get the advertiser and scanner. `openServer()` creates our GATT server
(advertising starts later, once Android confirms the service was added). Start scanning. Schedule
`scanRestart` in 20 minutes. Report state.

**`stopRadio` (200–214).** Cancel both timers, stop scanning and advertising, remove every link
(`new ArrayList<>(links.values())` makes a copy, because `removeLink` changes `links` while we're
looping), close the GATT server.

**`scanRestart` (217–227).** Android quietly weakens scans that run for ~30 minutes. So every
20 minutes: if scanning, stop and start again. Then schedule itself again. (Skipped during the
"off" part of a duty cycle.)

**`dutyCycle` (230–243).** Only in background/low mode: if scanning, stop and come back in 10 s;
if not, start and come back in 5 s. So it scans 5 s out of every 15 s.

**`setPowerMode` (249–260).** Unknown modes count as foreground. Update `maxLinks` (low battery
allows fewer *new* links; existing ones stay). If the mode changed and we're running: cancel the
duty cycle, restart the scan in the new scan mode, and start the duty cycle unless foreground.

#### State (268–307)

Simple getters. `describeLinks()` lists only links that are `up`. `upLinkCount()` counts them.
`setError` saves the message, logs it, reports state.

#### Bluetooth on/off (311–348)

**`stateReceiver`.** A **BroadcastReceiver** listens to system-wide announcements. This one hears
"Bluetooth state changed":
- turning off / off → stop the radio, mark not advertising/scanning, report.
- on → clear the error and start the radio again.

So turning Bluetooth off and on again recovers the mesh automatically.

**register/unregister (330–348).** On Android 13+ you must say whether other apps may send to this
receiver; `RECEIVER_NOT_EXPORTED` = no. Unregistering is wrapped in try/catch because it throws if
already unregistered.

#### Peripheral role: our GATT server and advertising (352–553)

**`openServer` (352–372).** Build our "mailbox":
- open a GATT server, with `serverCallback` receiving everything other phones do to it;
- a primary **service** with our UUID;
- one **characteristic** with properties WRITE, WRITE_NO_RESPONSE, NOTIFY (others can write to it,
  and we can notify them), and WRITE permission;
- the **CCCD** descriptor (the notifications switch), readable and writable;
- `addService` — Android adds it in the background and then calls `onServiceAdded`.

**`serverCharacteristic` (374–378).** Look up our characteristic from the server (needed to notify).

**`startAdvertising` (380–405).**
- Phone can't advertise → set an error (the phone can still connect to others, just can't be found).
- Settings: `LOW_LATENCY` (advertise often so we're found fast; uses more battery), high transmit
  power (longer range), connectable, no timeout.
- **Advertisement** (only 31 bytes allowed!): just our service UUID. Device name excluded to save space.
- **Scan response**: our 8-byte node id as service data.

**`stopAdvertising` (407–415)** and **`advertiseCallback` (417–433)**: Android reports whether
advertising started; we update `advertising` or set an error.

**`serverCallback` (435–535)** — what happens when other phones use our mailbox. Each callback
posts its work to the main thread.
- `onServiceAdded` — service ready → start advertising (or report an error).
- `onConnectionStateChange` — someone disconnected → remove their `"p:"` link. Someone connected →
  create a `"p:"` link that is **not up yet**. The comment explains why: Android also reports our
  *own* outgoing connections here, so a link only counts once the other side turns notifications on.
- `onMtuChanged` — save the negotiated MTU on that link.
- `onDescriptorReadRequest` — the other side asks "are my notifications on?" Answer based on `up`.
- `onDescriptorWriteRequest` — the other side flips the CCCD switch:
  - send the "got it" response if asked;
  - ignore descriptors other than the CCCD;
  - switched **off** → remove the link;
  - already up → nothing to do;
  - already at `maxLinks` → `cancelConnection` (kick them, so they connect to someone else);
  - otherwise → **link up**, tell JavaScript.
- `onCharacteristicWriteRequest` — the other side sent us data:
  - respond if asked, ignore empty;
  - `Arrays.copyOf` — copy the bytes (Android may reuse the buffer);
  - if it's the **hello** (`0xFF` + 8 bytes) → remember their node id, don't pass it on;
  - otherwise → `onData` to JavaScript.
- `onNotificationSent` — our previous notification went out → `writeDone` → send the next frame.

**`peripheralLink` (537–546).** Get the `"p:"` link for this device, creating it if missing.

**`respond` (548–553).** Send the "success" reply to a request.

#### Central role: scanning and connecting (557–809)

**`startScan` (557–578).**
- A **filter** for our service UUID, so the Bluetooth chip itself ignores everything else (saves
  battery: the app isn't woken for every pair of headphones).
- Scan mode from power mode: low → `LOW_POWER`, background → `BALANCED`, foreground → `LOW_LATENCY`.
- Start; mark `scanning`, or set an error.

**`stopScan` (580–588)** and **`scanCallback` (590–610)**: results (single or batched) go to
`onFound`; a failure sets an error.

**`onFound` (612–639)** — "should I connect to this phone?" Same logic as the desktop's `onScan`,
plus the **lower id connects** rule:
1. Not running, or already connecting to someone → ignore.
2. Already have a `"c:"` link to this address, or at max links → ignore.
3. In cooldown → ignore.
4. Read its node id. If known:
   - it's our own → ignore;
   - we're already linked to that phone (they connected to us) → ignore;
   - `compare(nodeId, peerId) > 0` means **our id is higher**, so they should connect to us. The
     first time, remember when we saw them and wait. If 15 s later we still see them and nothing
     happened, connect anyway.

   Example: our id starts `9a…`, theirs `12…`. Theirs is lower, so they connect, we wait.
5. Connect.

**`peerNodeId` (645–659).** Service data (Android) or `"M"` + hex name (iPhone). Hex decoding is done
by hand: `Character.digit(c, 16)` turns `'a'` into 10, etc.; `(hi << 4) | lo` combines two hex
digits into one byte (e.g. `'1','a'` → `0x1a`).

**`isLinkedTo` (661–664).** Any up link with this node id?

**`compare` (666–673).** Compares two byte lists like dictionary order. `& 0xff` is needed because
Java bytes are **signed** (−128 to 127); this turns them into 0–255 so `0xff` counts as bigger
than `0x01`.

**`connect` (675–696).**
1. Create a `"c:"` link (not up), mark it pending, forget `firstSeen`.
2. `connectGatt(context, false, gattCallback, TRANSPORT_LE)` — connect now (`false` = don't wait
   for the device to come back later), and force BLE (not classic Bluetooth) on Android 6+.
3. Couldn't even start → fail.
4. Set a 12 s timeout: if the link still isn't up, fail.

**`centralLink` (698–701).** Find our `"c:"` link for this connection **and** check it's the same
connection object. Late callbacks from an old, dead connection are ignored this way.

**`gattCallback` (703–809)** — the connection steps, each triggered by the previous one finishing:
1. `onConnectionStateChange` — connected → ask for a 517-byte MTU (if Android refuses to even ask,
   go straight to step 3). Anything else → fail. If there's no matching link, close the connection.
2. `onMtuChanged` — save the MTU, then discover services.
3. `onServicesDiscovered` — find our service, characteristic and CCCD. Any missing → fail. Then turn
   on notifications: `setCharacteristicNotification` (locally) **and** write "enable" to the CCCD
   (tells the other phone). Android 13+ uses a newer method; older uses `setValue` + `writeDescriptor`.
4. `onDescriptorWrite` — the switch was written:
   - error → fail;
   - cancel the 12 s timeout, clear pending;
   - at max links → remove;
   - otherwise **link up**: build the hello `[0xFF][node id]`, put it at the **front** of the queue
     (`addFirst`), tell JavaScript, start sending.
- `onCharacteristicWrite` — a write finished → `writeDone` → next frame.
- `onCharacteristicChanged` (two versions: one for Android 13+, one for 12 and older) → `received`:
  copy the bytes and, if the link is up, `onData` to JavaScript.

**`failLink` (812–815).** If the link never came up, set a 10 s cooldown for that address. Remove it.

**`removeLink` (817–836).** Full cleanup: remove from the map (only if it's still the current one),
cancel its timers, clear pending, disconnect and close the GATT connection, empty the queue. If it
had been up, tell JavaScript `linkDown`.

#### Sending (841–908)

**`send` (841–848).** Link must exist and be up; frame must be non-empty and not too big; queue must
have room. Add to the queue and `pump`.

**`pump` (851–870)** — sends the next frame, one at a time:
1. Busy, empty, or link gone → return.
2. Take the next frame. Central → `writeAsCentral`; peripheral → `notifyAsPeripheral`.
3. If Android said "busy, can't now":
   - put the frame back at the front and try again in 20 ms;
   - after 50 tries, **give up on that frame** (it's dropped) and move on to the next. The mesh
     layer in TypeScript handles lost frames.
4. Success → mark `busy` and set a 2 s safety timer that calls `writeDone` in case Android never
   reports completion.

**`writeDone` (872–877).** Cancel the safety timer, not busy, `pump` the next one.

**`writeAsCentral` (880–893).** Write without response to the other phone's characteristic (new API
on Android 13+, old API before).

**`notifyAsPeripheral` (896–908).** Send a notification from our characteristic to that device (new
vs old API). `@SuppressWarnings("deprecation")` silences warnings about the old methods, which are
still needed for older phones.

---

## 7. Swift code (iPhone app)

Folder: `frontend/ios/App/App/`. The Swift files are **twins of the Java files**. Where they're the
same, this section is shorter and points back to section 6; it explains where iOS differs.

### 7.1 [AppDelegate.swift](../frontend/ios/App/App/AppDelegate.swift) (44 lines) — template

Generated by Capacitor. `@UIApplicationMain` marks the app's starting point. The empty functions
are hooks iOS calls when the app launches, goes to background, etc.; we don't use them. The last
function tells iOS to use `SceneDelegate` to build the window. You can ignore this file.

### 7.2 [SceneDelegate.swift](../frontend/ios/App/App/SceneDelegate.swift) (24 lines)

Creates the app's window and puts `MainViewController` in it (lines 10–12).
`SceneDelegateProxy.shared...` passes things like opened links on to Capacitor. Mostly template.

### 7.3 [MainViewController.swift](../frontend/ios/App/App/MainViewController.swift) (10 lines)

The iOS version of `MainActivity.java`. `CAPBridgeViewController` is Capacitor's screen with the
web view. When Capacitor has loaded (`capacitorDidLoad`), register our plugin:
`bridge?.registerPluginInstance(BleMeshPlugin())`. (`bridge?` = only if the bridge exists.)

### 7.4 [BleMeshPlugin.swift](../frontend/ios/App/App/BleMeshPlugin.swift) — the bridge (183 lines)

Same job and same JavaScript API as `BleMeshPlugin.java`.

**Lines 1–3** — imports: Capacitor, CoreBluetooth (Apple's Bluetooth), UIKit (Apple's app framework).

**Lines 8–24.**
- `@objc(BleMeshPlugin)` — Capacitor finds the class and methods by name through Objective-C, so
  they must be marked `@objc`.
- `CAPPlugin, CAPBridgedPlugin, BleMeshEngineDelegate` — it's a Capacitor plugin, bridged, and it
  receives engine events.
- `jsName = "BleMesh"` — the name JavaScript uses.
- `pluginMethods` — iOS needs an explicit list of callable methods (Android used `@PluginMethod`).
  All return Promises.

**Line 26** — create the engine. **Lines 28–30** — `load()` sets `engine.delegate = self` so the
engine's events come here.

**`ensurePermissions` (34–40).** `DispatchQueue.main.async { }` = run on the main thread (Java's
`main.post`). Ask the engine; answer `{granted}` when it calls back.

**`start` (44–67).**
- `guard let service = ..., let characteristic = ... else { reject; return }` — parse both UUIDs;
  if either is invalid, reject.
- `call.getInt("maxLinks") ?? 7` — use 7 if not given.
- Start the engine; it calls back with an error code or nil. The `switch`:
  - `case nil:` → success;
  - `case "BLUETOOTH_OFF"?:` → the `?` means "a value that exists and equals this";
  - `case let code?:` → any other code.

**`stop` (69–74), `send` (78–90), `getState` (92–96).** Same as Java. `Data(base64Encoded:)` returns
nil for invalid base64.

**`enableBluetooth` (99–106).** iOS forbids apps from turning Bluetooth on, so it opens this app's
page in the Settings app.

**`getCapabilities`, `setPowerMode` (111–122).** Same as Java.

**`getBattery` (124–132).** Turn battery monitoring on (iOS requires it), read the level (−1 when
unknown, e.g. on the simulator → report 1.0) and whether it's charging or full.

**`getStorageKey` / `deleteStorageKey` (134–145).** Same as Java, via the Swift `SecureKeyStore`.
`do { try ... } catch { }` is Swift's try/catch.

**`stateObject` (147–158), `uuid` helper (160–164).** Build the state dictionary; parse a UUID string
(nil string → default; invalid → nil).

**Engine events → web (168–182).** Same as Java: `notifyListeners(...)`.

### 7.5 [SecureKeyStore.swift](../frontend/ios/App/App/SecureKeyStore.swift) (51 lines)

Same purpose as the Java version, but **simpler**: Apple's **Keychain** is itself an encrypted,
protected store, so the 32-byte key can be stored there directly. No wrapping key needed.

- **Line 8 — `enum SecureKeyStore`** with no cases: a Swift trick for "a namespace of static
  functions that can't be instantiated."
- **Lines 9–18 — `query`.** The "address" of our Keychain item: a generic password, service
  `com.demodiscord.app.mesh`, account `storage-key`.
- **`getOrCreate` (21–45).**
  - Lines 22–26: ask the Keychain for that item's data (one match). `&item` = "fill in this
    variable with the result."
  - Lines 27–29: found, and 32 bytes → return it.
  - Lines 30–32: any error other than "not found" → throw.
  - Lines 34–36: make 32 secure random bytes (`SecRandomCopyBytes`).
  - Line 38: delete any old/broken item first.
  - Lines 39–43: save it with `AfterFirstUnlockThisDeviceOnly`: readable once the phone has been
    unlocked after boot (so the mesh works with the screen locked), and **never** synced to iCloud or
    restored onto another phone.
- **`delete` (48–50).** Panic wipe: delete the item.

### 7.6 [BleMeshEngine.swift](../frontend/ios/App/App/BleMeshEngine.swift) — the iPhone Bluetooth engine (609 lines)

Same design as `BleMeshEngine.java`: advertise + scan, lower id connects, hello frame, max links,
cooldowns. Apple's API is shaped differently, so here's what each part does.

**Lines 5–10 — `protocol BleMeshEngineDelegate`.** The 4 events (Java's `Listener`). `AnyObject` =
only classes can be delegates (needed for `weak`).

**Lines 12–25 — comment.** The protocol from section 2 and its Android compatibility.

**Line 26 — `final class BleMeshEngine: NSObject`.** Must inherit `NSObject` because Apple's
Bluetooth delegate protocols come from Objective-C.

**Lines 28–37 — constants.** Same values as Java. `TimeInterval` = seconds.

**Lines 39–55 — `class Link`.** Same as Java's, with iOS types:
- `peripheral: CBPeripheral?` — when we're central, the phone we connected to. The comment says it
  "must be kept alive": if nothing holds this object, iOS disconnects.
- `central: CBCentral?` — when we're peripheral, the phone that connected to us.
- `maxFrameBytes = 20` (set when the link comes up), `connectTimer: DispatchWorkItem?` (a
  cancellable delayed task).

**Lines 57–61.** `weak var delegate` (the plugin; `weak` avoids the two objects keeping each other
alive forever). `private(set) var running/advertising/scanning` — readable by the plugin, only
changeable here.

**Power mode (63–107).**
- `setPowerMode` — same rules as Java. `guard next != powerMode else { return }` exits if unchanged.
  Cancel the old timer; if running and not foreground, start the duty cycle; start scanning if ready.
- `scheduleDuty(on:)` — a one-shot `Timer`. At the end of an "on" phase: pause scanning
  (`scanPaused = true`, `stopScan`) and schedule "off". At the end of an "off" phase: resume and
  schedule "on". `[weak self]` + `guard let self = self` = stop if the engine no longer exists.

**Lines 108–126 — fields.**
- `centralManager` (`CBCentralManager`) — iOS's object for the **central** role (scan, connect).
- `peripheralManager` (`CBPeripheralManager`) — iOS's object for the **peripheral** role
  (GATT server, advertise).
- `serverCharacteristic`, `serviceAdded`.
- settings, `links`, and `cooldownUntil` / `firstSeen` keyed by **UUID**: iOS hides Bluetooth MAC
  addresses for privacy and gives each device a random UUID instead.
- `pendingPeripheral` — the device we're connecting to.
- `permissionWaiters` — callbacks waiting for the permission answer. `pendingStart` — a `start()`
  waiting for Bluetooth to be ready.

**Managers and permission (131–162).**
- `createManagersIfNeeded` — create both managers (`queue: nil` = deliver events on the main queue,
  so no locks needed, as on Android). **Creating them is what shows iOS's permission prompt** the
  first time.
- `bluetoothOn` — a computed property: is the central manager's state `.poweredOn`?
- `ensurePermissions` — check `CBManager.authorization`:
  - `.allowedAlways` → true;
  - `.notDetermined` → never asked: save the callback, create the managers (prompt appears). The
    answer arrives later in `centralManagerDidUpdateState`, which calls `resolvePermissionWaiters`;
  - anything else (denied/restricted) → false.
- `resolvePermissionWaiters` — once there's an answer, call every waiting callback with it.

**Lifecycle (167–237).**
- **Why `start` waits:** on iOS, Bluetooth isn't ready the moment you create the manager. Its state
  starts as `.unknown` and changes a moment later. So `start` saves the callback in `pendingStart`
  and calls `evaluatePendingStart`, which is called again every time the state changes.
- `evaluatePendingStart` (180–211) — a `switch` on the state:
  - `.unknown`, `.resetting` → wait;
  - `.unsupported` → `"UNSUPPORTED"`; `.unauthorized` → `"PERMISSION"`; `.poweredOff` →
    `"BLUETOOTH_OFF"`;
  - `.poweredOn` → make a random 8-byte node id (`withUnsafeMutableBytes` gives direct access to the
    bytes to fill them), mark running, start scanning, add our service, report success;
  - `@unknown default` — for states Apple might add in future iOS versions.
- `stop` (213–231) — cancel timers, stop scanning and advertising, remove our service, remove all
  links, clear maps, report.
- `setError` — save, log (`NSLog`), report.

**State helpers (241–249).** `describeLinks` uses `filter` and `map`, exactly like JavaScript arrays.

**Sending (254–280) — this is where iOS differs most from Android.**
- `send` — same checks as Java, then add to queue and `pump`.
- `pump` — iOS doesn't do "one write, wait for callback." It has an **outgoing buffer**:
  - **central:** `while` there are frames **and** `canSendWriteWithoutResponse` is true, write the
    next one. When the buffer has room again, iOS calls `peripheralIsReady(toSendWriteWithoutResponse:)`,
    which calls `pump` again.
  - **peripheral:** `updateValue(...)` sends a notification and returns `false` if the buffer is full.
    Then stop; iOS later calls `peripheralManagerIsReady(toUpdateSubscribers:)`, which calls `pump`.
  So no busy flag, retries or timeouts are needed here.

**Links (284–347).**
- `failLink` — cooldown if never up (keyed by the peripheral's UUID), then remove.
- `removeLink` — `guard links[link.id] === link` (still the current one?), remove, cancel the timer,
  cancel the iOS connection, clear the queue, `linkDown` if it was up.
- `isLinked(to:)`, `compare` (uses `zip` to walk two lists side by side; Swift's `UInt8` is already
  0–255 so no `& 0xff` needed), `hex` (bytes → `"1a2b…"`), `dataFromHex` (the reverse, two characters
  at a time).
- `peerNodeId(from:)` — read service data or the `"M"+hex` name from the advertisement dictionary.
  `as? [CBUUID: Data]` = "try to treat this as a dictionary of UUID → bytes."

**Peripheral role (351–381).**
- `addServiceIfReady` — if running, not yet added and the peripheral manager is on: create the
  characteristic (write, write-without-response, notify; writeable) inside a primary service, and
  add it. iOS then calls `didAdd`, which starts advertising. (iOS creates the CCCD switch
  automatically; Android had to add it by hand.)
- `startAdvertising` — advertise our service UUID and local name `"M" + hex(nodeId)`. **iOS only
  allows these two things in an advertisement**, which is why the node id goes in the name.
- `peripheralLink(for:)` — get or create the `"p:"` link for a connected central.

**Central role (385–415).**
- `startScanIfReady` — scan for our service only. `AllowDuplicatesKey: true` = keep reporting the
  same phone every time it's heard (by default iOS reports each device once). Needed for the 15 s
  fallback: we have to see the phone again after 15 s to decide to connect.
- `connect` — create a `"c:"` link, mark pending, `peripheral.delegate = self` (so that phone's events
  come to us), `cm.connect(...)`. Then a 12 s `DispatchWorkItem` timer: if the link isn't up by then,
  fail it. `[weak self, weak link]` so the timer doesn't keep them alive.
- `centralLink` — find our link for this peripheral and check it's the same object.

**`extension BleMeshEngine: CBCentralManagerDelegate` (420–479)** — events of the central role:
- `centralManagerDidUpdateState` — Bluetooth state changed: answer permission waiters, continue a
  pending `start`. If running: on → start scanning; off → iOS drops every connection, so remove all
  central links.
- `didDiscover` — a phone was heard. Same decision logic as Java's `onFound` (pending? already
  linked? full? cooldown? own id? already linked by them? lower id rule with 15 s fallback?), then
  `connect`.
- `didConnect` — connected → discover our service. (No MTU request: iOS negotiates the MTU by itself.)
- `didFailToConnect`, `didDisconnectPeripheral` → `failLink`.

**`extension BleMeshEngine: CBPeripheralDelegate` (483–535)** — events from a phone we connected to:
- `didDiscoverServices` → find ours → discover our characteristic (else fail).
- `didDiscoverCharacteristicsFor` → save it → `setNotifyValue(true)`. On iOS this one call writes the
  CCCD switch for you.
- `didUpdateNotificationStateFor` — notifications are on → **link up**: cancel the timer, clear
  pending, check max links, set `maxFrameBytes` from `maximumWriteValueLength` (iOS tells you the
  usable size), put the hello first in the queue, tell JavaScript, `pump`.
- `didUpdateValueFor` — a notification arrived → `meshData` to JavaScript.
- `peripheralIsReady(toSendWriteWithoutResponse:)` — buffer has room → `pump`.

**`extension BleMeshEngine: CBPeripheralManagerDelegate` (539–608)** — events of our GATT server:
- `peripheralManagerDidUpdateState` — answer permission waiters. On → add the service. Off → iOS
  removes our service and subscribers, so reset flags and remove all peripheral links.
- `didAdd` — service added → start advertising (or set error).
- `DidStartAdvertising` — record success or set an error.
- `didSubscribeTo` — a phone turned on notifications → **link up** (iOS can't kick a connected phone,
  so if we're full we just don't use the link). Frame size from `maximumUpdateValueLength`.
- `didUnsubscribeFrom` → remove the link.
- `didReceiveWrite` — data written to us, possibly several at once. For each: hello → save node id;
  else → `meshData`. Then `respond` **once**, to the first request (Apple's rule for batches).
- `peripheralManagerIsReady(toUpdateSubscribers:)` — buffer has room → `pump` every peripheral link.

---

## 8. The story of one message

You type "hi" on **Phone A** (Android). Phone A is linked to **Phone B** (iPhone), which is linked to
your **PC**.

1. **TypeScript on A** builds a mesh packet (with signature, id, hop count), splits it into frames
   that fit `maxFrameBytes`, base64-encodes each, and calls `BleMesh.send({linkId: "c:…B…", data})`.
2. **BleMeshPlugin.java** decodes base64 → bytes → `engine.send(...)` → `{queued: true}`.
3. **BleMeshEngine.java** adds the frame to that link's queue and `pump`s it: A is central on this
   link, so it **writes** to B's characteristic.
4. **iPhone B**: `peripheralManager(_:didReceiveWrite:)` fires in **BleMeshEngine.swift**. Not a hello,
   so `meshData(...)`.
5. **BleMeshPlugin.swift** fires the JavaScript `data` event with base64.
6. **TypeScript on B** reassembles the packet, checks the signature, sees it's for the channel, shows
   "hi", and decides to **relay** it: calls `send` on its link to the PC.
7. On that link B is **peripheral** (the PC connected to B), so `pump` uses `updateValue` → a
   **notification** to the PC.
8. **mesh.go** on the PC: the notification callback from `EnableNotifications` runs → `emit("data", …)`.
9. **app.go**'s emit function sends the Wails event `blemesh:data` → **desktop.ts** → the same
   TypeScript mesh code → "hi" appears on the PC.

The native code never knew it was carrying "hi". It just moved bytes.

---

## 9. Files you can ignore

These were generated by tools and don't contain app logic:

| File | What it is |
|---|---|
| `android/.../test/.../ExampleUnitTest.java` | Sample test from the Capacitor template (checks 2+2=4). |
| `android/.../androidTest/.../ExampleInstrumentedTest.java` | Sample on-device test from the template. |
| `ios/App/App/AppDelegate.swift` | iOS app template (section 7.1). |
| `ios/App/CapApp-SPM/Package.swift` | Dependency list managed by the Capacitor CLI ("DO NOT MODIFY"). It says "use Capacitor 8.5.3 for iOS 15+." |
| `ios/App/CapApp-SPM/Sources/CapApp-SPM/CapApp-SPM.swift` | A 1-line placeholder that the package needs to exist. |

---

## 10. Cheat sheet

The same concept in all three languages, so you can recognise it anywhere.

| Concept | Go (desktop) | Java (Android) | Swift (iPhone) |
|---|---|---|---|
| Plugin JS calls | `App` in app.go, exposed by `Bind` | `BleMeshPlugin.java`, `@PluginMethod` | `BleMeshPlugin.swift`, `pluginMethods` list |
| Send event to JS | `runtime.EventsEmit(ctx, "blemesh:x", data)` | `notifyListeners("x", obj)` | `notifyListeners("x", data: dict)` |
| Answer a JS call | `return value, nil` / `return _, err` | `call.resolve(obj)` / `call.reject(msg, code)` | `call.resolve(dict)` / `call.reject(msg, code)` |
| Avoid two things changing data at once | `sync.Mutex` lock | everything posted to main thread (`handler.post`) | everything on main queue (`DispatchQueue.main`) |
| Delayed task | `time.AfterFunc` / `time.After` | `handler.postDelayed` | `DispatchQueue.main.asyncAfter` / `Timer` |
| Run in background | `go f()` | (Android does it for us) | (iOS does it for us) |
| Scan | `adapter.Scan(onScan)` | `scanner.startScan(filters, settings, callback)` | `scanForPeripherals(withServices:)` |
| Advertise | — (not possible) | `advertiser.startAdvertising(...)` | `startAdvertising([...])` |
| Node id in advert | — | service data in scan response | local name `"M" + hex` |
| Turn on notifications | `ch.EnableNotifications(cb)` | `setCharacteristicNotification` + write CCCD | `setNotifyValue(true, for:)` |
| Send as central | `WriteWithoutResponse` | `writeCharacteristic` | `writeValue(..., type: .withoutResponse)` |
| Send as peripheral | — | `notifyCharacteristicChanged` | `updateValue(...)` |
| One-at-a-time sending | a writer goroutine reading a channel | `busy` flag + `pump` + `writeDone` | `pump` until the buffer is full, iOS calls back |
| Secret storage key | DPAPI file (`storage.key`) | Keystore-wrapped key in SharedPreferences | Keychain item |
| Keep running in background | — | `MeshForegroundService` + notification | `bluetooth-central` / `bluetooth-peripheral` background modes in `Info.plist` (iOS still slows background scanning a lot) |
| Link id | `"c:" + address` | `"c:"`/`"p:"` + MAC address | `"c:"`/`"p:"` + device UUID |
