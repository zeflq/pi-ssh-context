/**
 * SSH skills extension.
 *
 * Mirrors remote skill directories into a local temp folder so pi can load
 * them natively (debug panel, /skill:name commands). No-ops when --ssh is
 * not active.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as localDirname, join as localJoin } from "node:path";
import { dirname as posixDirname, join as posixJoin } from "node:path/posix";
import { sshExec, sshFs } from "../src/fs-ops.js";
import { readSshFlag, resolveSshState, type SshState } from "../src/ssh.js";
import {
  loadRemoteSkills,
  mergeSkills,
} from "../src/loader.js";

export default function (pi: ExtensionAPI) {
  const sshFlag = readSshFlag();
  let sshState: SshState | null = null;
  const sshStateReady = sshFlag
    ? resolveSshState(sshFlag).then((s) => { sshState = s; })
    : Promise.resolve();

  // Recursively copies a remote directory to a local destination.
  // Uses `find -type f` to list all files, then reads each via SSH cat.
  async function copyRemoteDirToLocal(remote: string, remoteDir: string, localDir: string): Promise<void> {
    const out = await sshExec(remote, `find ${JSON.stringify(remoteDir)} -type f 2>/dev/null || true`).catch(() => "");
    const files = out.split("\n").map(l => l.trim()).filter(Boolean);
    await Promise.all(files.map(async remoteFile => {
      const rel = remoteFile.slice(remoteDir.length).replace(/^\//, "");
      const localFile = localJoin(localDir, ...rel.split("/"));
      const content = await sshExec(remote, `cat ${JSON.stringify(remoteFile)}`).catch(() => null);
      if (content === null) return;
      mkdirSync(localDirname(localFile), { recursive: true });
      writeFileSync(localFile, content, "utf8");
    }));
  }

  // Tracks the local temp dir for this session; refreshed on reload, deleted on exit.
  let skillsTempDir: string | null = null;
  function cleanupSkillsTempDir(): void {
    if (skillsTempDir) {
      try { rmSync(skillsTempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      skillsTempDir = null;
    }
  }

  pi.on("resources_discover", async (_event, _ctx) => {
    await sshStateReady;
    if (!sshState) return;

    cleanupSkillsTempDir(); // refresh on reload

    // For localhost pi discovers all skills natively (global and project) —
    // skip mirroring entirely to avoid skill-name conflicts.
    const isLocalhost = sshState.remote === "localhost" || sshState.remote === "127.0.0.1";
    if (isLocalhost) return;

    const fs = sshFs(sshState.remote);
    const cwd = sshState.remoteCwd;

    const agentDir = (await sshExec(sshState.remote, "echo ~/.pi/agent")).trim();
    const agentsGlobalSkillsDir = (await sshExec(sshState.remote, "echo ~/.agents/skills")).trim();

    const skillBatches = await Promise.all([
      loadRemoteSkills(fs, posixJoin(agentDir, "skills"), true),
      loadRemoteSkills(fs, agentsGlobalSkillsDir, false),
      loadRemoteSkills(fs, posixJoin(cwd, ".pi", "skills"), true),
      loadRemoteSkills(fs, posixJoin(cwd, ".claude", "skills"), false),
      loadRemoteSkills(fs, posixJoin(cwd, ".agents", "skills"), false),
    ]);

    const skills = mergeSkills(...skillBatches);
    if (skills.length === 0) return;

    // Copy each remote skill directory (including subfolders like references/)
    // into a local temp dir so pi's scanner resolves skills natively.
    const tempDir = mkdtempSync(localJoin(tmpdir(), "pi-remote-skills-"));
    skillsTempDir = tempDir;
    await Promise.all(skills.map(skill =>
      copyRemoteDirToLocal(
        sshState!.remote,
        posixDirname(skill.filePath),      // e.g. /home/user/.pi/skills/my-skill
        localJoin(tempDir, skill.name),    // e.g. /tmp/pi-remote-skills-XYZ/my-skill
      )
    ));

    return { skillPaths: [tempDir] };
  });

  pi.on("session_shutdown", () => { cleanupSkillsTempDir(); });
}
