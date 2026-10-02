import { execFileSync } from "node:child_process";

/** A supplied release SHA wins; source archives without Git stay clearly local. */
export function resolveBuildCommit(directory: string, override?: string): string {
  if (override !== undefined) {
    if (!/^[a-f\d]{40}$/i.test(override)) {
      throw new Error("HORNER_BUILD_SHA must be a full Git commit hash.");
    }
    return override.slice(0, 7).toLowerCase();
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[a-f\d]{40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : "local";
  } catch {
    return "local";
  }
}
