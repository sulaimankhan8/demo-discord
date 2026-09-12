# Demo Discord — Architecture & Engineering Documentation

Welcome to the comprehensive technical documentation and architectural analysis for the **Demo Discord** project. This documentation breaks down all technologies used, architectural decisions, streaming pipelines, real-time communication protocols, and underlying computer science concepts (including WebRTC, STUN, ICE, SFU, SVC, Snowflake IDs, and Redis Streams).

---

## 📑 Documentation Index

| Document | Description |
| :--- | :--- |
| **[01. Architecture & Tech Stack](./01_ARCHITECTURE_AND_TECH_STACK.md)** | Full breakdown of backend, frontend, database, worker processes, and third-party tools. |
| **[02. WebRTC, Media Routing & Voice/Video Deep Dive](./02_WEBRTC_AUDIO_VIDEO_DEEP_DIVE.md)** | Clear conceptual and practical explanations of STUN, TURN, ICE, SFU vs MCU vs Mesh, Mediasoup internals, SVC, Simulcast, Audio Observers, and Bandwidth Control. |
| **[03. Real-Time Messaging & Distributed Scale](./03_REALTIME_MESSAGING_AND_DISTRIBUTED_SCALE.md)** | In-depth analysis of 64-bit Snowflake ID generation, Redis Streams ingestion pipeline, Pub/Sub clustering, Presence heartbeats, and BullMQ async queues. |
| **[04. Engineering Approaches & Production Patterns](./04_ENGINEERING_APPROACHES_AND_PATTERNS.md)** | Architectural patterns implemented: Decoupled write pipelines, Dead Letter Queues (DLQ), Micro-batching, Viewport-based media subscriptions, and Load testing. |
| **[05. Local Setup & Execution Guide](./05_LOCAL_SETUP_AND_RUN_GUIDE.md)** | Step-by-step instructions to configure, migrate, and run the backend, frontend, Redis, and workers locally. |
| **[06. UI/UX Design System & Architectural Redesign](./06_UI_UX_DESIGN_SYSTEM_AND_PROPOSALS.md)** | Studio-grade design system: Obsidian dark palettes, typography hierarchy, 3-column Discord shell, acoustic voice stage, and wireframe specs. |
| **[07. High-Load Message Reactions Architecture](./07_HIGH_LOAD_MESSAGE_REACTIONS_ARCHITECTURE.md)** | Distributed architecture specification for high-load reactions: In-memory atomic Lua toggles, 250ms sliding-window fan-out coalescing, zero-join database schemas, and sharded counters. |

---

## 🏗 High-Level System Topology

```mermaid
flowchart TD
    subgraph Clients["Clients (Next.js 16 + React 19)"]
        BrowserA["Client A (Desktop / Web)"]
        BrowserB["Client B (Desktop / Web)"]
        BrowserN["Client N (Desktop / Web)"]
    end

    subgraph EdgeLayer["Edge / Load Balancing"]
        Gateway["Express 5 / Socket.io Cluster"]
    end

    subgraph VoiceEngine["Voice & Video Engine (Mediasoup SFU)"]
        WorkerPool["Mediasoup Multi-Core Worker Pool (C++ Processes)"]
        Router["Router per Room (global-voice)"]
        AudioObserver["AudioLevelObserver (Active Speaker Detection)"]
    end

    subgraph MessagingEngine["High-Throughput Messaging & Reaction Engine"]
        SnowflakeGen["Distributed Snowflake ID Generator"]
        RedisStream["Redis Stream ('stream:messages')"]
        ReactionStream["Redis Stream ('stream:reactions')"]
        StreamWorker["Message Consumer Worker (Micro-batching)"]
        ReactionWorker["Reaction Consumer Worker (Micro-batching)"]
        DLQ["Dead Letter Queue (dlq:consumer:bad_messages)"]
    end

    subgraph StateAndStorage["Storage & Distributed State"]
        RedisCluster["Redis (PubSub + Presence + Reaction Hashes/Sets)"]
        PostgresDB["PostgreSQL (Drizzle ORM)"]
        BullMQQueues["BullMQ (Analytics & Notification Queues)"]
    end

    %% Client Interactions
    BrowserA <==>|WebSocket Signaling + Chat + Reactions| Gateway
    BrowserB <==>|WebSocket Signaling + Chat + Reactions| Gateway
    BrowserN <==>|WebSocket Signaling + Chat + Reactions| Gateway

    BrowserA <==>|WebRTC RTP / SRTP Media Streams| WorkerPool
    BrowserB <==>|WebRTC RTP / SRTP Media Streams| WorkerPool
    BrowserN <==>|WebRTC RTP / SRTP Media Streams| WorkerPool

    %% Voice pipeline
    Gateway -->|Manage Transports / Producers / Consumers| Router
    Router --> AudioObserver
    AudioObserver -->|Active Speaker Events| Gateway

    %% Chat pipeline
    Gateway -->|Generate Sortable ID| SnowflakeGen
    Gateway -->|XADD Message Payload| RedisStream
    Gateway -->|XADD Reaction Action| ReactionStream
    RedisStream -->|XREADGROUP Batch Ingestion| StreamWorker
    ReactionStream -->|XREADGROUP Batch Ingestion| ReactionWorker
    StreamWorker -->|Bulk Insert via Drizzle| PostgresDB
    ReactionWorker -->|Bulk UPSERT Counts & Audit| PostgresDB
    StreamWorker -->|Failed Payloads| DLQ
    Gateway <-->|Pub/Sub Socket Adapter & Presence| RedisCluster
    Gateway -->|Enqueue Jobs| BullMQQueues
```

---

## 🎯 Key Highlights of the Codebase

1. **Discord-Class Voice & Video (SFU via Mediasoup v3)**:
   - Eliminates client upload bottleneck using an SFU model.
   - Multi-core C++ worker orchestration running 1 worker per CPU core.
   - Scalable Video Coding (SVC) and Simulcast support with dynamic layer switching (spatial and temporal).
   - Real-time Audio Level Observer detecting active speakers to dynamically adjust video resolution and priority.

2. **Decoupled High-Throughput Chat Pipeline**:
   - Ingestion over WebSockets decoupled from database persistence.
   - Micro-batched Redis Streams (`XADD` / `XREADGROUP`) achieving thousands of messages per second.
   - Guaranteed at-least-once processing, consumer groups, automatic recovery, and Dead Letter Queue.

3. **Distributed Snowflake ID Generation**:
   - 64-bit k-sortable unique IDs based on Twitter's Snowflake algorithm.
   - Eliminates database primary key lock contention and enables chronological cursor pagination without offset performance degradation.

4. **Resilient Presence & PubSub Clustering**:
   - Redis-backed sliding window presence with heartbeat refreshing.
   - Socket.io Redis adapter enabling zero-downtime horizontal scaling across multiple Node.js instances.
