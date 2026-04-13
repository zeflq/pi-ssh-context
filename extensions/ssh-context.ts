/**
 * SSH parity extension.
 *
 * Replicates pi's remote resource loading over SSH (only when --ssh is active;
 * pi handles local natively):
 *   resources_discover — exposes remote skill paths to pi's native loader
 *   before_agent_start — Layer 0: SYSTEM.md / APPEND_SYSTEM.md
 *                        Layer 1: AGENTS.md / CLAUDE.md walk-up
 */

import type { ExtensionApi } from "@mariozechner/pi-coding-agent";
import { join as posixJoin } from "node:path/posix";
import { sshExec, sshFs } from "../src/fs-ops.js";
import { readSshFlag, resolveSshState, type SshState } from "../src/ssh.js";
import {
  CONFIG_DIR_NAMES,
  collectAncestorSkillDirs,
  loadProjectContextFiles,
  readFileFromDir,
} from "../src/loader.js";

export default function (pi: ExtensionApi) {
  const sshFlag = readSshFlag();
  let sshState: SshState | null = null;
  const sshStateReady = sshFlag
    ? resolveSshState(sshFlag).then((s) => { sshState = s; })
    : Promise.resolve();

  // Returns git root resolved from the remote cwd (not the SSH session's home dir).
  async function getRemoteGitRoot(remote: string, cwd: string): Promise<string | null> {
    const out = await sshExec(remote, `cd ${JSON.stringify(cwd)} && git rev-parse --show-toplevel 2>/dev/null || true`)
      .catch(() => "");
    return out.trim() || null;
  }

  // Expose remote skill paths to pi's native loader so they appear in the
  // debug panel and are registered as /skill:name commands.
  // For localhost paths are identical on disk and load natively.
  // For true remote hosts pi silently skips non-existent local paths.
  pi.on("resources_discover", async () => {
    await sshStateReady;
    if (!sshState) return;

    const cwd = sshState.remoteCwd;
    const fs = sshFs(sshState.remote);
    const gitRoot = await getRemoteGitRoot(sshState.remote, cwd);

    // pi-mono project skill locations:
    //   .pi/skills/            (allowRootMd=true)
    //   .agents/skills/ + ancestors up to git root (allowRootMd=false)
    const candidates = [
      ...CONFIG_DIR_NAMES.map(name => posixJoin(cwd, name, "skills")),
      ...collectAncestorSkillDirs(fs, cwd, gitRoot),
    ];

    const skillPaths = (
      await Promise.all(candidates.map(async p => (await fs.exists(p)) ? p : null))
    ).filter((p): p is string => p !== null);

    return { skillPaths };
  });

  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    await sshStateReady;
    if (!sshState) return;

    const fs = sshFs(sshState.remote);
    const cwd = sshState.remoteCwd;
    const agentDir = (await sshExec(sshState.remote, "echo ~/.pi/agent")).trim();

    let systemPrompt = event.systemPrompt;
    let appendPrompt = "";

    // Layer 0: SYSTEM.md + APPEND_SYSTEM.md
    // Try each config dir (.pi, .claude, .agents) at cwd in order, then agentDir as fallback.
    let systemMd: string | null = null;
    let appendMd: string | null = null;
    for (const name of CONFIG_DIR_NAMES) {
      const configDir = fs.join(cwd, name);
      if (!systemMd) systemMd = await readFileFromDir(fs, configDir, "SYSTEM.md");
      if (!appendMd) appendMd = await readFileFromDir(fs, configDir, "APPEND_SYSTEM.md");
      if (systemMd && appendMd) break;
    }
    systemMd ??= await readFileFromDir(fs, agentDir, "SYSTEM.md");
    appendMd ??= await readFileFromDir(fs, agentDir, "APPEND_SYSTEM.md");
    if (systemMd) systemPrompt = systemMd;
    if (appendMd) appendPrompt = appendMd;

    // Layer 1: AGENTS.md / CLAUDE.md — exact uppercase, walk up from remote cwd.
    const contextFiles = await loadProjectContextFiles(fs, cwd, agentDir);
    if (contextFiles.length > 0) {
      const projectContext = contextFiles
        .map(f => `## ${f.path}\n\n${f.content}`)
        .join("\n\n");
      systemPrompt = `${systemPrompt}\n\n# Project Context\n\n${projectContext}`;
    }

    return {
      systemPrompt: [systemPrompt, appendPrompt].filter(Boolean).join("\n\n"),
    };
  });
}
