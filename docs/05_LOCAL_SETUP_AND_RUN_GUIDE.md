# Local Setup & Development Guide

This guide provides end-to-end instructions for installing, configuring, and running the **Demo Discord** application locally on your machine.

---

## 📋 Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Project Architecture & Port Mapping](#2-project-architecture--port-mapping)
3. [Environment Configuration](#3-environment-configuration)
4. [Database Setup & Schema Push](#4-database-setup--schema-push)
5. [Starting the Application Services](#5-starting-the-application-services)
   - [Step A: Start Redis](#step-a-start-redis)
   - [Step B: Start Backend API & Signaling Server](#step-b-start-backend-api--signaling-server)
   - [Step C: Start Frontend Web Client](#step-c-start-frontend-web-client)
   - [Step D: (Optional) Start Background Workers](#step-d-optional-start-background-workers)
6. [Testing the Multi-User Experience](#6-testing-the-multi-user-experience)
7. [Testing Across Local Network (Mobile / Other PCs)](#7-testing-across-local-network-mobile--other-pcs)
8. [Troubleshooting & Common Issues](#8-troubleshooting--common-issues)

---

## 1. Prerequisites

Make sure you have the following installed on your system:

| Tool / Runtime | Minimum Version | Purpose |
| :--- | :--- | :--- |
| **Node.js** | `v20.x` or `v22.x` (LTS recommended) | JavaScript/TypeScript runtime |
| **npm** / **npx** | `v10.x+` | Package manager & script runner |
| **Redis** | `v6.x+` (or Docker) | Pub/Sub, Presence, Redis Streams, BullMQ |
| **PostgreSQL** | `v14+` (or Neon DB / Docker) | Primary relational database |
| **Python 3.x & C++ Compiler** | (Optional / Windows Build Tools) | Required only if `mediasoup` builds from source |

> [!NOTE]
> On Windows, if `mediasoup` needs compiling, install Visual Studio C++ Build Tools or run `npm install --global --production windows-build-tools` in an elevated terminal. However, modern `mediasoup` comes with prebuilt binaries for most platforms.

---

## 2. Project Architecture & Port Mapping

When the entire stack is running locally:

| Service | Port | Description |
| :--- | :--- | :--- |
| **Next.js Frontend** | `3000` | UI, Voice Grid, Chat Box, Dynamic Equalizer |
| **Express Backend** | `4000` | REST API, Socket.io Server, Snowflake ID Generator |
| **Mediasoup SFU** | `2000 - 2020` (UDP/TCP) | WebRTC RTP/SRTP Media Transport Ports |
| **Redis Server** | `6379` | Distributed Cache, Streams (`stream:messages`), Presence |
| **PostgreSQL** | `5432` / Cloud | Drizzle ORM Relational Storage |

---

## 3. Environment Configuration

### A. Backend Configuration (`backend/.env`)

Create or update `backend/.env`:

```env
# Server Port
PORT=4000
NODE_ENV=development

# Mediasoup IP Binding (Use 127.0.0.1 for local host, or your LAN IP e.g., 192.168.1.5 for local network testing)
PUBLIC_IP="127.0.0.1"

# Redis Connection URL
REDIS_URL=redis://localhost:6379

# PostgreSQL Connection String (Neon DB or Local PostgreSQL)
# Example local postgres: postgresql://postgres:postgres@localhost:5432/discord_db
# Example Neon cloud DB: postgresql://username:password@ep-sample-pooler.aws.neon.tech/neondb?sslmode=require
DATABASE_URL="postgresql://neondb_owner:npg_3dChSj6bRvUT@ep-snowy-scene-ahlxjr0r-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
```

### B. Frontend Configuration (`frontend/.env.local`)

Create or update `frontend/.env.local`:

```env
# Socket.io Signaling & Chat Backend URL
NEXT_PUBLIC_SOCKET_URL=http://localhost:4000

# REST API URL
NEXT_PUBLIC_API_URL=http://localhost:4000
```

---

## 4. Database Setup & Schema Push

The backend uses **Drizzle ORM** with PostgreSQL.

1. Navigate to the backend directory and install dependencies:
   ```bash
   cd backend
   npm install
   ```

2. Push the schema to your database (creates tables: `users`, `channels`, `messages`, `reactions`):
   ```bash
   npx drizzle-kit push
   ```

   *(Alternative)* To generate SQL migration files:
   ```bash
   npm run generate
   ```

---

## 5. Starting the Application Services

To run the complete system, open 3 terminal tabs (or 4 if running background workers).

### Step A: Start Redis

#### Option 1: Using Docker (Recommended & Easiest)
```bash
docker run -d --name discord-redis -p 6379:6379 redis:alpine
```

#### Option 2: Using Local Redis CLI / Service
- **macOS / Linux**: `redis-server`
- **Windows (WSL / Native Redis)**: `redis-server` or start the Windows Redis Service.

To verify Redis is responding:
```bash
redis-cli ping
# Response should be: PONG
```

---

### Step B: Start Backend API & SFU Server

In **Terminal 1**:
```bash
cd backend
npm run dev
```

**Expected Output:**
```
[nodemon] starting `node src/server.js`
Connected to Redis
PostgreSQL Database connected via Drizzle ORM
✅ Consumer group created successfully.
Mediasoup SFU initialized with 8 Worker(s)
Backend running on port 4000
```

---

### Step C: Start the Stream Persister Workers *(Required for DB Persistence)*

Because the architecture decouples real-time ingestion from database writes:
- Chat messages are ingested via `stream:messages`.
- Reaction clicks are ingested via `stream:reactions`.

To persist messages and reactions into PostgreSQL, run the background consumers:

**In Terminal 2 (Chat Message Persister):**
```bash
cd backend
npm run streamWorker
```

**In Terminal 3 (Reaction Persister):**
```bash
cd backend
npm run reactionWorker
```

> [!NOTE]
> In real-time chat, messages and reactions are visible immediately via WebSockets and Redis in-memory stores even if workers are delayed. The workers ensure long-term durability in PostgreSQL.

---

### Step D: Start Frontend Web Client

In **Terminal 4**:
```bash
cd frontend
npm install
npm run dev
```

**Expected Output:**
```
  ▲ Next.js 16.1.4
  - Local:        http://localhost:3000
  - Environments: .env.local

 ✓ Ready in 1.2s
```

---

### Step E: (Optional) BullMQ Background Workers

If you wish to test asynchronous notification dispatch or analytics event ingestion:

- **Notification Worker**:
  ```bash
  cd backend
  npm run notificationWorker
  ```
- **Analytics Worker**:
  ```bash
  cd backend
  npm run analyticsWorker
  ```

---

## 6. Testing the Multi-User Experience

1. **Open User A**:
   - Open your browser to `http://localhost:3000`.
   - Enter `Alice` as username and select an avatar.
   - Click **"Launch Discord"** or jump directly into **"Voice & Video"**.

2. **Open User B (Incognito / Second Window)**:
   - Open an **Incognito / Private Window** or a different browser (e.g., Chrome + Firefox).
   - Navigate to `http://localhost:3000`.
   - Enter `Bob` as username.

3. **Real-Time Features to Verify**:
   - 💬 **Live Chat (`/chat`)**: Send messages between Alice and Bob. Notice the instant optimistic delivery, Snowflake ID ordering, hover emoji reactions, and message audio chime.
   - 🎙️ **Voice Channel (`/voice`)**: Join the voice channel in both windows. Allow microphone/camera permissions.
   - 🟢 **Active Speaker Visual Highlight**: Speak into the microphone. Notice how the active speaker tile **glows with emerald border and animates the 3-bar equalizer waveform in-place** without disruptive tile swapping.
   - 📹 **Camera & Screen Share**: Toggle webcam or screen sharing. Test dynamic video quality adjustments.
   - 🔊 **Sound FX**: Notice the custom audio chimes synthesized on join, leave, mute, and unmute.

---

## 7. Testing Across Local Network (Mobile / Other PCs)

To join from a phone or a laptop on the same Wi-Fi network:

1. **Find your computer's local IP address**:
   - **Windows**: Run `ipconfig` (Look for `IPv4 Address`, e.g., `192.168.1.50`).
   - **macOS / Linux**: Run `ifconfig` or `ip a` (e.g., `192.168.1.50`).

2. **Update `backend/.env`**:
   ```env
   PUBLIC_IP="192.168.1.50"
   ```

3. **Update `frontend/.env.local`**:
   ```env
   NEXT_PUBLIC_SOCKET_URL=http://192.168.1.50:4000
   NEXT_PUBLIC_API_URL=http://192.168.1.50:4000
   ```

4. **Restart Backend and Frontend**:
   ```bash
   # In frontend:
   npm run dev -- -H 0.0.0.0
   ```

5. **Connect from Mobile Browser**:
   - Navigate to `http://192.168.1.50:3000` on your phone browser.

> [!IMPORTANT]
> Modern mobile browsers (Chrome/Safari) require **HTTPS** for camera and microphone access on non-localhost IPs. For full mobile WebRTC testing, either use `localhost` port forwarding (via `adb reverse tcp:3000 tcp:3000` on Android) or run Next.js with HTTPS (`next dev --experimental-https`).

---

## 8. Troubleshooting & Common Issues

### 1. `Error: connect ECONNREFUSED 127.0.0.1:6379`
- **Cause**: Redis server is not running.
- **Fix**: Run `docker run -d -p 6379:6379 redis:alpine` or start the local Redis service.

### 2. `ICE Connection Failed` / WebRTC video not loading
- **Cause**: Mediasoup cannot route RTP traffic to `PUBLIC_IP`.
- **Fix**: Verify `PUBLIC_IP="127.0.0.1"` in `backend/.env` when testing locally on the same machine. Ensure UDP ports `2000-2020` are not blocked by a local firewall.

### 3. `Failed to push Drizzle schema / Database connection timeout`
- **Cause**: Invalid PostgreSQL credentials or network firewall blocking outbound port `5432`.
- **Fix**: Test your `DATABASE_URL` connection in `backend/.env`. If using Neon DB, ensure `sslmode=require` is present in the connection string.

### 4. `Consumer / Producer memory leaks on client refresh`
- **Cause**: Unclosed Mediasoup transport.
- **Fix**: The application includes explicit `voice:closeConsumer` event listeners and React unmount cleanup hooks in `frontend/components/VoiceRoom.tsx` to automatically release C++ worker memory.

---

## 🚀 Quick Reference Commands Cheat Sheet

```bash
# Clone & Enter
git clone <repo-url>
cd demo-discord

# Backend Setup
cd backend
npm install
npx drizzle-kit push
npm run dev

# Frontend Setup (New Terminal)
cd frontend
npm install
npm run dev

# Redis Quick-start
docker run -d -p 6379:6379 redis:alpine
```
