import { sshExec } from "./fs-ops.js";

export interface SshState {
  remote: string;
  remoteCwd: string;
}

/**
 * Reads --ssh flag from argv.
 * Avoids cross-extension flag registry dependency and any session_start races.
 * Supports both `--ssh user@host` and `--ssh=user@host` forms.
 */
export function readSshFlag(): string | undefined {
  const args = process.argv;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--ssh" && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith("--ssh=")) return args[i].slice(6);
  }
  return undefined;
}

/**
 * Parses the --ssh flag value and resolves the remote cwd.
 * Mirrors the resolution logic in ssh.ts so both extensions agree on state.
 *
 * Flag formats:
 *   user@host:/path
 *   user@host  → cwd resolved via `ssh user@host pwd`
 */
export async function resolveSshState(flag: string): Promise<SshState> {
  const colonIdx = flag.indexOf(":");
  if (colonIdx !== -1) {
    const remote = flag.slice(0, colonIdx);
    const rawCwd = flag.slice(colonIdx + 1);
    // Resolve to absolute path: handles ~, relative paths, and symlinks.
    // Unquoted so the remote shell expands ~ and processes the path normally.
    const remoteCwd = (await sshExec(remote, `cd ${rawCwd} && pwd`)).trim();
    return { remote, remoteCwd };
  }
  const remoteCwd = (await sshExec(flag, "pwd")).trim();
  return { remote: flag, remoteCwd };
}
