import type { FsOps } from "./fs-ops.js";
import { extractMarkdownLinks, parseFrontmatter } from "./markdown.js";

/** Config directory names tried in order. */
export const CONFIG_DIR_NAMES = [".pi", ".claude", ".agents"];

/** Root filename match (case-insensitive). */
const ROOT_FILE_LOWER = "agents.md";

export interface LoadedFile {
  filePath: string;
  description: string;
  content: string | null;
}

// — Directory / file discovery —

/**
 * Returns the closest dir (cwd → root) that contains agents.md, null if none found.
 * At each level checks the directory directly, then .pi, .claude, .agents in order.
 */
export async function findAgentsDir(fs: FsOps, cwd: string): Promise<string | null> {
  let currentDir = cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  while (true) {
    const searchDirs = [currentDir, ...CONFIG_DIR_NAMES.map(n => fs.join(currentDir, n))];
    for (const candidate of searchDirs) {
      if (!await fs.exists(candidate)) continue;
      const entries = await fs.list(candidate);
      if (entries.some(e => e.toLowerCase() === ROOT_FILE_LOWER)) return candidate;
    }
    const parent = fs.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  return null;
}

/**
 * Locates agents.md (case-insensitive) inside 'agentsDir'.
 */
export async function findRootFile(fs: FsOps, agentsDir: string): Promise<string | null> {
  const entries = await fs.list(agentsDir);
  const match = entries.find(e => e.toLowerCase() === ROOT_FILE_LOWER);
  return match ? fs.join(agentsDir, match) : null;
}

/**
 * Looks for a named file (case-insensitive) inside a directory.
 * Returns its content if found, null otherwise.
 */
export async function readFileFromDir(fs: FsOps, dir: string, filename: string): Promise<string | null> {
  const entries = await fs.list(dir);
  const match = entries.find(e => e.toLowerCase() === filename.toLowerCase());
  if (!match) return null;
  return fs.read(fs.join(dir, match));
}

// — Project context and skills —

/** Context file candidates, tried in order — uppercase only, matching pi-mono. */
const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * Walks UP from cwd to root collecting AGENTS.md (or CLAUDE.md) from every directory.
 * At each level checks the directory directly, then inside .pi/, .claude/, .agents/ (first match wins).
 * Uses exact-case lookup (uppercase only) matching pi-mono behavior.
 * Returns files in order: root → ... → cwd. No global agentDir fallback.
 */
export async function walkUpContextFiles(
  fs: FsOps,
  cwd: string,
): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = [];
  const seenPaths = new Set<string>();
  let currentDir = cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  while (true) {
    const searchDirs = [currentDir, ...CONFIG_DIR_NAMES.map(n => fs.join(currentDir, n))];
    const levelFiles: Array<{ path: string; content: string }> = [];
    for (const dir of searchDirs) {
      for (const filename of CONTEXT_FILE_NAMES) {
        const path = fs.join(dir, filename);
        if (seenPaths.has(path)) continue;
        const content = await fs.read(path);
        if (content !== null) {
          levelFiles.push({ path, content });
          seenPaths.add(path);
          break;
        }
      }
    }
    result.unshift(...levelFiles);
    const parent = fs.dirname(currentDir);
    if (parent === currentDir) break; // reached filesystem root
    currentDir = parent;
  }
  return result;
}

/**
 * Mirrors pi's loadProjectContextFiles over the given fs.
 * Checks agentDir (~/.pi/agent/) first, then delegates to walkUpContextFiles.
 * Returns files in order: agentDir → root → ... → cwd.
 */
export async function loadProjectContextFiles(
  fs: FsOps,
  cwd: string,
  agentDir: string,
): Promise<Array<{ path: string; content: string }>> {
  const contextFiles: Array<{ path: string; content: string }> = [];

  // Global agentDir first (~/.pi/agent/AGENTS.md or CLAUDE.md)
  for (const filename of CONTEXT_FILE_NAMES) {
    const path = fs.join(agentDir, filename);
    const content = await fs.read(path);
    if (content !== null) {
      contextFiles.push({ path, content });
      break;
    }
  }

  contextFiles.push(...await walkUpContextFiles(fs, cwd));
  return contextFiles;
}

/**
 * Walks up from cwd to gitRoot (inclusive) collecting .agents/skills/ paths.
 * Mirrors pi's collectAncestorAgentsSkillDirs behavior.
 */
