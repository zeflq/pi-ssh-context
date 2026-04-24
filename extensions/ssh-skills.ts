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
import { join as localJoin } from "node:path";
import { join as posixJoin } from "node:path/posix";
import { sshExec } from "../src/fs-ops.js";
import { readSshFlag, resolveSshState, type SshState } from "../src/ssh.js";
import { mergeSkills } from "../src/loader.js";
import { parseFrontmatter } from "../src/markdown.js";

type Skill = { name: string; description: string; filePath: string; content: string };

/**
 * Finds SKILL.md files (and root .md files when allowRootMd is true) in a
 * remote directory using a single `find` invocation.
 */
async function findSkillFiles(remote: string, dir: string, allowRootMd: boolean): Promise<string[]> {
  const cmds = [`find ${JSON.stringify(dir)} -name "SKILL.md" -type f 2>/dev/null || true`];
  if (allowRootMd) {
    cmds.push(`find ${JSON.stringify(dir)} -maxdepth 1 -name "*.md" ! -name "SKILL.md" -type f 2>/dev/null || true`);
  }
  const out = await sshExec(remote, cmds.join("; ")).catch(() => "");
  return out.split("\n").map(l => l.trim()).filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  const sshFlag = readSshFlag();
  let sshState: SshState | null = null;
  const sshStateReady = sshFlag
    ? resolveSshState(sshFlag).then((s) => { sshState = s; }).catch(() => { sshState = null; })
    : Promise.resolve();

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

    const remote = sshState.remote;
    const cwd = sshState.remoteCwd.replace(/\/$/, "");

    const [agentDir, agentsGlobalSkillsDir] = await Promise.all([
      sshExec(remote, "echo ~/.pi/agent").then(s => s.trim()),
      sshExec(remote, "echo ~/.agents/skills").then(s => s.trim()),
    ]);

    // One find per skills dir, all in parallel.
    const skillDirs: Array<[string, boolean]> = [
      [posixJoin(agentDir, "skills"), true],
      [agentsGlobalSkillsDir, false],
      [posixJoin(cwd, ".pi", "skills"), true],
      [posixJoin(cwd, ".claude", "skills"), false],
      [posixJoin(cwd, ".agents", "skills"), false],
    ];
    const perDirPaths = await Promise.all(
      skillDirs.map(([dir, allowRootMd]) => findSkillFiles(remote, dir, allowRootMd))
    );

    // Read all discovered skill files in parallel (dedup paths first).
    const uniquePaths = [...new Set(perDirPaths.flat())];
    if (uniquePaths.length === 0) return;

    const rawByPath = new Map(
      (await Promise.all(
        uniquePaths.map(async p =>
          [p, await sshExec(remote, `cat ${JSON.stringify(p)}`).catch(() => null)] as const
        )
      )).filter((entry): entry is [string, string] => entry[1] !== null)
    );

    // Parse into skill objects per dir to preserve priority order for mergeSkills.
    const batches = perDirPaths.map(paths =>
      paths.flatMap((filePath): Skill[] => {
        const raw = rawByPath.get(filePath);
        if (!raw) return [];
        const { fromMatter } = parseFrontmatter(raw);
        const description = fromMatter["description"]?.trim();
        if (!description) return [];
        const name = fromMatter["name"] || filePath.split("/").slice(-2, -1)[0] || "unknown";
        return [{ name, description, filePath, content: raw }];
      })
    );

    const skills = mergeSkills(...batches);
    if (skills.length === 0) return;

    // Write each skill's SKILL.md content into a local temp dir so pi's scanner
    // resolves skills natively. Sub-files (references/, etc.) stay on the remote
    // and are read there by the agent when needed.
    const tempDir = mkdtempSync(localJoin(tmpdir(), "pi-remote-skills-"));
    skillsTempDir = tempDir;
    for (const skill of skills) {
      const skillDir = localJoin(tempDir, skill.name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(localJoin(skillDir, "SKILL.md"), skill.content, "utf8");
    }

    return { skillPaths: [tempDir] };
  });

  pi.on("session_shutdown", () => { cleanupSkillsTempDir(); });
}
