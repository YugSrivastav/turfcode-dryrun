# Comprehensive TurfCode Diagnostic & Architectural Roadmap Report

## Executive Subsystem Health Scorecard

| Subsystem | Status | Primary Files | Failure Mode & Current Reality |
| :--- | :---: | :--- | :--- |
| **1. Queue System** | ⚠️ **PARTIAL** | `server/locks.js`<br>`server/tui.js` | **Backend Priority Math Works; UI is 100% Dead.** `locks.js` has working priority queues and anti-starvation calculations. However, `server/index.js` lock endpoints never broadcast `queue:update` over WebSockets, and `queueBox.setContent()` is **never called anywhere in `tui.js`**. The queue pane permanently displays static hardcoded text `(0 agents waiting)`. |
| **2. Intent System** | ⚠️ **PARTIAL** | `server/turf-hook.js`<br>`server/tui.js` | **Interception Hook Works; TUI is Hardcoded.** Pre-write checking via exit codes (0 vs 2) functions correctly. However, `server/tui.js` lines 705-709 explicitly hardcode `ACTIVE TURFS:\n  (No active locks)` and only toggle agent working/idle state based on PTY events, completely ignoring the live lock registry. |
| **3. File & Worktree System** | ❌ **BROKEN IN LOCKS** | `server/locks.js`<br>`server/worktrees.js`<br>`server/peacemaker.js` | **Peacemaker AST Verification Works; Lock Engine Returns Fake Path.** While `peacemaker.js` and `verify.js` successfully test AST merges, `locks.js` line 46 returns a hardcoded Linux path `/tmp/turf-worktrees/default/${agentId}` instead of calling `createWorktree()`. On Windows, `/tmp/...` fails, and no git worktree is physically spawned during live agent execution. |
| **4. Core Sharing (Same-WiFi)** | ❌ **CRITICAL BUG** | `server/index.js`<br>`bin/turf.js`<br>`server/sync.js` | **Selects Virtual Adapters; Room Code Mismatch.** `getLocalIp()` in `server/index.js` grabs the first non-internal adapter, which on modern Windows machines with WSL2/Hyper-V/Tailscale is a virtual IP (`169.254.x.x` or `172.x.x.x`) instead of the physical Wi-Fi IP (`192.168.x.x`). Moreover, `turf join` hardcodes room code `'SYNC'` while the host generates `'TRF-XXXX'`. |
| **5. Live Messaging System** | ✅ **WORKING** | `server/index.js` | **Operational with Live Secret Sanitization.** WebSockets broadcast `chat:send` to `chat:message`, message history replays cleanly to new connections, and `sanitizeSecrets` successfully strips API keys (Groq, OpenAI, Anthropic, Gemini, GitHub) and DB URIs before transmission. |

---

## 1. Deep Subsystem Diagnostics

### 1.1. Queue System
* **Current Implementation:** Located in `server/locks.js`.
  - When Agent B requests a file currently locked by Agent A, Agent B is placed into `queue[filePath]`.
  - Effective priority is computed using:
    $$\text{effectivePriority} = \text{priority} + (3.5 \times \text{elapsedSeconds})$$
  - When Agent A releases the lock, `locks.js` automatically promotes the top queued agent.
* **The Glitch & Disconnection:**
  - In `server/tui.js` line 182, `queueBox` is created with label ` QUEUE (0) ` and placeholder content `(0 agents waiting)`.
  - There is no function, event listener, or timer in `tui.js` that updates `queueBox`.
  - In `server/index.js`, `POST /api/locks/request` does not broadcast a WebSocket payload when an agent is queued. The UI remains forever ignorant of queued agents.

### 1.2. Intent System
* **Current Implementation:** Located in `agent/turf-lock/index.ts` and `server/turf-hook.js`.
  - Before a tool executes `write` or `edit`, it invokes `node server/turf-hook.js check <file> <agentId>`.
  - Exits with `0` (lock acquired / safe to proceed) or `2` (conflict / redirect to worktree).
* **The Glitch & Disconnection:**
  - In `server/tui.js` line 707:
    ```javascript
    lines.push('  (No active locks)');
    ```
    The intent box renders agent status (`Turf: working`, `Cmdc: idle`), but active locks are never read from `lockRegistry.getAllLocks()`.
  - Leases lack an active TTL cleanup daemon. If an agent crashes without releasing, the lock remains stale until the 5-minute timer expires, blocking other agents with no heartbeat refresh.

