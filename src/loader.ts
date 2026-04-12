import type { FsOps } from "./fs-ops.js";
import { extractMarkdownLinks, parseFrontmatter } from "./markdown.js";

/** Config directory names tried in order. */
const CONFIG_DIR_NAMES = [".pi", ".claude", ".agents"];

/** Root filename match (case-insensitive). */
const ROOT_FILE_LOWER = "agents.md";

export interface LoadedFile {
  filePath: string;
  description: string;
  content: string | null;
}

// — Directory / file discovery —

/**
 * Returns the first config dir at cwd that contains agents.md, null otherwise.
 * Tries .pi, .claude, .agent in order — no walk-up.
 */
export async function findAgentsDir(fs: FsOps, cwd: string): Promise<string | null> {
  for (const name of CONFIG_DIR_NAMES) {
    const candidate = fs.join(cwd, name);
    if (!await fs.exists(candidate)) continue;
    const entries = await fs.list(candidate);
    if (entries.some(e => e.toLowerCase() === ROOT_FILE_LOWER)) return candidate;
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

/**
 * Mirrors pi's loadProjectContextFiles over the given fs.
 * Walks UP from cwd to root collecting AGENTS.md or CLAUDE.md from every directory.
 * Also checks agentDir (~/.pi/agent/) first, same as pi.
 * Returns files in order: agentDir → root → ... → cwd.
 */
export async function loadProjectContextFiles(
  fs: FsOps,
  cwd: string,
  agentDir: string,
): Promise<Array<{ path: string; content: string }>> {
  const contextFiles: Array<{ path: string; content: string }> = [];
  const seenPaths = new Set<string>();

  // Global agentDir first (~/.pi/agent/AGENTS.md or CLAUDE.md)
  for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
    const content = await readFileFromDir(fs, agentDir, filename);
    if (content !== null) {
      const path = fs.join(agentDir, filename);
      contextFiles.push({ path, content });
      seenPaths.add(path);
      break;
    }
  }

  // Walk up from cwd to root, collect ancestor files
  const ancestorFiles: Array<{ path: string; content: string }> = [];
  let currentDir = cwd;
  while (true) {
    for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
      const filePath = fs.join(currentDir, filename);
      if (seenPaths.has(filePath)) break;
      const content = await readFileFromDir(fs, currentDir, filename);
      if (content !== null) {
        ancestorFiles.unshift({ path: filePath, content });
        seenPaths.add(filePath);
        break;
      }
    }
    const parent = fs.dirname(currentDir);
    if (parent === currentDir) break; // reached filesystem root
    currentDir = parent;
  }

  contextFiles.push(...ancestorFiles);
  return contextFiles;
}

/**
 * Walks up from cwd to gitRoot (inclusive) collecting .agents/skills/ paths.
 * Mirrors pi's collectAncestorAgentsSkillDirs behavior.
 */
export function collectAncestorSkillDirs(fs: FsOps, cwd: string, gitRoot: string | null): string[] {
  const dirs: string[] = [];
  let dir = cwd;
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
  ...batches: Array<Array<{ name: string; description: string; filePath: string }>>
): Array<{ name: string; description: string; filePath: string }> {
  const seen = new Set<string>();
  const result: Array<{ name: string; description: string; filePath: string }> = [];
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

/**
 * Recursively scans a remote skills directory for SKILL.md files.
 * Mirrors pi's loadSkillsFromDir behavior.
 * Returns skills as { name, description, filePath }.
 */
export async function loadRemoteSkills(
  fs: FsOps,
  dir: string,
): Promise<Array<{ name: string; description: string; filePath: string }>> {
  const skills: Array<{ name: string; description: string; filePath: string }> = [];
  const entries = await fs.list(dir);

  // If this directory contains SKILL.md, treat it as a skill root — don't recurse further
  if (entries.some(e => e === "SKILL.md")) {
    const filePath = fs.join(dir, "SKILL.md");
    const raw = await fs.read(filePath);
    if (raw) {
      const { fromMatter } = parseFrontmatter(raw);
      const description = fromMatter["description"]?.trim();
      if (description) {
        const name = fromMatter["name"] || dir.split("/").pop() || "unknown";
        skills.push({ name, description, filePath });
      }
    }
    return skills;
  }

  // Otherwise recurse into subdirectories
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const fullPath = fs.join(dir, entry);
    // Heuristic: entries without extension are likely directories
    if (!entry.includes(".")) {
      skills.push(...await loadRemoteSkills(fs, fullPath));
    }
  }

  return skills;
}

export function formatSkillsBlock(skills: Array<{ name: string; description: string; filePath: string }>): string {
  if (skills.length === 0) return "";
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
    ...skills.flatMap(s => [
      "  <skill>",
      `    <name>${escape(s.name)}</name>`,
      `    <description>${escape(s.description)}</description>`,
      `    <location>${escape(s.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ];
  return lines.join("\n");
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

export function formatRootContent(file: LoadedFile): string {
  return `## Agent Context\n\n${file.content!.trim()}`;
}

export function formatLinkedFilesBlock(files: LoadedFile[]): string {
  if (files.length === 0) return "";
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = [
    "## Available Content Files (not auto-loaded)\n",
    "Use the 'read' tool on the path shown below whenever a file's description is relevant to the current task.\n",
    "<available_files>",
    ...files.flatMap(f => [
      "  <file>",
      `    <path>${escape(f.filePath)}</path>`,
      `    <description>${escape(f.description)}</description>`,
      "  </file>",
    ]),
    "</available_files>",
  ];
  return lines.join("\n");
}
