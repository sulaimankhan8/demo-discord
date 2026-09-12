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

## 📑 Complete Documentation Suite

Comprehensive technical deep-dives and guides are located in the [`docs/`](./docs) folder:

1. **[01. Architecture & Tech Stack](./docs/01_ARCHITECTURE_AND_TECH_STACK.md)**: Full breakdown of backend, frontend, database, and background processes.
2. **[02. WebRTC & Media Routing Deep Dive](./docs/02_WEBRTC_AUDIO_VIDEO_DEEP_DIVE.md)**: STUN, TURN, ICE, SFU multi-core architecture, SVC layers, and active speaker detection.
3. **[03. Real-Time Messaging & Distributed Scale](./docs/03_REALTIME_MESSAGING_AND_DISTRIBUTED_SCALE.md)**: 64-bit Snowflake IDs, Redis Streams write-behind pipeline, presence tracking, and BullMQ queues.
4. **[04. Engineering Approaches & Patterns](./docs/04_ENGINEERING_APPROACHES_AND_PATTERNS.md)**: Decoupled write pipelines, Dead Letter Queues, micro-batching, and client optimization.
5. **[05. Local Setup & Execution Guide](./docs/05_LOCAL_SETUP_AND_RUN_GUIDE.md)**: Detailed step-by-step installation, environment variables, multi-user local testing, and troubleshooting.
6. **[06. UI/UX Design System & Architectural Redesign](./docs/06_UI_UX_DESIGN_SYSTEM_AND_PROPOSALS.md)**: Studio-grade Obsidian dark design system, typography hierarchy, and acoustic stage layout.
7. **[07. High-Load Message Reactions Architecture](./docs/07_HIGH_LOAD_MESSAGE_REACTIONS_ARCHITECTURE.md)**: High-throughput distributed architecture for reactions: in-memory atomic Lua toggles, 250ms sliding-window fan-out coalescing, zero-join SQL schemas, and sharded counters.