### 1.3. File & Worktree System
* **Current Implementation:** Located in `server/worktrees.js`, `server/peacemaker.js`, and `server/verify.js`.
  - `worktrees.js` can create isolated git branches (`.turf-worktree/<branchName>`).
  - `peacemaker.js` implements 3-stage verification (Stage 1: syntax `node -c`, Stage 2: symbol audit `git diff --check`, Stage 3: Babel AST structural analysis).
* **The Glitch & Disconnection:**
  - In `server/locks.js` line 46:
    ```javascript
    worktreePath: `/tmp/turf-worktrees/default/${agentId}`
    ```
    This is hardcoded and assumes Unix. It never invokes `createWorktree()` from `server/worktrees.js`.
  - When an agent encounters code `2`, there is no mechanism re-routing the agent's active PTY process to work inside the git worktree folder.

### 1.4. Core Sharing System (Same-WiFi Tarball & Discovery)
* **Current Implementation:** Located in `server/sync.js`, `server/index.js`, and `bin/turf.js`.
  - Packs the repository into a `.tar.gz` archive, excluding `.git`, `node_modules`, and `.env`.
  - Served over HTTP via `GET /api/sync/tarball`.
* **The Critical Same-WiFi Bugs:**
  1. **Virtual Adapter IP Trap:** In `server/index.js` lines 440-450:
     ```javascript
     function getLocalIp() {
       const nets = os.networkInterfaces();
       for (const name of Object.keys(nets)) {
         for (const net of nets[name]) {
           if (net.family === 'IPv4' && !net.internal) {
             return net.address;
           }
         }
       }
     }
     ```
     On Windows, network adapters like `vEthernet (WSL)`, `Tailscale`, or `vEthernet (Default Switch)` often appear first in `os.networkInterfaces()`. The host announces an IP like `172.28.16.1` or `169.254.83.107`. Peers on the physical Wi-Fi network (`192.168.1.x`) cannot connect to this IP.
  2. **Room Code Handshake Failure:**
     - The host generates `serverState.roomCode = 'TRF-' + Math.floor(1000 + Math.random() * 9000)`.
     - In `bin/turf.js` line 54, the peer client requests `/api/sync/tarball` with a hardcoded header `x-turf-room: 'SYNC'`. If room code verification is enforced, the peer is rejected with HTTP 403.
  3. **No Delta Synchronization:** Tarball sync is a one-time onboarding snapshot. Once machines are connected, subsequent code changes on one laptop are not pushed to the other laptop.

### 1.5. Live Messaging System
* **Current Implementation:** Located in `server/index.js` lines 300-360.
  - WebSocket broadcasts messages to all connected clients.
  - In-memory ring buffer keeps the last 50 messages for newly connected clients.
  - `sanitizeSecrets` masks API keys (`gsk_...`, `AIza...`, `sk-...`, `ghp_...`, `postgres://...`).
* **Verdict:** Fully working and robust.

---

## 2. Log Analysis & Turf Agent Diagnosis

### 2.1. Log Analysis: Blessed Textarea Crash
Audit of `turf-error.log` revealed:
```text
TypeError: done is not a function
    at Textarea._listener (c:\Projects\Turf Code\node_modules\blessed\lib\widgets\textarea.js:231:5)
    at Textarea.emit (node:events:518:28)
```
- **Cause:** In Blessed's `textarea.js`, pressing `escape` triggers `this._done(null, null)`. When Blessed instantiates textboxes without an explicit callback parameter, `this._done` is undefined, throwing an unhandled exception and crashing the TUI.

### 2.2. Turf Agent Deep Dive: Why It Feels Lifeless & Laggy
1. **Zero Real-Time Token Streaming:**
   - In `server/pty_manager.js`, `parseCmdcJsonLine` listens for `text_delta` and fires `agent:stream`, rendering character-by-character output.
   - Conversely, `parseTurfJsonLine` ignores real-time token events and only triggers on `message_end`. The user sees a frozen screen for 15-30 seconds with no indication of progress.
2. **Interactive CLI Suppression (`--mode json`):**
   - Invoking Pi with `--mode json` strips its interactive colored interface, syntax highlighting, diff formatting, and spinner animations, reducing rich output to plain text strings.
3. **Disabled Thinking Engine (`--thinking none`):**
   - `--thinking none` was hardcoded in `bin/turf-agent.js` to preserve tokens. Modern coding agents gain their perceived intelligence from visible chain-of-thought and architectural reasoning. Without it, answers appear terse and mechanical.
