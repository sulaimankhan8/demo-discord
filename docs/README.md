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

    subgraph MessagingEngine["High-Throughput Messaging Engine"]
        SnowflakeGen["Distributed Snowflake ID Generator"]
        RedisStream["Redis Stream ('stream:messages')"]
        StreamWorker["Stream Consumer Worker (Micro-batching)"]
        DLQ["Dead Letter Queue (dlq:consumer:bad_messages)"]
    end

    subgraph StateAndStorage["Storage & Distributed State"]
        RedisCluster["Redis (PubSub + Presence + RateLimiter + Stream)"]
        PostgresDB["PostgreSQL (Drizzle ORM)"]
        BullMQQueues["BullMQ (Analytics & Notification Queues)"]
    end

    %% Client Interactions
    BrowserA <==>|WebSocket Signaling + Chat| Gateway
    BrowserB <==>|WebSocket Signaling + Chat| Gateway
    BrowserN <==>|WebSocket Signaling + Chat| Gateway

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
    RedisStream -->|XREADGROUP Batch Ingestion| StreamWorker
    StreamWorker -->|Bulk Insert via Drizzle| PostgresDB
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
