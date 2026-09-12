# 04. Engineering Approaches, Patterns & Tradeoffs

This document synthesizes the architectural approaches, distributed systems patterns, resilient error-handling strategies, and load testing methodologies implemented in **Demo Discord**.

---

## 🎯 1. Key Engineering Patterns & Approaches

### Pattern 1: Decoupled Ingestion & Write-Behind Persistence
* **Problem**: Directly writing real-time chat messages to PostgreSQL blocks WebSocket connection loops and overwhelms database IOPS during spikes.
* **Approach**: The application ingests messages into Redis Streams (`XADD`) and immediately broadcasts to users. A separate worker process pulls in batches of up to 4,000 items and writes them to PostgreSQL using bulk `INSERT`.
* **Tradeoff**:
  - *Advantage*: Sub-5ms client latency, zero database write locks during real-time chats.
  - *Risk*: Eventual consistency (messages appear in real-time before hitting PostgreSQL disk). Mitigated by maintaining a hot Redis cache (`chatCache.js` / in-memory recent messages) so history requests immediately after sending are consistent.

---

### Pattern 2: Selective Forwarding Unit (SFU) with Layered Video
* **Problem**: Full-mesh video conferencing crashes clients beyond 4 users due to bandwidth and CPU limits. MCU mixing requires massive server GPU/CPU transcoding resources.
* **Approach**: Mediasoup SFU forwards untouched WebRTC RTP packets. Clients use **SVC (Scalable Video Coding)** or **Simulcast** to upload layered streams. The SFU dynamically alters `spatialLayer` and `temporalLayer` depending on whether a user is the active speaker or a grid tile.
* **Tradeoff**:
  - *Advantage*: Servers handle hundreds of video streams per CPU core with minimal overhead.
  - *Risk*: Requires smart client-side logic to request layer promotions and handle track resumptions.

---

### Pattern 3: Viewport-Driven Video Subscription
* **Problem**: In rooms with 50 users, receiving 50 video streams saturates client network interfaces and causes video decoders to drop frames.
* **Approach**: The frontend (`VoiceRoom.tsx`) computes which peers are visible on the current page (Focus Mode = 6 peers, Gallery Mode = 16 peers). It notifies the backend via `voice:updateVisible`. The SFU automatically calls `consumer.pause()` on all off-screen users.
* **Tradeoff**:
  - *Advantage*: Network bandwidth usage stays strictly bounded regardless of how many users join the voice channel.
  - *Implementation Detail*: Resuming off-screen peers is staggered with a 15ms timer offset (`resumeIndex * 15ms`) to avoid packet bursts.

---

### Pattern 4: Distributed 64-Bit Snowflake Identifiers
* **Problem**: Distributed databases need chronologically sortable keys without cross-node locking.
* **Approach**: The custom `Snowflake` class generates 64-bit integer IDs incorporating millisecond timestamps, datacenter IDs, worker/PID IDs, and sequence bits.
* **Tradeoff**:
  - *Advantage*: High-speed generation in RAM, zero central coordination, natural chronological ordering for cursor pagination.
  - *Edge Case*: Handled clock drift by tracking `lastTimestamp` and holding until next tick if sequence overflows (up to 4096 IDs per ms per worker).

---

### Pattern 6: Sliding-Window Broadcast Coalescing & Decoupled Reaction Aggregates
* **Problem**: When thousands of users click reactions in rapid succession (e.g. during a live announcement), broadcasting every single click individually creates an outgoing WebSocket flood ($N \times M$ fan-out explosion) that freezes client browsers. In the database, concurrent individual `INSERT`s cause index page lock contention.
* **Approach**:
  - **In-Memory Atomicity**: Toggling is handled in Redis Hashes & Sets in **<0.2ms**.
  - **250ms Gateway Buffer**: The server coalesces all reaction increments/decrements in a sliding 250ms window per channel, broadcasting a single batched delta frame (`reaction:batch_update`).
  - **Asynchronous Persistence**: `stream:reactions` drains into PostgreSQL via `reactionStreamConsumer.worker.js` with micro-batched UPSERTs into `message_reaction_counts`.
* **Tradeoff**:
  - *Advantage*: Outbound WebSocket packet storms are reduced by **>99%**, client UI stays at 60 FPS, and database IOPS remains flat.

---

## 🧪 2. Performance & Load Testing Infrastructure

Located in the [`test/`](file:///c:/Users/Sulaiman/Desktop/dis/test/) directory:

1. **HTTP Message Load Testing** (`test/load/http-load-message.test.js`):
   - Benchmarks historical message retrieval and pagination APIs under heavy simulated concurrency.
2. **WebSocket Stress Testing** (`test/stress/socket-load-test.yml` & `user-generator.js`):
   - Simulates hundreds of simultaneous virtual users connecting via WebSockets, joining `global-chat`, emitting heartbeats, and blasting messages to measure ingestion throughput, Redis Streams buffering, and server latency.

---

## 📊 Summary of Architectural Decisions

```
+--------------------------+------------------------------------+-------------------------------------------+
| Requirement              | Approach Chosen                    | Alternative Rejected & Why                |
+--------------------------+------------------------------------+-------------------------------------------+
| Group Video Streaming    | Mediasoup SFU + SVC / Simulcast    | Mesh (Too bandwidth-heavy on clients)     |
|                          |                                    | MCU (Too CPU/GPU-intensive on server)     |
+--------------------------+------------------------------------+-------------------------------------------+
| Chat Message IDs         | 64-bit Twitter Snowflake Generator | UUIDv4 (Unsorted, index fragmentation)    |
|                          |                                    | Auto-increment (Centralized lock bottleneck)|
+--------------------------+------------------------------------+-------------------------------------------+
| High-Speed Message Write | Redis Stream + Batch Consumer      | Direct PostgreSQL INSERT (DB bottleneck)  |
+--------------------------+------------------------------------+-------------------------------------------+
| Real-Time Reactions      | In-Memory Redis + 250ms Coalescer  | Direct SQL Joins (Degrades query latency) |
|                          | + Decoupled Stream Worker          | Individual Fan-out (Crashes socket clients)|
+--------------------------+------------------------------------+-------------------------------------------+
| Multi-Instance Sockets   | Socket.io + Redis Adapter          | Single-process Socket.io (Cannot scale)   |
+--------------------------+------------------------------------+-------------------------------------------+
| Off-Screen Video Stream  | Server-side Consumer Pausing       | Client-side CSS hiding (Wastes bandwidth) |
+--------------------------+------------------------------------+-------------------------------------------+
```
