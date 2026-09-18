# Turfcode Developer Handoff & Onboarding Brief (yug-handoff.md)
**Project:** Turfcode (`turfcode-dryrun`)  
**From:** Yug Srivastav (Project Lead)  
**To:** Ayush Singh (`i-ayushsingh`)  
**Context:** Craftora Sprint & Ongoing Turfcode Architecture  
**Status:** Ready for Full Development Takeover  

---

## 1. Executive Summary & Welcome Ayush

Ayush, welcome aboard to the Turfcode codebase! As agreed, you are taking over the active development and lead engineering for the next phases of Turfcode.

All code and assets have been consolidated and published to the dedicated GitHub repository:
👉 **`turfcode-dryrun`** (GitHub: `YugSrivastav/turfcode-dryrun`)  
Your GitHub account (`i-ayushsingh`) has been granted full administrative collaborator access to this repository.

This document equips you with the complete historical context, every mistake we encountered and fixed, the architectural retrospective rules mandated by the Captain, an honest technical reality check on multi-person vibe coding, and a concrete technical roadmap for the next milestones.

---

## 2. Essential Inspiration: Herdr & Clone Command

Turfcode's terminal UI evolution is directly inspired by **Herdr**, the state-of-the-art terminal multiplexer and agent orchestration tool. Herdr solved many of the hardest UI and PTY problems in developer tools: high-density screens, collapsible panels, and robust subprocess management without screen flickering.

### Study the Herdr Codebase:
You should clone and study the Herdr codebase immediately:
```bash
gh repo clone herdrdev/herdr
```
*(Or if not using GitHub CLI: `git clone https://github.com/herdrdev/herdr.git`)*

### Key Lessons We Borrowed from Herdr:
1. **Collapsible Sidebar (`«` / `»`)**: Bottom-left toggle button and `Ctrl+B` shortcut that dynamically collapses the sidebar down to 4 characters, expanding the central terminal pane so code and CLI output have maximum screen real-estate.
2. **Persistent Cockpit Architecture**: Never let child CLI processes tear down or clear the terminal layout. The 3-pane cockpit must remain rock-solid on screen at all times.
3. **Clean Native Shell Default**: Developer tools must start in the user's authentic environment (`PS>` or `$>`), not in a locked-down or simulated mode.

---

## 3. Product Planning & Execution Safeguards (Turfcode Retrospective)

The following six principles were established in `captain.md` during our intense dogfooding sessions. You must preserve these safeguards in every PR and feature you build:

```markdown
## Product Planning & Execution Safeguards (Turfcode Retrospective)

1. Verify the Fundamental UX Medium First (Zero False "Locked Decisions"):
   - Never declare architecture "locked" or claim to "one-shot" a project based on assumptions.
   - Explicitly verify whether the user expects a Terminal UI (TUI / CLI like Herdr, tmux, lazygit) vs a Web UI before writing code or drafting specs.
   - Build for the actual terminal medium natively from line 1.

2. Zero Mock/Fake Data in Production Views:
   - Production boot states must ALWAYS start 100% clean (only real connected users, real file locks, real chat).
   - Mock/simulation scenarios belong exclusively behind an explicit demo trigger (npm run demo / [F5]), never pre-baked into standard operating screens.

3. Empirical CLI Tool & Argument Verification:
   - Never assume how third-party CLIs behave (agy, claude, codex, opencode).
   - Verify their actual CLI invocation flags (e.g. agy -p "..." --dangerously-skip-permissions) and execution modes before wiring.

4. Deep Windows & Shell Stream Discipline:
   - On Windows/PowerShell: always clean up process.stdin listeners (data, keypress) after readline to prevent double-character input bugs.
   - Always resolve paths with fileURLToPath to eliminate C:\C:\... double-drive letter corruption.
   - Keep process outputs strictly contained inside the UI container; never let subprocesses leak to raw stdout outside the TUI boundaries.

5. Bulletproof Path Normalization & Validation:
   - Always strip enclosing single/double quotes, trim whitespace, normalize slashes (\ vs /), and resolve relative paths (. or ..).
   - Validate existence and strictly assert fs.statSync().isDirectory() — if a file path is provided, warn and either reject or extract parent folder.
   - Validate filesystem write permissions before accepting paths.
   - Auto-handle missing Git repositories gracefully with user notification and safe auto-initialization.

6. Default to Clean Native Shell & Zero Hardcoded Agent Bias:
   - Never hardcode a specific AI agent (like agy or claude) as the default active tool or display fake "active" status indicators.
   - The primary interactive pane must default to the developer's native shell environment (PS> or $>), accepting all standard developer commands (git, npm, cargo, dir, python, cd, cls) without interference.
   - AI agent tools must be invoked explicitly (e.g. typing agy <prompt>, claude <prompt>, entering an agent mode, or cycling with [F2]).
   - Keep prompt prefixes dynamic and accurately reflect whether the terminal is in standard shell mode or directed to an AI agent.
```

