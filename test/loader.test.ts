import { describe, it, expect } from "vitest";
import type { FsOps } from "../src/fs-ops.js";
import {
  findAgentsDir,
  findRootFile,
  collectLinkedFiles,
  collectAncestorSkillDirs,
  mergeSkills,
  loadRemoteSkills,
} from "../src/loader.js";

// — Mock FsOps builder —

function makeFsOps(files: Record<string, string>): FsOps {
  const join = (...parts: string[]) =>
    parts.join("/").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

  return {
    join,
    dirname,
    async exists(p) { return p in files || Object.keys(files).some(k => k.startsWith(p + "/")); },
    async read(p) { return files[p] ?? null; },
    async list(dir) {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const seen = new Set<string>();
      for (const k of Object.keys(files)) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          seen.add(rest.split("/")[0]);
        }
      }
      return [...seen];
    },
  };
}

// — findAgentsDir —

describe("findAgentsDir", () => {
  it("finds .pi when agents.md is present", async () => {
    const fs = makeFsOps({ "/project/.pi/agents.md": "# root" });
    expect(await findAgentsDir(fs, "/project")).toBe("/project/.pi");
  });

  it("finds .claude when .pi is absent", async () => {
    const fs = makeFsOps({ "/project/.claude/agents.md": "# root" });
    expect(await findAgentsDir(fs, "/project")).toBe("/project/.claude");
  });

  it("finds .agents as last fallback", async () => {
    const fs = makeFsOps({ "/project/.agents/agents.md": "# root" });
    expect(await findAgentsDir(fs, "/project")).toBe("/project/.agents");
  });

  it("prefers .pi over .claude when both exist", async () => {
    const fs = makeFsOps({
      "/project/.pi/agents.md": "# pi",
      "/project/.claude/agents.md": "# claude",
    });
    expect(await findAgentsDir(fs, "/project")).toBe("/project/.pi");
  });

  it("returns null when no config dir has agents.md", async () => {
    const fs = makeFsOps({ "/project/.pi/other.md": "# other" });
    expect(await findAgentsDir(fs, "/project")).toBeNull();
  });

  it("returns null when no config dir exists", async () => {
    const fs = makeFsOps({});
    expect(await findAgentsDir(fs, "/project")).toBeNull();
  });

  it("is case-insensitive for agents.md", async () => {
    const fs = makeFsOps({ "/project/.pi/AGENTS.MD": "# upper" });
    expect(await findAgentsDir(fs, "/project")).toBe("/project/.pi");
  });
});

// — collectLinkedFiles —

describe("collectLinkedFiles", () => {
  it("collects a single linked file as stub", async () => {
    const fs = makeFsOps({
      "/project/.pi/git.md": "---\ndescription: Git conventions.\n---\n# Git",
    });
    const visited = new Set(["/project/.pi/agents.md"]);
    const result = await collectLinkedFiles(fs, "/project/.pi/git.md", visited, 0, 10);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("/project/.pi/git.md");
    expect(result[0].description).toBe("Git conventions.");
    expect(result[0].content).toBeNull(); // stub only
  });

  it("recurses into linked files", async () => {
    const fs = makeFsOps({
      "/project/.pi/git.md": "---\ndescription: Git.\n---\n[Deploy](deploy.md)",
      "/project/.pi/deploy.md": "---\ndescription: Deploy.\n---\n# Deploy",
    });
    const visited = new Set(["/project/.pi/agents.md"]);
    const result = await collectLinkedFiles(fs, "/project/.pi/git.md", visited, 0, 10);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.filePath)).toContain("/project/.pi/deploy.md");
  });

  it("skips already-visited files (cycle detection)", async () => {
    const fs = makeFsOps({
      "/project/.pi/a.md": "---\ndescription: A.\n---\n[B](b.md)",
      "/project/.pi/b.md": "---\ndescription: B.\n---\n[A](a.md)",
    });
    const visited = new Set(["/project/.pi/agents.md", "/project/.pi/a.md"]);
    const result = await collectLinkedFiles(fs, "/project/.pi/b.md", visited, 0, 10);
    // b.md collected, a.md skipped (already visited)
    expect(result.map(r => r.filePath)).toEqual(["/project/.pi/b.md"]);
  });

  it("respects maxDepth", async () => {
    const fs = makeFsOps({
      "/project/.pi/a.md": "---\ndescription: A.\n---\n[B](b.md)",
      "/project/.pi/b.md": "---\ndescription: B.\n---\n# B",
    });
    const visited = new Set<string>();
    // maxDepth=0 means nothing collected at depth 0
    const result = await collectLinkedFiles(fs, "/project/.pi/a.md", visited, 0, 0);
    expect(result).toHaveLength(0);
  });

  it("handles missing description gracefully (empty stub)", async () => {
    const fs = makeFsOps({
      "/project/.pi/nodesc.md": "# No frontmatter here",
    });
    const visited = new Set<string>();
    const result = await collectLinkedFiles(fs, "/project/.pi/nodesc.md", visited, 0, 10);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("");
  });

  it("skips non-existent linked files silently", async () => {
    const fs = makeFsOps({
      "/project/.pi/agents.md": "---\ndescription: Root.\n---\n[Missing](missing.md)",
    });
    const visited = new Set<string>();
    const result = await collectLinkedFiles(fs, "/project/.pi/agents.md", visited, 0, 10);
    // only agents.md itself, missing.md skipped
    expect(result.map(r => r.filePath)).toEqual(["/project/.pi/agents.md"]);
  });

  it("detects raw .md references without markdown link syntax", async () => {
    const fs = makeFsOps({
      "/project/AGENTS.md": "## Review\nwhen making a review load -> .pi/REVIEW.md",
      "/project/.pi/REVIEW.md": "---\ndescription: Review checklist.\n---\n# Review",
    });
    const visited = new Set<string>();
    const result = await collectLinkedFiles(fs, "/project/AGENTS.md", visited, 0, 10);
    expect(result.map(r => r.filePath)).toContain("/project/.pi/REVIEW.md");
  });
});