4. **Free Groq TPM Bottleneck:**
   - Groq free tiers enforce a 20,000 TPM limit. Feeding system instructions and repository context consumes ~15,000 tokens on turn 1. Turn 2 immediately crashes with HTTP 429. (The addition of Google Gemini Studio with 1,000,000 TPM resolves this).

---

## 3. Specification & Decision Gap Analysis (`yug-handoff.md` + `Q and A.md`)

### 3.1. Implemented Features
- [x] Multi-tab terminal architecture (Turf, Cmdc, Codex, Term) with independent PTY sessions.
- [x] Pre-write intent-lock hook (`turf-hook.js`).
- [x] 3-stage validation pipeline with Babel AST parsing (`verify.js`, `peacemaker.js`).
- [x] Initial tarball repository sync (`sync.js`).
- [x] Double Ctrl+C exit guard and command palette (`/model`, `/effort`, `/plan`, etc.).
- [x] BYOK multi-key onboarding with Gemini Studio (1M TPM) and Groq.

### 3.2. Missing or Incomplete Features
- [ ] **Reactive Web Dashboard (`client/src/App.jsx`):** Express serves static React files on port 3000, but live WebSocket data binding is incomplete; the dashboard does not update in real time when locks are claimed.
- [ ] **TUI Queue & Intent Synchronization:** `queueBox` and `intentBox` are not wired to `lockRegistry` state events.
- [ ] **Real Git Worktree Creation on Conflict:** Hook conflict (exit 2) does not automatically spawn a physical worktree via `git worktree add` and switch the agent's PTY.
- [ ] **Lock Heartbeats & Manual Break:** No background lease heartbeat exists, nor is there a `/break <file>` command to release abandoned locks.

### 3.3. Deferred Architectural Decisions
1. **Mesh Gossip vs. Host-Star Relay:** Section 4 of `Q and A.md` evaluated decentralized mesh gossip. The project standardized on **Host-Star Relay** (one host acts as the authority; peers join via Wi-Fi IP).
2. **Continuous Live File Replication:** The team opted for initial tarball sync rather than continuous bi-directional file synchronization across Wi-Fi peers.

---

## 4. Innovation Strategy: 4 Features for "Best Innovation Award"

1. **Autonomous Agent Negotiation in Team Chat:**
   - When Agent A (Turf) holds a lock and Agent B (Cmdc) requests it, rather than throwing an error, the agents converse in the shared chat window to negotiate access:
     > **[Turf Agent 🤖]:** *"I'm updating token verification in `auth.js`. Can you wait 15 seconds?"*  
     > **[Cmdc Agent 🤖]:** *"Understood. I will work on `test/auth.test.js` in the meantime."*
2. **Live Collision Pulse & AST Proximity Radar:**
   - Real-time status bar warning when a peer or agent is modifying code within the same AST scope or within 20 lines of your active view:
     `⚡ PROXIMITY ALERT: Cmdc is modifying function 'handleAuth' in auth.js (7 lines away)`.
3. **Visual 3-Way Semantic AST Diff Viewer:**
   - A Blessed modal displaying syntax-aware AST node merges rather than standard git line conflicts (`<<<<<<< HEAD`), proving language-level conflict resolution.
4. **Zero-Config Terminal QR Code Wi-Fi Onboarding:**
   - On `turf host`, render an ASCII QR code in the terminal. Teammates or hackathon judges scan the QR code to connect their peer CLI or open the Web Dashboard instantly without typing IP addresses.

---

## 5. Execution Roadmap (When Approved)

1. **Phase 1: Networking & Stability Fixes**
   - Correct `getLocalIp()` in `server/index.js` to prioritize physical Wi-Fi adapters (`192.168.x.x`, `10.x.x.x`).
   - Fix `bin/turf.js` to dynamically obtain the room code before requesting `/api/sync/tarball`.
   - Patch the Blessed `textarea.js` `escape` key handler to prevent crashes.
2. **Phase 2: UI Wiring (Queue & Intent)**
   - Wire `lockRegistry` state changes to WebSocket broadcasts.
   - Connect `queueBox` and `intentBox` in `server/tui.js` to live lock data.
3. **Phase 3: Turf Agent Token Streaming & Polish**
   - Implement real-time token streaming in `parseTurfJsonLine` via `agent:stream`.
   - Default to Google Gemini Studio (1M TPM) to prevent rate-limit interruptions.
   - Surface reasoning and plan progress in the TUI when Plan Mode is enabled.
4. **Phase 4: Agent Negotiation Protocol**
   - Wire the agent-to-agent conflict negotiation flow into the Team Chat channel for the stage demonstration.