---

## 4. The Critical Mistakes We Made (And How They Were Solved)

When you look through git history or the codebase, understand why things are built the way they are:

| Mistake | What Happened | How It Was Fixed |
| :--- | :--- | :--- |
| **1. Web UI vs. Native TUI** | We spent hours building a React/Vite browser dashboard, only to realize developers live in terminal emulators (WezTerm/WSL2/tmux) and hate switching tabs to code. | Built `server/tui.js` using Blessed, keeping the entire 3-pane cockpit inside the terminal window. Web dashboard is now purely a spectator view (`Live Mission Control ↗`). |
| **2. Faking Agent Readiness** | Early versions hardcoded `"agy is ready"` banners rather than running real binaries. The Captain rightfully caught and rejected this immediately. | Removed all mock banners. The center terminal pane is a real shell that runs actual CLI binaries (`agy`, `claude`, `codex`, `python`) on demand. |
| **3. `screen.spawn` Disappearing UI** | Using Blessed's `screen.spawn()` suspended the alternate screen buffer (`\x1b[?1049l`), wiping out the 3-pane cockpit when `agy` was launched. | Replaced with `spawnTerminalProcess()`: stdout/stderr pipe directly to `terminalLog`, keeping the 3-pane cockpit permanently visible. |
| **4. `EADDRINUSE` Port Conflicts** | Port 7873 was frequently held by orphaned node processes across runs, crashing the CLI on boot. | Added pre-flight `isPortAvailable()`, `killProcessOnPort()`, `findAvailablePort()`, and `turf kill` CLI subcommand. |
| **5. Input Focus Clashes** | Typing commands in the terminal input interfered with team chat input. | Created dedicated Blessed textboxes, visual focus borders, `Tab` / `Ctrl+T` switching, `/chat` and `/term` commands, and clean `Ctrl+C` handling. |
| **6. Stiff Left Sidebar** | Fixed 32-column sidebar squeezed code on small terminal screens. | Modeled on Herdr: added bottom-left `«` / `»` button and `Ctrl+B` shortcut to collapse sidebar to 4 columns. |

---

## 5. The Brutal Reality Check: Can 4 Developers Really Vibe Code Simultaneously?

Before you dive in, let's cut through the hackathon marketing hype. **Can 4 developers really vibe code simultaneously on a single project with AI agents without chaos?**

### The Ideal Fantasy vs. The Cold Reality:
* **The Fantasy**: Four developers prompt 4 different LLMs (`agy`, `claude`, `codex`) at 250 tokens/sec. The models write hundreds of lines of code every 30 seconds. A central AI peacemaker merges everything in real time. Nobody talks, code just appears, and tests pass.
* **The Cold Technical Reality**:
  1. **Symbol Coupling Across Files (AST Drift)**: File-level locks prevent two agents from simultaneously rewriting `auth.js`. But what if Ayush changes `verifyToken(token)` to `verifyToken(token, secret)` in `auth.js`, while Yug's agent in `routes.js` writes code calling the old 1-argument signature? Both files compile individually, both locks were respected, but the whole application crashes at runtime.
  2. **Cross-Machine Filesystem Lag**: Git worktrees work instantaneously (<50ms) on a **single machine's local ext4/APFS filesystem**. But 4 developers are on **4 different physical laptops**. Syncing worktrees over local Wi-Fi requires network file transfers or git remotes. If Wi-Fi flutters, worktrees desynchronize.
  3. **Peacemaker Merge Latency**: When two agents collide on the same file, Claude 3.5 Sonnet takes 2.5 to 5.0 seconds to perform a semantic 3-way merge. If 4 developers trigger 20 conflicts a minute, the peacemaker becomes a bottleneck.

