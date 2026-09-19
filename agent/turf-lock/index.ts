import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import path from "node:path";

// turf-lock: Pi extension that declares Turf intent locks before every
// write/edit tool call. Granted -> write to main. Conflict (exit 2) ->
// transparently rewrite the target path into the speculative worktree.
// Hook errors fail open: the agent proceeds, daemon outage never blocks.
// Env (set by bin/turf-agent.js): TURF_DAEMON, TURF_ROOM, TURF_USER,
// TURF_AGENT_ID, TURF_HOOK (abs path to server/turf-hook.js).

const WRITE_TOOLS = new Set(["write", "edit"]);

function targetPath(input: any): string | null {
  if (!input || typeof input !== "object") return null;
  for (const key of ["path", "file", "target", "filename", "filepath"]) {
    if (typeof input[key] === "string" && input[key].length > 0) return input[key];
  }
  return null;
}

function runHook(args: string[]): Promise<{ code: number; stdout: string }> {
  const hook = process.env.TURF_HOOK || "";
  return new Promise((resolve) => {
    if (!hook) return resolve({ code: 1, stdout: "" });
    execFile(
      process.execPath,
      [hook, "--daemon", process.env.TURF_DAEMON || "http://127.0.0.1:7873",
        "--room", process.env.TURF_ROOM || "TRF-XXXX",
        "--user", process.env.TURF_USER || "turf",
        "--agent", process.env.TURF_AGENT_ID || "turf",
        ...args],
      { timeout: 5000 },
      (err, stdout) => resolve({ code: err ? (err as any).code ?? 1 : 0, stdout: String(stdout || "") })
    );
  });
}

export default function (pi: ExtensionAPI) {
  const lockedFiles = new Set<string>();
  const speculativeTargets = new Map<string, string>(); // rel -> abs worktree path

  const syncWorktreeFile = async (rel: string, targetPath: string) => {
    try {
      const fs = await import("node:fs");
      if (fs.existsSync(targetPath)) {
        const content = fs.readFileSync(targetPath, "utf8");
        await runHook(["--sync-worktree", "--file", rel, "--content", content]);
      }
    } catch {}
  };

  const releaseAll = async () => {
    if (lockedFiles.size === 0) return;
    const files = Array.from(lockedFiles);
    lockedFiles.clear();
    for (const f of files) {
      try {
        await runHook(["--release", "--file", f]);
      } catch {}
    }
  };

  if (typeof (pi as any).on === "function") {
    pi.on("agent_end", async () => {
      for (const [rel, target] of speculativeTargets.entries()) {
        await syncWorktreeFile(rel, target);
      }
      speculativeTargets.clear();
      await releaseAll();
    });

    pi.on("tool_result", async () => {
      for (const [rel, target] of speculativeTargets.entries()) {
        await syncWorktreeFile(rel, target);
      }
    });
  }

  pi.on("tool_call", async (event, ctx) => {
    if (!WRITE_TOOLS.has(event.toolName)) return;
    const target = targetPath((event as any).input);
    if (!target) return;

    const rel = path.relative(ctx.cwd, path.resolve(ctx.cwd, target)).replace(/\\/g, "/");
    const { code, stdout } = await runHook(["--file", rel]);
    if (code === 0) {
      lockedFiles.add(rel);
      return; // granted: write to main
    }
    if (code !== 2) return; // hook error: fail open

    // conflict: redirect into the speculative worktree (input is mutable, no revalidation)
    try {
      const data = JSON.parse(stdout);
      const worktree = String(data.localWorktreePath || data.worktreePath || "");
      if (!worktree) return;
      const worktreeTarget = path.join(worktree, rel);

      // Cold-start seed: copy existing file into worktree if missing
      try {
        const fs = await import("node:fs");
        fs.mkdirSync(path.dirname(worktreeTarget), { recursive: true });
        const localSource = path.resolve(ctx.cwd, rel);
        if (!fs.existsSync(worktreeTarget) && fs.existsSync(localSource)) {
          fs.copyFileSync(localSource, worktreeTarget);
        }
      } catch {}

      for (const key of ["path", "file", "target", "filename", "filepath"]) {
        if (typeof (event as any).input[key] === "string") {
          (event as any).input[key] = worktreeTarget;
        }
      }
      speculativeTargets.set(rel, worktreeTarget);
      if (ctx.hasUI) ctx.ui.notify(`Turf conflict on ${rel}: forked to worktree`, "warning");
    } catch {
      return;
    }
  });
}

