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
  formatLinkedFilesBlock,
  collectLinkedFiles,
  walkUpContextFiles,
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

    const files = await walkUpContextFiles(fs, cwd);
    if (files.length === 0) return;

    // Inline all root files; collect linked stubs from each, deduplicating across files.
    const visited = new Set(files.map(f => f.path));
    const linked = [];
    for (const file of files) {
      for (const link of extractMarkdownLinks(file.content)) {
        const linkedPath = fs.join(fs.dirname(file.path), link);
        if (await fs.exists(linkedPath)) {
          linked.push(...await collectLinkedFiles(fs, linkedPath, visited, 0, 10));
        }
      }
    }

    const rootBlock = files
      .map(f => `## ${f.path}\n\n${f.content.trim()}`)
      .join("\n\n");

    const contextBlock = [rootBlock, formatLinkedFilesBlock(linked)]
      .filter(Boolean)
      .join("\n\n");

    return { systemPrompt: `${event.systemPrompt}\n\n${contextBlock}` };
  });
}