### How Turfcode Actually Solves This (The Pragmatic Formula):
1. **Modular Domain Ownership**: 4-person vibe coding only works when teammates have clean domain boundaries (e.g. Ayush on Backend/Auth, Krishna on UI/Components, Nakshatra on Database/API, Yug on Concurrency).
2. **Turfcode as the Collision Warning System**: Turfcode's 15-second JIT micro-locks and Intent Board prevent accidental footguns when two developers' agents touch the same core file (`App.jsx`, `package.json`, `routes.js`).
3. **Speculative Worktree Sandboxes**: Instead of blocking an agent when a file is locked, Turfcode forks it to `.turf/worktrees/<agent>` so the developer keeps moving, merging changes only upon completion.

---

## 6. Architecture & Codebase Map

Every file in `projects/turfcode` follows **Ponytail Mode**: concise, lazy senior dev code, zero unnecessary abstractions, and strictly under 600 lines.

```
turfcode/
├── bin/
│   └── turf.js              # CLI entry point (Create vs Join, auto-opens File Explorer, port cleanup)
├── server/
│   ├── index.js             # Express + WebSocket server, port discovery, health & lock APIs
│   ├── tui.js               # Blessed 3-pane Cockpit (Herdr collapsible sidebar, in-pane execution, chat)
│   ├── locks.js             # In-memory JIT Lock Registry (15s TTL, anti-starvation aging, zombie sweeper)
│   ├── peacemaker.js        # Claude 3.5 Sonnet 3-way semantic diff merger + 6s latency guard
│   ├── verify.js            # node --check syntax verification & symbol preservation audit
│   ├── worktrees.js         # Git worktree lifecycle (create, sync, remove, list)
│   ├── events.js            # WebSocket message dispatcher & API key sanitization
│   ├── rooms.js             # Room pairing, peer management, metadata tracking
│   ├── pty.js               # PTY process spawning & ANSI streaming helpers
│   └── depgraph.js          # File dependency tracker
├── client/                  # Vite + React + Tailwind secondary spectator view (Mission Control)
├── demo/
│   ├── run-demo.js          # Deterministic automated stage demo (F5 trigger)
│   └── checkout.js         # Sample file for merge conflict simulation
└── test/
    └── e2e-test.js          # 9-point end-to-end syntax and websocket validation test
```

---

## 7. Concrete Roadmap for Ayush

Here is your recommended step-by-step roadmap to take Turfcode from working prototype to production-grade tool:

### Phase 1: PTY Terminal Polish & Raw Escape Sequences
- **Current State**: Commands run via `spawnTerminalProcess()` using Node's `child_process.spawn`. It works for basic commands, but full interactive TUIs (like running `vim` or full interactive `agy` loops) need true pseudo-terminal (PTY) emulation.
- **Your Task**: Integrate `node-pty` directly into `server/tui.js` so raw ANSI escape sequences, arrow keys, and cursor movements render seamlessly inside the Blessed terminal pane, exactly like Herdr does.

### Phase 2: Peer-to-Peer Cross-Laptop Workspace Sync
- **Current State**: The host daemon runs WebSocket events for locks, peers, and chat. Worktrees currently reside on the host.
- **Your Task**: Implement peer workspace hydration via WebSocket tarball streaming (`/api/room/sync`) so when a peer runs `npx turfcode --join <host-ip>`, their local folder mirrors the host repository in < 1 second.

### Phase 3: Semantic AST Conflict Detection
- **Current State**: Peacemaker uses Claude 3.5 Sonnet on unified 3-way diffs (`git merge-file -p`) and validates syntax with `node --check`.
- **Your Task**: Add a Babel or SWC AST parser to `server/verify.js` to detect cross-file symbol export/import breakage before a merged worktree is fast-forwarded to `main`.

### Phase 4: Production Packaging & Distribution
- **Current State**: Project is runnable locally via `node bin/turf.js`.
- **Your Task**: Configure `package.json` `bin` field, add automated GitHub Actions CI in `.github/workflows/`, and publish to npm as `npx turfcode`.

---

## 8. Verification & Test Suite

Before committing any changes, always run the end-to-end test suite:
```bash
node test/e2e-test.js
```
This tests all 9 core subsystems:
- Syntax check across `bin/turf.js`, `server/tui.js`, `server/index.js`, `server/events.js`, `server/rooms.js`, `server/locks.js`.
- Room code generation.
- Peer update broadcast.
- Team chat broadcast over WebSockets.

---

*Ayush, the ship is in your hands! Build it clean, keep it fast, and make Turfcode the defining tool for multi-agent software engineering.*
