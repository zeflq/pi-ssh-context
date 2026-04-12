/**
 * Link-following context graph extension (layer 2).
 *
 * Loads <config-dir>/agents.md fully, then recursively follows markdown links,
 * injecting linked files as stubs so the LLM can pull them on demand.
 *
 * Supported config dirs (tried in order): .pi  .claude  .agents
 * Works both locally and over SSH.
 */

import type { ExtensionApi } from "@mariozechner/pi-coding-agent";
import { localFs, sshFs } from "../src/fs-ops.js";
import { readSshFlag, resolveSshState, type SshState } from "../src/ssh.js";
import { extractMarkdownLinks } from "../src/markdown.js";
import {
  formatRootContent,
  formatLinkedFilesBlock,
  collectLinkedFiles,
  findAgentsDir,
  findRootFile,
  loadRootFile,
} from "../src/loader.js";

export default function (pi: ExtensionApi) {
  const localCwd = process.cwd();

  const sshFlag = readSshFlag();
  let sshState: SshState | null = null;
  const sshStateReady = sshFlag
    ? resolveSshState(sshFlag).then((s) => { sshState = s; })
    : Promise.resolve();

  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    await sshStateReady;

    const fs = sshState ? sshFs(sshState.remote) : localFs;
    const cwd = sshState ? sshState.remoteCwd : localCwd;

    const agentsDir = await findAgentsDir(fs, cwd);
    if (!agentsDir) return;

    const rootFile = await findRootFile(fs, agentsDir);
    if (!rootFile) return;

    const root = await loadRootFile(fs, rootFile);
    if (!root) return;

    const basedir = fs.dirname(rootFile);
    const visited = new Set([rootFile]);
    const linked = [];
    for (const link of extractMarkdownLinks(root.content!)) {
      const linkedPath = fs.join(basedir, link);
      if (await fs.exists(linkedPath)) {
        linked.push(...await collectLinkedFiles(fs, linkedPath, visited, 0, 10));
      }
    }

    const contextBlock = [
      formatRootContent(root),
      formatLinkedFilesBlock(linked),
    ].filter(Boolean).join("\n\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${contextBlock}` };
  });
}