export function collectAncestorSkillDirs(fs: FsOps, cwd: string, gitRoot: string | null): string[] {
  const dirs: string[] = [];
  // Normalize trailing slash to avoid duplicating the first directory
  let dir = cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  while (true) {
    dirs.push(fs.join(dir, ".agents", "skills"));
    if (gitRoot && dir === gitRoot) break;
    const parent = fs.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Merges skill arrays from multiple sources, deduplicating by name (first wins).
 */
export function mergeSkills(
  ...batches: Array<Array<{ name: string; description: string; filePath: string; content: string }>>
): Array<{ name: string; description: string; filePath: string; content: string }> {
  const seen = new Set<string>();
  const result: Array<{ name: string; description: string; filePath: string; content: string }> = [];
  for (const batch of batches) {
    for (const skill of batch) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        result.push(skill);
      }
    }
  }
  return result;
}

type Skill = { name: string; description: string; filePath: string; content: string };

/**
 * Loads a single SKILL.md file into a Skill, or null if invalid.
 */
async function loadSkillFile(fs: FsOps, filePath: string): Promise<Skill | null> {
  const raw = await fs.read(filePath);
  if (!raw) return null;
  const { fromMatter } = parseFrontmatter(raw);
  const description = fromMatter["description"]?.trim();
  if (!description) return null;
  const name = fromMatter["name"] || filePath.split("/").slice(-2, -1)[0] || "unknown";
  return { name, description, filePath, content: raw };
}

/**
 * Scans a skills directory mirroring pi-mono's two discovery modes:
 *
 *   allowRootMd = true  (~/.pi/agent/skills/, .pi/skills/)
 *     - Root .md files are individual skills
 *     - Subdirectories containing SKILL.md are recursively discovered
 *
 *   allowRootMd = false (~/.agents/skills/, .agents/skills/ ancestors)
 *     - Root .md files are ignored
 *     - Only subdirectories containing SKILL.md are discovered
 */
export async function loadRemoteSkills(
  fs: FsOps,
  dir: string,
  allowRootMd = false,
): Promise<Skill[]> {
  const skills: Skill[] = [];
  const entries = await fs.list(dir);
  if (entries.length === 0) return skills;

  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const fullPath = fs.join(dir, entry);

    if (entry === "SKILL.md") {
      // This dir itself is a skill root (called from parent recursion)
      const skill = await loadSkillFile(fs, fullPath);
      if (skill) skills.push(skill);
      return skills; // don't recurse further into a skill root
    }

    if (entry.endsWith(".md")) {
      // Root .md file — only allowed in pi/agent mode
      if (allowRootMd) {
        const skill = await loadSkillFile(fs, fullPath);
        if (skill) skills.push(skill);
      }
      continue;
    }

    // Treat as directory if read returns null (directories aren't readable as text).
    if (await fs.read(fullPath) === null) {
      skills.push(...await loadRemoteSkills(fs, fullPath, allowRootMd));
    }
  }

  return skills;
}

// — agents.md link-following —

export async function loadRootFile(fs: FsOps, filePath: string): Promise<LoadedFile | null> {
  const raw = await fs.read(filePath);
  if (!raw) return null;
  const { fromMatter } = parseFrontmatter(raw);
  return { filePath, description: fromMatter["description"] ?? "", content: raw };
}

export async function collectLinkedFiles(
  fs: FsOps,
  filePath: string,
  visited: Set<string>,
  depth: number,
  maxDepth: number
): Promise<LoadedFile[]> {
  if (depth >= maxDepth || visited.has(filePath)) return [];
  visited.add(filePath);

  const raw = await fs.read(filePath);
  if (!raw) return [];

  const { fromMatter } = parseFrontmatter(raw);
  const basedir = fs.dirname(filePath);
  const result: LoadedFile[] = [
    { filePath, description: fromMatter["description"] ?? "", content: null },
  ];

  for (const link of extractMarkdownLinks(raw)) {
    const linked = fs.join(basedir, link);
    if (await fs.exists(linked)) {
      result.push(...await collectLinkedFiles(fs, linked, visited, depth + 1, maxDepth));
    }
  }

  return result;
}

export function formatRootContent(file: LoadedFile & { content: string }): string {
  return `## Agent Context\n\n${file.content.trim()}`;
}

export function formatLinkedFilesBlock(files: LoadedFile[]): string {
  if (files.length === 0) return "";
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = [
    "## On-Demand Files\n",
    "<on-demand-files>",
    "  <load-rule>",
    "    IF the current task requires knowledge described in a file below → call the read tool on that file before proceeding.",
    "    IF no description matches the task → skip all files.",
    "  </load-rule>",
    "  <available_files>",
    ...files.flatMap(f => [
      "    <file>",
      `      <path>${escape(f.filePath)}</path>`,
      `      <description>${escape(f.description)}</description>`,
      "    </file>",
    ]),
    "  </available_files>",
    "</on-demand-files>",
  ];
  return lines.join("\n");
}
