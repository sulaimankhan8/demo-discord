# 🎙️ Demo Discord — Real-Time Voice, Video & Chat Engine

A scalable, high-throughput Discord clone built with **Next.js 16 (React 19)**, **Express 5**, **Mediasoup v3 SFU**, **Redis Streams**, and **PostgreSQL (Drizzle ORM)**.

---

## 🚀 Quick Start (Run Locally)

### 1. Start Redis
```bash
docker run -d --name discord-redis -p 6379:6379 redis:alpine
```

### 2. Start Backend API & SFU Server
```bash
cd backend
npm install
npx drizzle-kit push
npm run dev
```

### 3. (Optional) Start Stream & Reaction Persister Workers
To persist messages and reactions into PostgreSQL:
```bash
# In separate terminals:
npm run streamWorker      # Chat message persistence
npm run reactionWorker    # Message reaction persistence
```

### 4. Start Frontend Client
```bash
cd frontend
npm install
npm run dev
```

Visit **`http://localhost:3000`** in your browser.

---

## 📱 Mobile Apps (Android APK & iOS)

The phone apps are the same Next.js frontend wrapped with **Capacitor 8**, plus native Bluetooth mesh plugins (`frontend/android/`, `frontend/ios/`). The normal web build (`npm run dev` / `npm run build`) is not affected by any of this.

### One-time setup (both platforms)
```bash
cd frontend
npm install
cp .env.capacitor.example .env.capacitor
```
Edit `frontend/.env.capacitor` and set the backend address the phone should use. On a phone, `localhost` is the phone itself, so use:
- Real phone on your Wi-Fi: `http://<your PC's Wi-Fi IP>:4000` (find it with `ipconfig`)
- Android emulator: `http://10.0.2.2:4000`
- Production: your `https://` server, with `CAP_ALLOW_HTTP=false`

> The backend URL is baked into the app at build time. If you change `.env.capacitor`, rebuild the app.

### 🤖 Build the Android APK

**Requirements:** Android Studio (with the Android SDK) and **JDK 21** exactly. JDK 17 is too old and the JDK 25 bundled with Android Studio is too new for Gradle 8.14. In Android Studio: *Settings → Build Tools → Gradle → Gradle JDK → Download JDK → 21*. For command-line builds, point `JAVA_HOME` at a JDK 21.

1. **Build the web app and copy it into the Android project:**
   ```bash
   npm run build:app
   ```
2. **Compile the APK** — either:
   - Android Studio: `npm run app:open`, then *Build → Build App Bundle(s) / APK(s) → Build APK(s)*, or
   - Command line (from `frontend/android`):
     ```bash
     ./gradlew assembleDebug
     ```
     (PowerShell / cmd: `.\gradlew.bat assembleDebug`)

   The APK is written to `frontend/android/app/build/outputs/apk/debug/app-debug.apk`.
3. **Install it on a phone** (USB debugging on, phone plugged in):
   ```bash
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```
   Or copy the APK to the phone and open it (allow "install unknown apps"). Shortcut for steps 2–3: `npm run app:run` builds and launches on a connected phone.

**Release APK:** Android Studio → *Build → Generate Signed App Bundle / APK*, create or pick a keystore, choose *APK → release*. Use an `https` backend for release builds.

### 🍎 Build the iOS app (Mac only)

**Requirements:** a Mac with Xcode and Node 22. Swift can't be compiled on Windows.

