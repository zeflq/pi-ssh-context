/**
 * SSH context extension (Layer 0 + Layer 1).
 *
 * Loads SYSTEM.md / APPEND_SYSTEM.md and AGENTS.md / CLAUDE.md from the
 * remote machine over SSH. No-ops when --ssh is not active.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { sshExec, sshFs } from "../src/fs-ops.js";
import { readSshFlag, resolveSshState, type SshState } from "../src/ssh.js";
import {
  CONFIG_DIR_NAMES,
  loadProjectContextFiles,
  readFileFromDir,
} from "../src/loader.js";

export default function (pi: ExtensionAPI) {
  const sshFlag = readSshFlag();
  let sshState: SshState | null = null;
  let sshStateError: string | null = null;
  const sshStateReady = sshFlag
    ? resolveSshState(sshFlag)
      .then((s) => { sshState = s; })
      .catch((err) => { sshStateError = err instanceof Error ? err.message : String(err); })
    : Promise.resolve();

  pi.on("before_agent_start", async (event, _ctx) => {
    await sshStateReady;
    if (!sshState) {
      if (sshStateError) {
        return {
          systemPrompt: `${event.systemPrompt}\n\n> [ssh-context] Failed to resolve SSH target: ${sshStateError}\n> Check the --ssh flag format: user@host:~/path or user@host:/absolute/path`,
        };
      }
      return;
    }

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
