# Mesh Channels — Implementation Plan

The build plan for channels, private channels, smarter relaying, the internet bridge, DMs and battery work in the offline BLE mesh. It turns the research in [09_MESH_CHANNELS_RESEARCH.md](09_MESH_CHANNELS_RESEARCH.md) into concrete steps, files and tests. The original mesh plan (Phases 0–7, the rules for leaving Chat/Voice alone) is [08_OFFLINE_BLE_MESH_IMPLEMENTATION_PLAN.md](08_OFFLINE_BLE_MESH_IMPLEMENTATION_PLAN.md).

---

## 0. Start here (for a fresh chat)

**Read first:** this file, then §12 of doc 08 (rules), then `frontend/lib/mesh/router.ts` and `packet.ts`.

**Where things stand (2026-10-29):**
- Phases 1–4 of doc 08 are done and tested on real phones: Android ↔ Android, 3 phones in a line (relay + late catch-up), iPhone ↔ Android.
- Phase 0 (the Android app running Text Chat + Voice like the website) still needs its device check.
- **C0–C7 are built** (browser-tested; phone checks still to do; C7's native code written but not yet compiled into an app; QR scanning deferred; C6b Noise XX not started). Next: build the apps and run the phone tests in §5. Design overview: the "Offline Mesh: Design & Architecture" doc.

**Ground rules (unchanged from doc 08 §12):**
- Text Chat, Voice and the backend aren't touched, except for C5 (bridge), which only **adds** backend files plus one line.
- Mesh code never uses Socket.IO (`getSocket()`), and chat/voice code never imports mesh code.
- Mesh storage stays in its own IndexedDB database `mesh-db` and `mesh:`-prefixed `localStorage` keys.
- Before each merge: `cd frontend && npm run test:mesh && npm run lint && npm run build`, plus the import grep in doc 08 §12.

**Each step ends with:** tests green, a short "Status / Verified" note added under that step here (same style as doc 08), and a commit `NN <short description>` (the repo's numbering continues from `87`).

**Decisions already made:**
| Topic | Decision |
| :--- | :--- |
| Channel = server? | **No.** Every phone relays every packet. A channel is a tag on packets; any member can sync history |
| Discovery | Over the mesh (`CHANNEL_ANNOUNCE` packets), **not** in Bluetooth adverts (too small; iOS can't add data) |
| Channel kinds | Lobby (built in), Public, Password, Private, Hidden |
| Group encryption | **Epoch keys** sealed to each member's X25519 key. New epoch on remove, not on join. MLS deferred |
| New member history | **Owner's choice per channel**, default **recent** (old epoch keys within retention are handed over) |
| Long distance | Internet bridge (C5): a phone with internet forwards its channels' encrypted packets through a small relay |
| Separated members | Channel lives on every member's phone; messages wait in the outbox; nothing closes while people are away |

**Change from doc 09:** there is **no separate channel key pair**. A channel is signed by its owner's normal identity key, and `channelId = SHA-256(ownerKey ‖ nonce)[0..16]`, so nobody can announce a fake copy of the same ID. Admin actions are signed by admins' identity keys. This is simpler and loses nothing.

---

## 1. What exists today (code map)

| File | What it does now | Changes in |
| :--- | :--- | :--- |
| `lib/mesh/packet.ts` | v1 header: version, type, ttl, flags (recipient / signed / link-local), timestamp, 8 B id, 32 B sender key, optional recipient, payload, Ed25519 signature | C0 |
| `lib/mesh/payloads.ts` | `MESSAGE` = nick + text, `ANNOUNCE` = nick, `SYNC` = list of ≤200 ids | C0, C1, C3 |
| `lib/mesh/router.ts` | Flood (TTL 7), dedup (`SeenCache`), verify, deliver, relay with 10–80 ms jitter and 20/s token bucket, one global `history` (200 / 12 h), link-local `SYNC` | C0, C1, C4 |
| `lib/mesh/MeshService.ts` | Glues transport, framing, router, store; peers; snapshot for the UI | C1, C3, C5 |
| `lib/mesh/store.ts` | `mesh-db` v1, one `messages` store keyed by id | C0 |
| `lib/mesh/identity.ts` | Ed25519 key in `localStorage` (`mesh:` key), fingerprint | C3 (X25519 helpers) |
| `lib/mesh/crypto.ts` | `signPacket` / `verifyPacket` | — |
| `lib/mesh/fragment.ts`, `seenCache.ts`, `bytes.ts` | Per-link framing, dedup cache, helpers | — |
| `lib/mesh/transports/*` | `LinkTransport` interface, `DevLinkTransport` (browser tabs), `BleLinkTransport` (native plugin) | C5 adds two |
| `components/mesh/*` | `MeshRoom`, `MeshMessageList`, `MeshComposer`, `MeshSidebar` | C1, C3 |
| `lib/mesh/__tests__/*` | packet, fragment, BLE transport, 20-node simulation | every step |
| Native plugins (Java / Swift) | Links and raw bytes only | **No changes planned** |

Libraries already installed: `@noble/curves` 2.x (has `ed25519.utils.toMontgomery` / `toMontgomerySecret` for X25519), `@noble/hashes` 2.x (has `hkdf`, `hmac`, `argon2`, `scrypt`), `idb`. **To add in C2:** `@noble/ciphers` (XChaCha20-Poly1305).

---

## 2. Target protocol (v2)

### 2.1 Packet header

Bump `PROTOCOL_VERSION` to **2**. All phones must be updated together; v1 phones drop v2 packets. Layout:

| Field | Size | Notes |
| :--- | :--- | :--- |
| version | 1 | `2` |
| type | 1 | see 2.2 |
| ttl | 1 | not signed (as today) |
| flags | 1 | bit0 recipient · bit1 signed · bit2 link-local · **bit3 encrypted** · **bit4 has channel** |
| timestamp | 8 | ms |
| messageId | 8 | random |
| senderKey | 32 | Ed25519 |
| **channelTag** | 16 | only if bit4. No tag = Lobby |
| recipientId | 8 | only if bit0 (first 8 B of the recipient's fingerprint) |
| length | 2 | |
| payload | n | plain or ciphertext |
| signature | 64 | over everything with ttl = 0 (as today) |

**Forward compatibility (new rule):** a v2 router that sees an **unknown type** or **unknown flag bits** still verifies the signature and **relays** the packet; it just doesn't deliver it. Version must still be ≥ 2. This lets later steps add packet types without breaking older phones' relaying.

### 2.2 Packet types

| # | Type | Flood / link-local | Signed by | Step |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `ANNOUNCE` | both (as today) | sender | — |
| 2 | `LEAVE` | flood | sender | — |
| 3 | `MESSAGE` | flood | sender | C0 payload change; channel via flag |
| 4 | `SYNC` | link-local | sender | C1 new format |
| 5 | `CHANNEL_ANNOUNCE` | flood | any member; carries the owner-signed manifest | C1 |
| 6 | `JOIN_REQUEST` | flood | requester | C3 |
| 7 | `KEY_GRANT` | flood, has recipient | an admin | C3 |
| 8 | `EPOCH_CHANGE` | flood | an admin | C3 |
| 9 | `MEMBERS` | flood | an admin | C3 |
| 10 | `DM` | flood, has recipient, encrypted | sender | C6 |
| 11 | `ACK` | flood, has recipient | recipient | C6 |

### 2.3 Payloads

- **MESSAGE v2:** `[senderSeq u32][nickLen u8][nick][text]`. `senderSeq` is a per-identity counter saved in `localStorage` (`mesh:seq`). It lets a member notice "I'm missing messages 41–43 from Bob" (used by C4 sync). In encrypted channels this whole payload is the plaintext.
- **Manifest** (C1): `[nonce 16][ownerKey 32][createdAt u64][kind u8][historyPolicy u8][retentionHours u16][maxMessages u16][nameLen u8][name][descLen u8][desc][passwordCheck 8 (password kind only)][ownerSig 64]`. `channelId = SHA-256(ownerKey ‖ nonce)[0..16]`. Anyone can check that the ID matches and the owner signature is valid.
- **SYNC v2** (C1): `[wantCount u8][want tags 16 B each][bloom salt u32][bloom k u8][bloom bits…]`. "Here are the channel tags I want, and a Bloom filter of the message IDs I already have." The other phone answers with every stored packet whose tag is wanted and whose ID isn't in the filter. Lobby is tag `00…00` in the want list. This replaces the 200-ID list and works the same for members and carriers (C4).

### 2.4 Channel tags

| Kind | Tag on packets |
| :--- | :--- |
| Lobby | none (flag bit4 off) |
| Public, Password | `channelId` |
| Private, Hidden | `HMAC-SHA256(tagKey(epoch), channelId ‖ hourNumber)[0..16]`, where `hourNumber = floor(timestamp / 3 600 000)`. Changes every hour, so outsiders can't link messages over time |

Members match incoming private tags by precomputing tags for hours `now-1 … now+1` for every epoch they hold. For `SYNC` they ask for one tag per hour of the channel's retention (24 h → 24 tags = 384 B).

---

## 3. Storage (mesh-db v2)

Upgrade `IdbMeshStore` from version 1 to 2 (and `MemoryMeshStore` to match). Existing messages migrate to Lobby (`channelTag = ""`).

| Object store | Key | Holds | Kept |
| :--- | :--- | :--- | :--- |
| `messages` | id | raw packet, `channelTag`, timestamp, receivedAt, hops, mine, `decrypted?` (false while waiting for a key) | per-channel retention |
| `channels` | channelId | manifest bytes, my role, joined/left, last read, muted | until I delete it |
| `epochKeys` | `[channelId, epoch]` | 32 B key, received from whom, when | while messages using it exist, and at least the last 3 |
| `control` | id | raw `MEMBERS` / `EPOCH_CHANGE` / `KEY_GRANT` packets | until superseded (latest per channel kept), never pruned by chat retention |
| `outbox` | id | packets waiting for a path (join requests, grants, DMs) | 12 h or until ACK / superseded |
| `carrier` | id | packets for channels I'm not in | 1 MB and 6 h budget, oldest out first |

Indexes: `messages.byChannel = [channelTag, timestamp]`, `carrier.byTag`.

Key safety: keys sit in IndexedDB on the device (not encrypted at rest yet). Panic wipe (C6) deletes `mesh-db` and the `mesh:` keys. Moving keys to Keychain/Keystore is a later hardening item (C7).

---

## 4. Steps

Every step lists: what to build, files, tests, and **done when**. Each one should be small enough for one chat session.

### C0 — Protocol v2 groundwork (no visible change)

Builds:
1. `packet.ts`: version 2, the `encrypted` / `hasChannel` flags, the `channelTag` field, and the forward-compat decode (unknown type/flags parse, with `known: false`).
2. `router.ts`: relay packets that are valid but unknown without delivering them.
3. `payloads.ts`: MESSAGE v2 with `senderSeq`; seq counter in `MeshService` (persisted as `mesh:seq`).
4. `store.ts`: mesh-db v2 schema and migration (all object stores from §3, even if empty for now).

Tests: packet round-trips with and without tag/recipient; old v1 bytes are rejected; unknown type 99 is relayed but not delivered (simulation); store migration from a v1 database (use `fake-indexeddb` in Vitest, a new dev dependency, or test the upgrade function on `MemoryMeshStore`).

**Done when:** all existing tests pass after updating for v2, the new tests pass, and two phones on the new build still chat in the Lobby.

**Status:** Built. `packet.ts` is v2 (channel tag, `encrypted` flag, `known: false` for unknown types/flags; v1 bytes are rejected). The router relays unknown packets without delivering them, and for now only relays channel-tagged or encrypted `MESSAGE`s (C1 delivers them). `MESSAGE` carries `senderSeq`, saved as `mesh:seq` (`mesh:sim:seq` per tab in the simulation). mesh-db is v2 with every §3 store; old rows are tagged as Lobby, but their v1 packets no longer decode, so they're skipped on load and age out. Migration is tested with `fake-indexeddb` (new dev dependency). 49 mesh tests pass (13 new); typecheck, mesh lint, web build and the import checks pass.

**Verified 2026-10-29 (browser only):** two simulation tabs on the production build linked and chatted in the Lobby, and the sender's `mesh:sim:seq` counted up. **Still to do:** two phones on the new build. All phones must be updated together, because v1 and v2 phones can't hear each other.

### C1 — Channels (plaintext: Lobby + Public)

Builds:
1. **`lib/mesh/channels/manifest.ts`**: create (random nonce, sign), encode/decode, `verifyManifest` (ID matches owner key + nonce; owner signature valid).
2. **`lib/mesh/channels/ChannelRegistry.ts`**: joined channels, nearby channels (heard in the last 5 min, with hop distance and last activity), active channel. Loads from and saves to the `channels` store.
3. **Router:**
   - `MESSAGE` gets an optional channel tag. Deliver only if the tag is Lobby or a joined channel; **always relay** (carrier storage comes in C4).
   - History moves from one list to **one list per channel tag**, with per-channel limits from the manifest (Lobby: 50 messages / 1 h).
   - `CHANNEL_ANNOUNCE`: on receive, verify and hand to the registry; relay. Sending: every 60 s plus 0–15 s jitter, for each joined discoverable channel; **skip if someone else announced it in the last 45 s** (so a channel with 20 members sends about one announce a minute, not 20).
   - `SYNC` v2 with Bloom filter (new **`lib/mesh/bloom.ts`**, ~1 % false positives, fresh salt each time so a missed ID is caught on the next link).
4. **MeshService API:** `createChannel({name, description, kind: "public", historyPolicy, retentionHours})`, `joinChannel(id)`, `leaveChannel(id)`, `setActiveChannel(id)`, `sendText(text)` goes to the active channel. Snapshot gains `channels`, `nearbyChannels`, `activeChannelId`, and messages for the active channel only (plus unread counts).
5. **UI** (`components/mesh/`):
   - **`MeshChannelList.tsx`** on the left, styled like the existing Discord-like rail: Lobby, my channels with unread dots, a **Nearby** section (name, 🔒 for locked kinds, hop distance), and a **+** button.
   - **`CreateChannelDialog.tsx`**: name, description, kind (only Public enabled in C1), history (Recent / Since join / Full), retention.
   - `MeshRoom.tsx` wires the list; `MeshMessageList` / `MeshComposer` show the active channel. The header shows channel name, kind and owner fingerprint.

Tests: manifest sign/verify/fake-ID rejection; simulation with 20 nodes where 8 are in `#a`: every `#a` member gets each `#a` message exactly once, non-members deliver nothing but do relay; a late joiner gets `#a` history from a non-owner member while the owner is offline; announce suppression keeps announces at about 1 per channel per minute; Bloom SYNC sends only missing messages.

**Done when:** in 3 browser tabs (DevLink), tab A creates `#test`, tab C sees it under Nearby, joins and chats; tab B (not joined) relays but shows nothing. Then the same on 3 phones.

**Status:** Built. New files: `channels/manifest.ts`, `channels/ChannelRegistry.ts`, `bloom.ts`, `components/mesh/MeshChannelList.tsx`, `CreateChannelDialog.tsx`; tests in `__tests__/manifest.test.ts`, `channels.test.ts`, with the simulator moved to `__tests__/sim.ts`. Notes:
- `CHANNEL_ANNOUNCE` is packet type 5; the payload is the manifest. When a link comes up, each phone also sends its channel list **link-local**, so a new neighbour sees Nearby at once.
- Announce pacing: each member's timer runs every 60 s + 0–15 s, and **resets when it hears someone else announce the same channel**, on top of the 45 s suppression. Without the reset, 20 members sent ~1.5/min; with it, the sim (200 ms steps, each phone checking once a second at its own offset) gives **21 announces in 20 minutes** for 20 members.
- `SYNC` v2: Bloom filter capped at 2 KB (~1,700 IDs at 1 %), at most 500 packets sent back per SYNC. Joining a channel sends a `SYNC` for its tag to every current link.
- Lobby keeps 50 messages / 1 h. Channel retention comes from the manifest (1 h – 7 days, up to 1,000 messages). Messages in channels I'm not in are only relayed if they're under 24 h old.
- "Only after joining" hides older messages in the UI. For Public channels that's display only; it becomes enforced with keys in C3.
- Leaving deletes the channel's messages locally and puts it back under Nearby; the channel row is kept (`left: true`).
- Phone screens: the shared `AppShell` keeps its 72 px rail and 240 px sidebar at every width, leaving the mesh page ~78 px at 390 px wide. That isn't touched here (it's shared with Chat/Voice). The channel list opens as a full-screen drawer from a ☰ button below 768 px, so it's usable regardless.

69 mesh tests pass (20 new); typecheck, mesh lint, web build and the import checks pass.

**Verified 2026-10-29 (browser only):** 3 tabs in a line (positions 1–2–3). A created `#test` from the dialog; B saw it as direct and C at 2 hops under Nearby; C joined; A's message reached C ("2 hops"); B showed nothing, its Relayed count went up, and Nearby showed "active just now". No console errors. **Still to do:** the same on 3 phones, plus release tests 1–5.

### C2 — Password channels

Builds:
1. `npm i @noble/ciphers`.
2. **`lib/mesh/crypto/channelCrypto.ts`**:
   - `passwordKey(password, channelId)` = Argon2id (start with m = 16 MiB, t = 2, p = 1; **measure on the slowest phone**, aim for < 1 s; fall back to scrypt if Argon2 is too slow in the WebView). Derived once on join and cached in `epochKeys` as epoch 0.
   - `passwordCheck = HMAC(key, "check")[0..8]` in the manifest, so a wrong password is caught immediately.
   - `encryptMessage(epochKey, packetHeaderInfo, plaintext)`: `msgKey = HKDF(epochKey, salt = messageId, info = "mesh-msg")`, XChaCha20-Poly1305 with a zero nonce (safe, because each key is used only once), AAD = `channelTag ‖ messageId ‖ senderKey ‖ timestamp`. Plus `decryptMessage`.
3. **`lib/mesh/crypto/padding.ts`**: pad the plaintext to 256 / 512 / 1024 / 2048 B buckets (length prefix inside).
4. Router/service: encrypt on send for locked channels; on receive, decrypt if a key is known, otherwise store with `decrypted: false`.
5. UI: password prompt on join; the dialog enables the Password kind; a "Wrong password" error.

Tests: encrypt/decrypt round trip; wrong key fails; tampered header fails (AAD); simulation where a relay's received payload bytes don't contain the plaintext; a wrong password is rejected by the check.

**Done when:** on 3 phones, B (no password) relays `#secret` messages; logging raw packets on B shows no plaintext; A and C chat.

**Status:** Built. New: `crypto/channelCrypto.ts`, `crypto/padding.ts`, `components/mesh/JoinPasswordDialog.tsx`, tests `crypto.test.ts` and `password.test.ts`; `@noble/ciphers` 2.4 added. Notes:
- **KDF timing (desktop, Node):** Argon2id m = 16 MiB, t = 2, p = 1 takes **175–320 ms**; scrypt N = 2^15 takes ~320 ms. Phones are likely 3–6× slower, so **measure on the slowest phone**. The async versions are used, so the screen keeps responding. Password manifests now carry a **KDF id byte** before `passwordCheck` (1 = Argon2id 16 MiB, 2 = scrypt 2^15), so the setting can change later without breaking existing channels. The salt is `"mesh-channel-pw" ‖ channelId`, so the owner picks the nonce (and so the ID) before signing.
- The password key is saved in `epochKeys` as epoch 0, loaded on start, and **deleted on leave** (rejoining asks for the password again). Minimum password length is 4; the dialog suggests a long phrase.
- The router won't deliver plaintext messages tagged for a password channel (someone who knows the public channel ID but not the password), or encrypted messages in a Public channel. It still relays them.
- A joined channel without a key (only possible from C3 on) keeps its messages with `decrypted: false` and shares them in `SYNC`.
- **Bug fixed (also affected C1):** a phone that relayed a channel's messages before joining it dropped them as duplicates when they came back in a `SYNC` reply after joining. The router now remembers messages it only passed on (15 min, up to 5,000) and gives those one more look once their channel is joined, without relaying them again.
- `createChannel` and `joinChannel` are now async; `joinChannel` returns `joined` / `needs_password` / `wrong_password` / `unknown` / `unsupported`.

85 mesh tests pass (16 new); typecheck, mesh lint, web build and the import checks pass.

**Verified 2026-10-29 (browser only):** 3 tabs in a line. A created 🔒 `#secret`; C saw it at 2 hops, a wrong password showed "Wrong password.", and the right one joined. A's message reached C ("2 hops"); B relayed it, showed nothing and still listed the channel with Join. The raw-packet check (no plaintext reaching B, padded sizes) is in `password.test.ts`. In the hidden browser pane, C's link dropped for a few seconds while the key was derived (background tabs slow timers down, and the sim drops a link after 7 s without a hello); worth watching on phones. **Still to do:** the same on 3 phones, raw packet log on B, and timing the KDF on the slowest phone.

### C3 — Private and hidden channels (epoch keys)

Split into two sessions.

**C3a — keys, grants, members**
1. **`identity.ts`**: `x25519Secret()` / `x25519Public(edKey)` via `ed25519.utils.toMontgomerySecret` / `toMontgomery`. No new stored key; peers' X25519 keys come from their sender keys.
2. **`lib/mesh/crypto/sealed.ts`**: sealed box = ephemeral X25519 → shared secret → HKDF → XChaCha20-Poly1305. `seal(recipientEdPub, bytes)`, `open(mySecret, sealed)`.
3. **`lib/mesh/channels/membership.ts`** (pure logic, heavily tested):
   - State per channel: `epoch`, `epochKeys`, `members` (key, role: owner / admin / member, joinedEpoch), `membersVersion`.
   - `MEMBERS` payload: `[channelId][epoch u32][version u32][count][key 32 + role u8 …]`, signed by an admin. Accept only if the signer is an admin in the **current** list (or the owner) and `version` is higher.
   - `EPOCH_CHANGE`: `[channelId][newEpoch u32][prevChangeHash 8][reason u8][removed keys…]`, signed by an admin.
   - **Conflict rule:** the higher epoch wins; on a tie, the change with the lower SHA-256 wins. A losing admin re-sends grants for the winning epoch.
   - Members keep the **last 3 epoch keys** (more if the history policy needs them) and accept messages under any of them.
   - Roles: the owner can add/remove admins and co-owners; admins can approve joins, kick members (not admins) and rotate keys. If the owner never comes back, co-owners keep full control (they're named in `MEMBERS`).
4. `KEY_GRANT`: `[channelId][count u8][epoch u32 + sealed key …]`, recipient field = new member, signed by an admin. **History policy decides what's included:** Recent / Full = every epoch key still inside retention; Since join = current epoch only.
5. Control packets go to the `control` store and are sent on every new link **before** chat messages (in `SYNC` replies, control first), so nobody ends up with messages but no key.
6. Messages with no matching key are shown as "🔒 Waiting for key (N messages)". When a grant arrives they're decrypted in place.

**C3a status:** Built (logic and tests; the screens come in C3b). New: `identity.ts` X25519 helpers, `crypto/sealed.ts`, `channels/membership.ts` (formats + rules, pure), `channels/ChannelSecurity.ts` (keys, control packets, admin actions); packet types 7 `KEY_GRANT`, 8 `EPOCH_CHANGE`, 9 `MEMBERS` (6 stays free for `JOIN_REQUEST`). Differences from the plan above and things to know:
- **Roles:** Member 0, Admin 1, Co-owner 2, Owner 3. Admins touch only Members; co-owners also manage Admins; only the owner makes or removes co-owners. Every list must contain the manifest owner as the only Owner.
- **MEMBERS** entries also carry `joinedEpoch u32` (37 B each). **KEY_GRANT** entries carry the `changeHash` of the epoch change they belong to: `[epoch u32][changeHash 8][sealed key 80]`, up to 32 per grant. Epoch 0 uses an all-zero hash.
- **How a newcomer checks a list made by an admin:** every member keeps the MEMBERS packets since the owner last signed one (up to 64) and sends them in `SYNC`. A newcomer replays them from the owner-signed one, so it can check an admin's list while the owner is away. If more than 64 admin-signed changes pile up with no owner-signed list, the oldest are dropped and newcomers can't check further back; acceptable for v1.
- **Out-of-order control packets** (e.g. a grant before the list that makes its signer admin) wait in a queue (64 packets, 15 min) and are retried after each accepted change. A member could fill that queue with forged packets; C7 hardening should cap it per sender.
- **Conflicts:** both keys from a tie are kept (the loser's as an "alternate" in `epochKeys`), so messages sent under either stay readable; everyone sends with the winner's key. The losing admin doesn't need to re-send grants as long as both sides had the same member list (each admin grants to its whole list).
- **Reading tries every key held** (messages don't say their epoch): newest first, at most ~20. Keys kept: 3 epochs for "since join", up to 20 otherwise. Sending needs the current epoch's key **and** being on the member list; until then the composer shows "Waiting for the channel key…".
- **Joining in C3a:** `joinChannel` on a Private channel adds it as "waiting for key" (messages are kept, counted, and shared in `SYNC`). An admin then calls `addMember`, and waiting messages are decrypted in place. `JOIN_REQUEST`, approval screens, kick/leave UI, periodic rotation, hidden-channel invites and **rotating tags (private channels still use the plain channel ID as the tag)** are C3b. The create dialog still shows Private/Hidden as "soon".
- "Since join" in a private channel: the newcomer gets only the current key, and messages sent before joining are hidden even within the current epoch (same as Public).
- Service API (no UI yet): `addMember`, `removeMember` (also rotates), `setMemberRole`, `rotateChannelKey`, `channelEpoch`; channel info now has `waitingForKey`, `canSend`, `myRole`, `members`.

107 mesh tests pass (22 new: 12 rule tests + 10 simulations covering: waiting → added → decrypted in place; the three history policies; kicked member can't read but still relays; split with a key change on one side, then merge; two admins rotating at once; forged and replayed `MEMBERS`; a newcomer checking an admin's list while the owner is away; restart). Typecheck, mesh lint, web build and the import checks pass. Browser smoke test (Public channel in 2 tabs) still works. **Not done:** phone tests (nothing to tap yet; they come with C3b's screens).

**C3b — joining, kicking, invites, UI**
1. Join flow: tap a Private channel under Nearby → `JOIN_REQUEST` (`[channelId][note]`) goes into the outbox and floods; it's re-sent on new links for 12 h. Admins see **`JoinRequests.tsx`** (approve / decline) → approve sends `MEMBERS` + `KEY_GRANT`.
2. Kick / leave: the admin removes the member → `EPOCH_CHANGE` + grants for everyone left. A member who leaves also triggers the next admin who sees the `LEAVE`-from-channel to rotate.
3. Periodic rotation: an admin rotates every 24 h or 500 messages, whichever comes first (only if they're online; any admin may do it).
4. **Hidden** channels: never announced. Join only by invite.
5. **QR invites** (`InviteQr.tsx`): QR = `mesh-invite:` + base64(manifest + one-time invite secret). The joiner sends a `JOIN_REQUEST` containing `HMAC(inviteSecret, myKey)`; any admin auto-approves a valid one. Scanning needs a camera plugin (e.g. `@capacitor-mlkit/barcode-scanning`); as a fallback, the invite can be shared as text and pasted. A QR shown face-to-face works with no mesh path to an admin until the admin is reachable.
6. `ChannelSettings.tsx`: members with roles, kick, promote, history policy, leave, delete locally.
7. Private tags (§2.4) switched on.

**C3b status:** Built. New: `channels/invites.ts`, `crypto/channelTags.ts`, `components/mesh/ChannelSettings.tsx` (join requests, members, roles, remove, invite, change key, leave), `InviteJoinDialog.tsx`; tests in `__tests__/joining.test.ts`. Packet type 6 `JOIN_REQUEST`; `LEAVE` with a 16-byte payload now means "left this channel" (empty `LEAVE` still means going offline). Differences from the plan above and things to know:
- **Invites are text, not QR (yet).** Scanning needs a native camera plugin and a phone build, so for now admins tap **Create invite** and share the text however they like, and the joiner pastes it into **Join with an invite**. Adding `@capacitor-mlkit/barcode-scanning` plus a QR renderer later only changes how the text gets across.
- **Invite design changed from the plan's HMAC secret.** An HMAC secret derived from the channel key would let any member (they all hold the key) mint invites that admins auto-approve. Instead, an invite is a one-time Ed25519 key pair whose public half an admin signs (`"mesh-invite" ‖ channelId ‖ invitePub ‖ createdAt`). The joiner signs `"mesh-join" ‖ channelId ‖ myKey` with it. Any admin checks both signatures, plus that the signer is still an admin. So only admins can invite, an overheard request is useless to anyone else, and each invite lets one person in (used invites are tracked in memory, so a restarted admin could let a second person in; acceptable for v1). Invites last 7 days.
- **Hourly tags apply to messages only.** `MEMBERS` / `EPOCH_CHANGE` / `KEY_GRANT` keep the channel ID as their tag, because a newcomer without keys couldn't recognise or ask for them otherwise. `SYNC` between members also asks by channel ID; asking by hourly tags is for carriers (C4). Members recognise an hourly tag by computing it **for that packet's own hour** (from its timestamp) with each key they hold, so old messages from sync map back too, with no precomputed window. Results are cached (4,000 tags; cleared when keys change).
- Consequence: without a key a phone can't tell a private message belongs to its channel, so it can't count "waiting" messages. To make up for that, the router keeps the **last 300 messages it passed on unread** and re-checks them whenever the phone joins a channel or gets new keys. Getting new keys also triggers a `SYNC` for that channel. This also helps password and public channels (a phone gets what it relayed before joining), as in C4.
- **Join requests** go in the outbox (`outbox` store) and are re-sent on every new link for 12 h, until the requester appears on the member list. Admins see them in **Members** (a badge in the header and a line in the channel), with the requester's fingerprint and note, and can **Let in** or **Decline** (declined people's re-sends are ignored until the admin's app restarts).
- **Leaving** a private channel floods a channel `LEAVE`; the first admin allowed to remove that person does it, which also changes the key. The owner can't be removed; leaving just drops the channel locally (with a confirm).
- **Scheduled key change:** each admin changes the key after 24 h + 0–30 min, or 500–550 messages in the current epoch (the random part is per admin, so they don't all do it at once). Ties are settled by the conflict rule.
- **Two fixes to C3a found on the way:** (1) two admins publishing the **same member-list version** never agreed; the lower hash now wins, as for epochs. (2) With that rule, a losing admin's change (e.g. letting someone in) would be lost; the losing admin now re-applies its own last change on top. It only does so for a same-version loss, so a later deliberate undo by another admin isn't fought.
- UI: Private and Hidden are enabled in the create dialog; Nearby shows **Ask** for private channels; hidden channels never appear there. The header has **Members** for private and hidden channels (with Leave inside); public and password channels keep the **Leave** button.

118 mesh tests pass (11 new). Typecheck, mesh lint, web build and the import checks pass. (One build attempt failed with "Error evaluating Node.js code" and passed on retry, probably a clash with the running dev server's `.next` folder.)

**Verified 2026-10-29 (browser only):** 3 tabs in a line. A created private `#team`; C saw it at 2 hops with **Ask**, asked, and saw "Request sent…" with a locked message box; A saw "1 person wants to join", opened Members and let C in; A and C chatted through B; B showed nothing, relayed (Relayed 15), and its Nearby showed no activity for the channel (hourly tags). A created hidden `#quiet` (not listed on B), made an invite (375 characters); B pasted it and was let in immediately. No console errors. **Still to do:** the C3 phone test (4 phones, including walking B out of range during a key change), QR scanning, and release tests 7–11.

Tests (simulation): join → approve → newcomer reads history per policy (all three policies); kick → kicked node can't decrypt new messages but still relays; split the mesh, rotate on one side, keep chatting on both, merge → everyone converges on one epoch and can read everything they're entitled to; two admins rotate at once → conflict rule converges; forged `MEMBERS` from a non-admin is ignored; replayed old `MEMBERS` (lower version) is ignored.

**Done when:** on 4 phones: create private `#team` on A, B and C join by request and by QR, D relays without reading; kick C, and C can't read new messages; walk B out of range, rotate, bring B back → B catches up and reads.

### C4 — Carrier cache and relay tuning

1. **Carrier cache:** store packets for channels I'm not in (`carrier` store, 1 MB / 6 h budget, oldest out). Answer `SYNC` want-tags from it as well. This carries messages across gaps where no member is around.
2. **Duplicate suppression:** while waiting the 10–80 ms jitter before relaying, count copies of the same ID arriving from other links. If ≥ 2 arrived, cancel my relay (my neighbours probably covered it). Only for flood packets with ttl > 2.
3. **Priority queue in `relay()`:** control packets → my channels → DMs → carrier → announces. The token bucket takes from the front.
4. **Per-channel TTL:** manifest field (default 7; a local event channel can use 3).
5. **Gap repair with `senderSeq`:** if a member sees seq 40 then 44 from the same sender, put the missing range in the next `SYNC` (forces those IDs out of the Bloom filter; ask by tag again).
6. **Sim benchmark** (`simulation.test.ts` or a separate `bench` script, not in CI): 50 and 200 nodes, random positions, 5 channels; report delivery %, packets per node per minute, median hops, before vs after.

**Done when:** the 50-node sim delivers ≥ 99 % with less total relay traffic than C3; the numbers are written into this doc.

**Status:** Built. New: `lib/mesh/carrier.ts`, `__tests__/relay.test.ts`, `__tests__/relay.bench.test.ts` (run with `npm run bench:mesh`; kept out of `test:mesh` via `vitest.bench.config.mts`). The simulator (`__tests__/sim.ts`) gained a **timed mode** (time-ordered events, link latency, real jitter) and a lossy-link hook. Notes per item:
1. **Carrier cache:** messages and control packets for channels I'm not in are kept by their **wire tag** (1 MB / 6 h, oldest out) in the `carrier` store, and survive restarts. `SYNC` replies send control first, then my history, then carried packets. Members' `SYNC` now also asks for **private channels' hourly tags for the last 6 h under their two newest keys** (≤ 14 tags per private channel), so a carrier can answer without knowing the channel. The C3b "last 300 passed-on messages" buffer is replaced by the carrier: on joining or getting new keys, carried packets are checked again.
2. **Duplicate suppression: changed from the plan.** The plan's rule (cancel my relay if ≥ 2 copies arrived while waiting) cut traffic by ~45 % but lost deliveries in the benchmark (50 phones: 99.7 % → 93.3 %; 200 phones: 95.0 % → 85.8 %). Two changes instead:
   - **Skip neighbours who already have it:** any neighbour that sends me the packet while my relay waits is left out of my relay, and if all of them did, I skip it. This never costs delivery.
   - **Hop top-up:** if a duplicate arrives with more hops left than the copy I relayed (it came a shorter way), I relay it again. Otherwise far phones miss messages whose first copy took a long route. The ttl isn't signed, so the packet's signature is checked before spending the relay.
3. **Priority queue:** control and join requests → my channels (and the Lobby) → DMs (C6) → carried → announces/leaves. The 20/s budget drains from the front; at most 500 waiting, and the newest of the least important is dropped when full (it used to drop anything over the budget straight away).
4. **Per-channel TTL:** manifest field `ttl u8` after `maxMessages` (1–7, default 7; the fixed part is now 63 bytes). The create dialog has **Reach**: whole mesh (7) / medium (5) / close by (3). Hop counts on received messages use the channel's TTL. History sync between members still crosses any distance.
5. **Gap repair:** `senderSeq` is now **per channel** (`mesh:seq` holds a JSON map; the old single number is read as the Lobby's), since a per-identity counter would show false gaps whenever the sender posts in a channel I'm not in. When a sender's counter jumps, I send that channel's `SYNC` to my neighbours (at most every 30 s per channel). A gap before the first message I've seen from someone isn't noticed; link-up sync covers that.
6. **Benchmark** (random positions, ~8 neighbours each, 5 public channels, 20 relays/s per phone, jitter 10–80 ms, 5 ms per link; delivery counts members within 7 hops of the sender):

| Phones | Relaying | Delivery | Packets sent per phone per min | Median hops | Neighbour sends skipped |
| --: | :-- | --: | --: | --: | --: |
| 50 | C3 baseline | 99.8 % | 566 | 3 | 0 |
| 50 | + hop top-up | 99.7 % | 577 | 3 | 0 |
| 50 | **+ skip neighbours who have it (C4)** | **99.7 %** | **370** | 3 | 10,219 |
| 200 | C3 baseline | 97.9 % | 514 | 5 | 0 |
| 200 | + hop top-up | 98.0 % | 529 | 5 | 0 |
| 200 | **+ skip neighbours who have it (C4)** | **98.2 %** | **352** | 5 | 34,016 |

C4 sends **35 % fewer packets at 50 phones and 31 % fewer at 200**, with the same or better delivery. 50 phones: 2 messages each; 200 phones: 1 each (it takes ~4 minutes). The plan's "≥ 2 copies" rule lost deliveries, as noted above. At 200 phones, the ~2 % misses come from members just at the edge of the 7-hop limit.

127 mesh tests pass (9 new: carrier budget; public and private messages carried across a gap; carrier across a restart; neighbour-skip reduces traffic in a dense mesh and never skips along a chain; priority order; a 3-hop channel stops after 3 hops with correct hop counts; a gap triggers a re-sync that fetches the lost message). Typecheck, mesh lint, web build and the import checks pass. **Verified 2026-10-29 (browser only):** a 3-hop `#local` channel made with **Reach** in 3 tabs; A's message reached C at 2 hops through B, with no console errors. **Still to do:** release tests 12–13 on phones.

### C5 — Internet bridge (replaces doc 08 Phase 6)

Lets far-apart mesh groups (different buildings, cities, countries) share channels when **any** phone in each group has internet. The relay only ever sees signed, encrypted packets.

1. **Backend (additive only):** new `backend/src/mesh/bridge.js` — a plain WebSocket endpoint (`ws` package) at `/mesh-bridge`, attached to the HTTP server created in `backend/src/server.js` with one added line. No Socket.IO, no Redis streams, no DB tables.
   - The client sends `subscribe` with a list of channel tags; the server forwards each packet to the subscribers of its tag.
   - Keeps packets per tag for 24 h in memory (Redis with TTL later if needed) so a gateway that connects late can catch up.
   - Checks the Ed25519 signature, the size limit (4 KB) and a rate limit per connection and per sender key. Doesn't need or see any channel key.
   - Lobby is **never** bridged (it's meant to be local). A channel is bridged only if its manifest allows it (`bridge: true`, set by the owner).
2. **Frontend:**
   - **`transports/BridgeLinkTransport.ts`**: one more `LinkTransport` that looks like a single link called `bridge`. It connects when the phone is online (`navigator.onLine`, or `@capacitor/network` events in the app) and disconnects quietly when offline.
   - **`transports/CompositeTransport.ts`**: combines BLE + Bridge so the router sees one set of links. Flooding, dedup and `SYNC` work unchanged. A packet that came from the bridge isn't sent back to it (the existing "every other link" rule already does this).
   - Subscriptions: the tags of my joined, bridge-allowed channels (private tags for the current and previous hour, refreshed each hour).
   - UI: a small "🌐 Bridged" badge on channels when the bridge link is up; a setting to turn the bridge off.
3. Privacy note in the UI: the bridge server sees your IP address, your sender key and hourly tags, but never message content.

Tests: the bridge server with a Node test client (signature check, rate limit, tag routing); two in-memory meshes with no shared link, each with one gateway, exchange `#team` messages through a fake bridge.

**Done when:** two groups of phones in different places (or one group on Wi-Fi and one on mobile data, with no Bluetooth path) chat in the same private channel; the server log shows ciphertext only; turning internet off leaves both local meshes working.

**Status:** Built.
- **Backend (additive):** new `backend/src/mesh/bridge.js` and `backend/test/meshBridge.test.js` (`npm run test:mesh-bridge`, Node's built-in test runner, 5 tests). `ws` 8.18 was already installed through Socket.IO and is now a direct dependency. `server.js` gets **one line** after `initSocket(server)`. It uses `noServer` and only claims `/mesh-bridge` upgrades: with `{ server }`, `ws` rejects every other upgrade and would break Socket.IO.
  - Checks: v2+, signed, has a tag, not link-local, ≤ 4.2 KB, timestamp within 24 h (+10 min skew), Ed25519 signature (Node's `crypto`, no new dependency).
  - Rate limits: 20/s per connection (burst 40), 10/s per sender key (burst 20).
  - Duplicates from several gateways are dropped by message ID. Packets are kept 24 h per tag (500 per tag, 32 MB total, in memory) and replayed to new subscribers. Ping every 30 s drops dead connections.
- **Frontend:**
  - `transports/BridgeLinkTransport.ts`: one link named `bridge`; connects when `navigator.onLine`, reconnects with backoff 2–30 s.
  - **Upload filter:** only packets whose tag is in its subscription go up, so link-local packets, the Lobby and non-bridged channels never leave the mesh. Packets coming down get a fresh hop count.
  - `transports/CompositeTransport.ts` merges radio + bridge; if the bridge fails to start, the radio keeps working.
  - **Address:** `NEXT_PUBLIC_MESH_BRIDGE_URL`, or derived from `NEXT_PUBLIC_SOCKET_URL` (`https://…:4000` → `wss://…:4000/mesh-bridge`). The mesh only reads the env var and never uses the Socket.IO client.
  - **Setting:** on by default; turned off in the side panel (**Internet bridge** section, with status and the privacy note). Stored per mode as `mesh:bridge` / `mesh:sim:bridge`.
- **Manifest:** a `flags u8` byte after `ttl` (fixed part now 64 bytes); bit 0 = bridge allowed. It's kept as a raw byte so later flags still verify. Create dialog: **Also carry it over the internet** (off by default), with a note that Public channels aren't encrypted, so the server could read them; locked kinds stay ciphertext. Bridged channels show 🌐 when the bridge is up.
- **Subscriptions:** each bridge-allowed channel I'm in, by channel ID (public and password messages; every kind's member lists, keys and join requests), plus private and hidden channels' hourly tags for this and the previous hour under my two newest keys. Refreshed on join, leave, key changes and every second (cheap; only changes are sent).
- `JOIN_REQUEST` now carries the channel ID as its tag, so invites work across the bridge.
- **Limits to know:**
  - A phone only carries channels it's in, so each group needs at least one online member.
  - The server also sees channel IDs (for control packets) and who receives a key grant (the recipient field), on top of the plan's IP / sender key / hourly tags.
  - Messages stay in server memory for 24 h; a backend restart loses them.

133 mesh tests pass (6 new, in `bridge.test.ts`: two meshes with no radio path chatting through an in-memory fake of the bridge, public and private (including a key change, with no plaintext uploaded); non-bridged channels and the Lobby stay local; an invite to a hidden channel across the bridge; going offline keeps the local mesh working and reconnects cleanly). 5 backend bridge tests pass. Typecheck, mesh lint, web build and the import checks pass.

**Verified 2026-10-29 (browser + real bridge code):** the backend wasn't reachable on this PC (Redis wasn't running), so `bridge.js` was run alone on port 4100 and the frontend built with `NEXT_PUBLIC_MESH_BRIDGE_URL`. A created `#city` with the bridge option; C joined through B; B was stopped, leaving A and C with only the bridge link; A's message reached C. The server counted exactly 1 packet in and 1 forwarded (no Lobby, announces or syncs), with no console errors. **Still to do:** the real backend with Redis, then two phone groups on different networks in a private channel, checking the server log and turning internet off.

### C6 — DMs and security extras (doc 08 Phase 5)

1. `DM` packets: recipient field, payload sealed to the recipient (`sealed.ts`) + sender signature inside, padded.
2. `ACK` and the DM outbox (12 h, re-sent on new links, removed on ACK). Delivery ticks in the UI.
3. Fingerprint screen: show both fingerprints, mark a contact verified (QR scan of each other's fingerprint).
4. Panic wipe: delete `mesh-db`, `mesh:` keys and the identity, then restart the mesh with a new identity.
5. Later (C6b): the Noise XX handshake for forward secrecy in DMs.

**Done when:** a DM relayed through a third phone can't be read there (raw packet log), and it arrives after the recipient walks back into range.

**Status:** Built (C6b, Noise XX, not started). New: `lib/mesh/dm/directCrypto.ts`, `lib/mesh/dm/DirectMessages.ts`, `components/mesh/FingerprintDialog.tsx`, tests `__tests__/dm.test.ts` (and `__tests__/fakeBridge.ts`, moved out of `bridge.test.ts`).
- **Packets:** `DM` = type 10, `ACK` = type 11. Both carry the recipient's fingerprint in the recipient field and the recipient's **mailbox tag** (`SHA-256("mesh-dm" ‖ key)[0..16]`) as channel tag. With the tag, C4 carriers keep DMs for an absent recipient, the recipient asks for its mailbox in `SYNC`, and the internet bridge can route DMs (each phone subscribes to its own mailbox and may upload to its recent contacts' mailboxes, via a new upload-only list in `setTags`).
- **The inner signature is needed:** the payload is a sealed box containing `[senderKey][Ed25519(sender, "mesh-dm" ‖ recipientKey ‖ messageId ‖ padded)][padded MESSAGE payload]`. Without it, someone could re-send an intercepted sealed DM under their own signature and the recipient would see it as theirs. The recipient checks that the inner key equals the packet's sender and that the message ID matches.
- **Outbox and receipts:** a sent DM stays in the `outbox` store for 12 h, is re-sent on every new link, and members answer `SYNC` for that mailbox from it. On `ACK` it's marked delivered (saved). After 12 h it shows "not delivered". A DM arriving again (re-sent) gets a fresh `ACK` (at most every 30 s), so a lost receipt is repaired. Receipts are only accepted from the person the DM was for. Relays don't relay DMs/ACKs once they reach their recipient.
- **Storage:** mesh-db **v3** adds `contacts` (key, nickname, verified). My own DMs are saved with their text (`plain`), since only the recipient can open the sealed packet; received DMs are saved sealed and reopened on start. DM history: 500 per conversation, 7 days.
- **Fingerprint screen:** **Verify** in a DM shows both codes large, to compare in person, plus **Codes match** / **Remove verification**. Verified contacts show ✓ in the list and header. **QR scanning of each other's code is deferred** (needs a camera plugin, same as invites).
- **Panic wipe:** **Wipe mesh data** in the side panel (tap twice). Deletes `mesh-db` and every `mesh:` key (identity included) in local and session storage, keeps only the simulator's own on/position switches, and restarts as a new identity. Text Chat and Voice data aren't touched.
- UI: a **Direct messages** section in the channel list (conversations with unread counts, plus nearby people to start one with, which also works on phones where the side panel is hidden), a message button on each nearby person in the side panel, and "sending… / ✓ delivered / not delivered" on my DMs.

142 mesh tests pass (9 new: sealing only opens for the recipient and can't be re-signed or replayed under another ID; delivery through a relay that can't read it, with a receipt; recipient away and back, via a carrier; lost receipt repaired by an outbox re-send without a duplicate; a forged receipt from a third phone is ignored; conversations, receipts and verified contacts survive a restart; a DM across the internet bridge; plus a store wipe test). Typecheck, mesh lint, web build and the import checks pass.

**Verified 2026-10-29 (browser only):** 3 tabs in a line. A started a DM with C (2 hops) from the Direct messages list; C got it (unread badge), B relayed it without showing it, and A's message showed "✓ delivered". A's Verify showed both codes, and "Codes match" marked C verified. Wipe on C (tap twice) gave C a new fingerprint and removed the conversation; the mesh restarted and re-linked. The only console errors were failed bridge connections (no bridge server was running); the browser logs every failed WebSocket attempt, and the transport backs off to one try every 30 s. **Still to do:** the phone test (raw packet log on the middle phone; recipient walking back into range), QR scanning, and C6b (Noise XX).

### C7 — Battery and hardening (doc 08 Phase 7)

- Scan cycling in the background (5 s on / 10 s off), low-battery mode (< 20 %: fewer links, no carrier relaying).
- Relay counter in the status bar.
- Keys in Keychain / Keystore instead of IndexedDB.
- Malformed-packet fuzz test on `decodePacket` and every payload decoder.
- Background and lock-screen behaviour checked on each OS.

**Status:** Built; native parts written but **not yet compiled into an app** and switched off until the plugin reports them (the owner's choice, so the phone-tested builds can't break). New: `lib/mesh/power.ts`, `lib/mesh/vault.ts`, `android/.../mesh/SecureKeyStore.java`, `ios/App/App/SecureKeyStore.swift` (added to the Xcode project), tests `__tests__/hardening.test.ts`.
- **Native API (Java + Swift):** `getCapabilities`, `setPowerMode({mode, maxLinks})`, `getBattery`, `getStorageKey`, `deleteStorageKey`, plus `powerMode` in the state. The web side calls `getCapabilities` first; a build without it answers nothing and the app behaves exactly as before.
- **Power modes:** foreground (continuous low-latency scan, 7 links); background (scan 5 s in every 15 s, balanced scan mode); low (battery < 20 % and not charging: duty cycle, low-power scan mode, at most 3 links, and the router stops carrying and relaying other people's channels and DMs). Battery comes from the plugin, else the browser's Battery Status API. Android's periodic scan restart skips the duty cycle's off phase; iOS adds a `scanPaused` guard.
- **Keys in Keystore/Keychain:** a 32-byte storage key, wrapped by an Android Keystore AES-GCM key (in SharedPreferences) or stored in the iOS Keychain (`AfterFirstUnlockThisDeviceOnly`). The identity (`sealed:…` in localStorage), epoch/password keys and the text of my own DMs are sealed with it (XChaCha20-Poly1305) via `SealedMeshStore`; older unsealed data is upgraded on load. Panic wipe deletes the storage key first. The browser has no secure store, so the simulator stays unsealed; the side panel shows "device-sealed" or "not sealed".
- **Hardening:** fuzz tests on every decoder (packet, message, announce, sync, manifest, members, epoch change, grant, join request, invite, padding, sealed box, DM) with 500–2,000 mutated/random inputs each; tampered packets never verify (apart from the unsigned ttl); the router and reassembler survive 3,000 garbage packets. Waiting control packets are capped at 8 per sender (of 64).
- **Status bar:** the pill shows the relay count (↻N) and 🔋 in low-battery mode; "This device" shows the power mode and key protection.
- **Compile check:** the Android files type-check with `javac` (JDK 25, `--release 21`) against the SDK's `android.jar`, Capacitor's compiled classes and AndroidX. The only remaining error is a missing AndroidX lifecycle class referenced by a line that wasn't changed. A full Gradle build needs JDK 21 (this PC has 17, 19 and 25). Swift can't be compiled on Windows.

166 mesh tests pass (24 new); typecheck, mesh lint, web build and the import checks pass. **Still to do:** build both apps, check the capabilities switch on, then measure battery drain per hour and check background/lock-screen behaviour on Android and iPhone (release tests 16–17).

---

## 5. Release test checklist

Run on real phones at the end of the step shown. Tick here when passed.

| # | Test | Step |
| :--- | :--- | :--- |
| 1 | Two channels; messages never appear in the wrong one | C1 |
| 2 | Find a channel under Nearby, join, restart the app — no duplicate channel, history still there | C1 |
| 3 | A → C through B, with A and C out of range, in a channel B isn't in | C1 |
| 4 | Two phones apart, both send, reconnect — merged with no duplicates | C1 |
| 5 | Late joiner gets history while the owner is gone | C1 |
| 6 | Password channel: relay shows no plaintext; wrong password rejected | C2 |
| 7 | A private channel's name and members don't show in public announces (hidden kind) and tags change hourly | C3 |
| 8 | Newcomer sees history according to each of the three policies | C3 |
| 9 | Kicked member can't read new messages | C3 |
| 10 | Member away during a key change catches up and reads everything | C3 |
| 11 | Forged sender, forged `MEMBERS` and replayed control packets are rejected | C3 |
| 12 | Interrupted history transfer completes on the next link | C4 |
| 13 | Repeated meetings don't resend the same messages | C4 |
| 14 | Two distant groups chat through the bridge; server sees ciphertext only | C5 |
| 15 | DM through a relay can't be read there; arrives later via outbox | C6 |
| 16 | Battery drain per hour, foreground and background, Android and iPhone | C7 |
| 17 | Background, locked screen and app restart on each OS | C7 |

---

## 6. Limits to keep in mind

- **Throughput:** a few KB/s per link, about 7 links per phone. Keep messages ≤ 2 KB and control packets small. Private channels: cap at **100 members** in v1 (`KEY_GRANT` fan-out and `MEMBERS` size).
- **Flooding scale:** fine for dozens of phones, needs C4 for hundreds.
- **No global order:** messages sort by `(timestamp, id)`. Clocks can be off; never trust timestamps for security.
- **No guarantee without a path:** with no internet and nobody carrying messages between groups, far-away members don't get them. The UI should show "waiting" rather than pretend.
- **iOS background:** iPhones relay much less with the app closed.
- **MLS** stays a research item (doc 09 §5.4). The `KEY_GRANT` / `EPOCH_CHANGE` packets are where MLS messages would go later.