// — collectAncestorSkillDirs —

describe("collectAncestorSkillDirs", () => {
  const fs = makeFsOps({});

  it("includes cwd/.agents/skills when gitRoot is null", async () => {
    const dirs = collectAncestorSkillDirs(fs, "/a/b/c", null);
    expect(dirs).toContain("/a/b/c/.agents/skills");
    expect(dirs).toContain("/a/b/.agents/skills");
    expect(dirs).toContain("/a/.agents/skills");
  });

  it("stops at gitRoot (inclusive)", async () => {
    const dirs = collectAncestorSkillDirs(fs, "/a/b/c", "/a/b");
    expect(dirs).toContain("/a/b/c/.agents/skills");
    expect(dirs).toContain("/a/b/.agents/skills");
    expect(dirs).not.toContain("/a/.agents/skills");
  });

  it("returns single entry when cwd equals gitRoot", async () => {
    const dirs = collectAncestorSkillDirs(fs, "/a/b", "/a/b");
    expect(dirs).toEqual(["/a/b/.agents/skills"]);
  });
});

// — mergeSkills —

describe("mergeSkills", () => {
  it("merges multiple batches", () => {
    const a = [{ name: "git", description: "Git skill", filePath: "/a/git/SKILL.md", content: "" }];
    const b = [{ name: "deploy", description: "Deploy skill", filePath: "/b/deploy/SKILL.md", content: "" }];
    expect(mergeSkills(a, b)).toHaveLength(2);
  });

  it("first batch wins on name collision", () => {
    const a = [{ name: "git", description: "from a", filePath: "/a/SKILL.md", content: "" }];
    const b = [{ name: "git", description: "from b", filePath: "/b/SKILL.md", content: "" }];
    const result = mergeSkills(a, b);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("from a");
  });

  it("handles empty batches", () => {
    expect(mergeSkills([], [])).toEqual([]);
  });
});

// — loadRemoteSkills —

describe("loadRemoteSkills", () => {
  it("loads a skill from a subdirectory SKILL.md", async () => {
    const fs = makeFsOps({
      "/skills/git-helper/SKILL.md": "---\nname: git-helper\ndescription: Git conventions.\n---\n# Git",
    });
    const skills = await loadRemoteSkills(fs, "/skills");
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("git-helper");
    expect(skills[0].description).toBe("Git conventions.");
  });

  it("returns empty array for non-existent dir", async () => {
    const fs = makeFsOps({});
    const skills = await loadRemoteSkills(fs, "/nonexistent");
    expect(skills).toEqual([]);
  });

  it("skips skills without description", async () => {
    const fs = makeFsOps({
      "/skills/bad/SKILL.md": "---\nname: bad\n---\n# No description",
    });
    const skills = await loadRemoteSkills(fs, "/skills");
    expect(skills).toEqual([]);
  });

  it("falls back to dir name when name frontmatter is missing", async () => {
    const fs = makeFsOps({
      "/skills/my-tool/SKILL.md": "---\ndescription: My tool.\n---\n# Tool",
    });
    const skills = await loadRemoteSkills(fs, "/skills");
    expect(skills[0].name).toBe("my-tool");
  });

  it("does not recurse when SKILL.md is at the dir root", async () => {
    const fs = makeFsOps({
      "/skills/SKILL.md": "---\nname: root-skill\ndescription: Root.\n---\n",
      "/skills/nested/SKILL.md": "---\nname: nested\ndescription: Nested.\n---\n",
    });
    // dir itself has SKILL.md → treat as skill root, don't recurse
    const skills = await loadRemoteSkills(fs, "/skills");
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("root-skill");
  });
});