1. Do the one-time setup above on the Mac (set the backend to the Mac's Wi-Fi IP or your server).
2. **Build and copy into the iOS project, then open Xcode:**
   ```bash
   npm run build:ios
   npm run ios:open
   ```
3. In Xcode: select the **App** target → *Signing & Capabilities* → choose your **Team** (a free Apple ID works, but the app expires after 7 days).
4. Plug in the iPhone, select it as the run target, and press **Run** (▶). On the phone, trust the developer under *Settings → General → VPN & Device Management*.

### 📤 Sharing the iOS app

| Way | Cost | Who can install | How long it lasts |
|---|---|---|---|
| Xcode → Run (above) | Free | Phones plugged into your Mac | 7 days, then Run again |
| **AltStore** (below) | Free | Anyone with an Apple ID and a PC or Mac | 7 days, refreshed automatically over Wi-Fi |
| TestFlight / Ad Hoc | $99/year Apple Developer account | Up to 10,000 testers by link (TestFlight) | 90 days (TestFlight), 1 year (Ad Hoc) |

> The website works in Safari for chat and voice, but **not** for the Bluetooth mesh: Safari can't use Bluetooth, so mesh on iPhone needs the app.

#### Free: share an `.ipa` with AltStore

With a free Apple ID you can't send someone an `.ipa` that installs by tapping it. With AltStore, each person installs it with **their own** Apple ID, and AltStore signs it on their phone.

**Step 1 — Make the `.ipa` (you, on the Mac).** Build it unsigned; AltStore signs it later. From `frontend/`:
```bash
npm run build:ios
cd ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Release -sdk iphoneos -derivedDataPath build CODE_SIGNING_ALLOWED=NO
mkdir -p Payload
cp -R build/Build/Products/Release-iphoneos/App.app Payload/
zip -r DemoDiscord.ipa Payload
rm -rf Payload
```
This gives you `frontend/ios/App/DemoDiscord.ipa`. Send it to testers by AirDrop, Google Drive, WhatsApp or similar. An `.ipa` is just a zip file with a `Payload/App.app` folder inside.

> Set the backend in `.env.capacitor` to a server the testers can reach (your deployed `https` server) before building. Your home Wi-Fi IP only works on your Wi-Fi.

**Step 2 — Install AltStore (each tester, once).** They need a Windows PC or Mac and a USB cable.
1. **Windows:** install **iTunes** and **iCloud** from apple.com, *not* the Microsoft Store versions. **Mac:** nothing extra.
2. Download and install **AltServer** from [altstore.io](https://altstore.io) and start it (it sits in the system tray / menu bar).
3. Plug in the iPhone, unlock it, and tap **Trust** on the phone.
4. Click the AltServer icon → **Install AltStore** → pick the iPhone → sign in with an Apple ID. A spare Apple ID is fine.
5. On the iPhone: *Settings → General → VPN & Device Management* → trust that Apple ID.
6. On iOS 16 or newer: *Settings → Privacy & Security → Developer Mode* → turn it on and restart.

**Step 3 — Install the app (each tester).**
1. Save `DemoDiscord.ipa` to the iPhone's **Files** app.
2. Open **AltStore** → **My Apps** → **+** → pick `DemoDiscord.ipa`. It installs in under a minute.
3. Open the app and allow Bluetooth, microphone and local network when it asks.

**Keeping it working:**
- The app stops opening after **7 days**. AltStore refreshes it automatically when the phone and the computer running AltServer are on the same Wi-Fi. They can also open AltStore → **My Apps** → **Refresh All**.
- A free Apple ID allows **3 apps** at once, and AltStore itself counts as one.
- **New version:** send the new `.ipa` and install it the same way. It replaces the old one and keeps its data.
- [SideStore](https://sidestore.io) works the same way but refreshes without a computer after the first setup.

#### Paid: TestFlight
With an Apple Developer account, in Xcode pick *Any iOS Device* → *Product → Archive* → *Distribute App* → **TestFlight** (or **Ad Hoc** for specific registered phones). Testers install it from Apple's TestFlight app using a link.

### ⬇️ APK download on the website

The web version shows a **Download APK** button (login page, Hub, and a download icon in the phone top bar) once an APK has been published. Inside the installed app the button is hidden, and iPhone visitors are told the app is Android only.

```bash
cd frontend
npm run apk        # web build -> cap sync -> Gradle assembleDebug -> copy to public/downloads/
npm run apk:copy   # only copy the last built APK into public/downloads/
```

- `npm run apk` finds a JDK 21 by itself (`JAVA_HOME` if it is 21, otherwise Android Studio's download in `~/.jdks`).
- It writes `public/downloads/demo-discord.apk` and `public/downloads/apk.json` (version and size, shown on the button). Commit both files and push; Vercel then serves them.
- `public/downloads/` is committed so hosts that build from git (Vercel) serve the APK. Commit it again after each `npm run apk`. `build:app` / `build:ios` strip it from the phone app, so the APK never ends up inside itself.
- The published APK is a **debug** build. For a public release, make a signed release APK (Android Studio → *Generate Signed App Bundle / APK*) and bump `versionCode`.

### 🔁 Building and testing a new version

Each time the code changes:

1. Pull the latest code and run `npm install` in `frontend/` (in case dependencies changed).
2. Run the mesh tests first: `npm run test:mesh`.
3. Rebuild: `npm run build:app` (Android) or `npm run build:ios` (iOS). Skipping this step leaves the **old** web code inside the app.
4. Compile and install as above. `adb install -r` replaces the old app and keeps its data.
   - If install fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, the old APK was signed on a different PC. Uninstall it first: `adb uninstall com.demodiscord.app` (this deletes the app's local data and mesh identity).
   - For a release you hand out, bump `versionCode` (and `versionName`) in `frontend/android/app/build.gradle` so phones accept it as an update.
5. Install the same build on **every** test phone, so they all run the same mesh code.

**What to check on the phones:**
- **Online:** log in, send a message, react, join voice (allow the microphone).
- **Mesh, 2 phones:** airplane mode on, Bluetooth on, open **Mesh** on both, allow Bluetooth/notifications, chat both ways. The status should show "1 link".
- **Relay, 3 phones in a line:** A and C out of range of each other; A's message should reach C as "2 hops" and B's **Relayed** count should go up. Repeat with B's screen off.
- **Late joiner:** chat on A and B, then bring C into range; C should get the earlier messages.
- **iPhone ↔ Android:** chat both ways, then with the iPhone app in the background (slower on iOS by design).
- **Power & key storage:** the side panel's "This device" should show the power mode and "device-sealed"; below 20 % battery (not charging) the pill should show 🔋.
- **Debug logs (Android):** `adb logcat -s BleMesh`.

More detail and the full release test checklist: [08. Offline BLE Mesh Plan](./docs/08_OFFLINE_BLE_MESH_IMPLEMENTATION_PLAN.md) and [10. Mesh Channels Plan](./docs/10_MESH_CHANNELS_IMPLEMENTATION_PLAN.md).

---

## 📑 Complete Documentation Suite

Comprehensive technical deep-dives and guides are located in the [`docs/`](./docs) folder:

1. **[01. Architecture & Tech Stack](./docs/01_ARCHITECTURE_AND_TECH_STACK.md)**: Full breakdown of backend, frontend, database, and background processes.
2. **[02. WebRTC & Media Routing Deep Dive](./docs/02_WEBRTC_AUDIO_VIDEO_DEEP_DIVE.md)**: STUN, TURN, ICE, SFU multi-core architecture, SVC layers, and active speaker detection.
3. **[03. Real-Time Messaging & Distributed Scale](./docs/03_REALTIME_MESSAGING_AND_DISTRIBUTED_SCALE.md)**: 64-bit Snowflake IDs, Redis Streams write-behind pipeline, presence tracking, and BullMQ queues.
4. **[04. Engineering Approaches & Patterns](./docs/04_ENGINEERING_APPROACHES_AND_PATTERNS.md)**: Decoupled write pipelines, Dead Letter Queues, micro-batching, and client optimization.
5. **[05. Local Setup & Execution Guide](./docs/05_LOCAL_SETUP_AND_RUN_GUIDE.md)**: Detailed step-by-step installation, environment variables, multi-user local testing, and troubleshooting.
6. **[06. UI/UX Design System & Architectural Redesign](./docs/06_UI_UX_DESIGN_SYSTEM_AND_PROPOSALS.md)**: Studio-grade Obsidian dark design system, typography hierarchy, and acoustic stage layout.
7. **[07. High-Load Message Reactions Architecture](./docs/07_HIGH_LOAD_MESSAGE_REACTIONS_ARCHITECTURE.md)**: High-throughput distributed architecture for reactions: in-memory atomic Lua toggles, 250ms sliding-window fan-out coalescing, zero-join SQL schemas, and sharded counters.