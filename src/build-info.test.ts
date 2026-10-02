import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveBuildCommit } from "../scripts/build-info.js";

describe("build identification", () => {
  it("embeds the package version and build in the Vite app", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(__APP_VERSION__).toBe(pkg.version);
    expect(__APP_BUILD__).toMatch(/^(?:[a-f\d]{7}|local)$/);
  });

  it("uses an explicit full release SHA without consulting Git", () => {
    expect(resolveBuildCommit("/does-not-exist", "ABCDEF0123456789abcdef0123456789abcdef0123"))
      .toBe("abcdef0");
  });

  it.each(["", "main", "abcdef0", "x".repeat(40)])("rejects an invalid release SHA: %s", (sha) => {
    expect(() => resolveBuildCommit(".", sha)).toThrow("full Git commit hash");
  });

  it("identifies the checked-out commit", () => {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(resolveBuildCommit(process.cwd())).toBe(sha.slice(0, 7));
  });

  it("uses a clear local fallback for source archives without Git metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "horner-build-info-"));
    try {
      expect(resolveBuildCommit(directory)).toBe("local");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
