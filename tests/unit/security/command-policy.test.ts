import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertWorkspacePath,
  evaluateShellCommand,
} from "../../../src/security/command-policy.js";

const ALLOW = ["npm", "npx", "node", "git", "find", "rg"];

describe("evaluateShellCommand", () => {
  it("allows a simple allowed command with flags", () => {
    expect(evaluateShellCommand("npm test -- --run", ALLOW)).toEqual({
      allowed: true,
    });
    expect(evaluateShellCommand("npx vitest run", ALLOW)).toEqual({
      allowed: true,
    });
  });

  it("allows read-only git subcommands when git is allowlisted", () => {
    expect(evaluateShellCommand("git status --short", ALLOW)).toEqual({
      allowed: true,
    });
    expect(evaluateShellCommand("git diff HEAD", ALLOW)).toEqual({
      allowed: true,
    });
    expect(evaluateShellCommand("git log --oneline -3", ALLOW)).toEqual({
      allowed: true,
    });
  });

  it("rejects shell operators and command composition", () => {
    expect(evaluateShellCommand("npm test && git push", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("npm test || echo hi", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("npm test; echo hi", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("npm test &", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("npm test | rg x", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("npm test < /dev/null", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("npm test > out.txt", ALLOW)).toMatchObject({
      allowed: false,
    });
  });

  it("rejects variable, command, and glob substitution", () => {
    expect(evaluateShellCommand("echo $HOME", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("echo $(whoami)", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("echo `whoami`", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("ls *.js", ALLOW)).toMatchObject({
      allowed: false,
    });
  });

  it("rejects destructive or remote git subcommands even when git is allowlisted", () => {
    expect(evaluateShellCommand("git reset --hard", ["git"])).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("git push", ["git"])).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("git merge main", ["git"])).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("git clean -fd", ["git"])).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("git branch -D foo", ["git"])).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("git checkout main", ["git"])).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("git fetch origin", ["git"])).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("git commit -m x", ["git"])).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("git remote add origin x", ["git"])).toMatchObject({
      allowed: false,
    });
  });

  it("rejects git without an allowed subcommand", () => {
    expect(evaluateShellCommand("git", ["git"])).toMatchObject({
      allowed: false,
    });
  });

  it("rejects gh anywhere in the command", () => {
    expect(evaluateShellCommand("gh pr list", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("npx -- gh pr create", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("npm exec -- gh issue close 1", ALLOW)).toMatchObject({
      allowed: false,
    });
  });

  it("rejects git subcommands smuggled through package executors", () => {
    expect(evaluateShellCommand("npm exec -- git push", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("npx -- git push", ALLOW)).toMatchObject({
      allowed: false,
    });
  });

  it("rejects shell wrappers that bypass token-level checks", () => {
    expect(evaluateShellCommand("bash -c 'git push'", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("sh -c 'npm test && git push'", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("env git push", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("sudo npm test", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("xargs rm", ALLOW)).toMatchObject({
      allowed: false,
    });
  });

  it("rejects absolute or relative command paths", () => {
    expect(evaluateShellCommand("/usr/bin/npm test", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("./script.sh", ALLOW)).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("../bin/x", ALLOW)).toMatchObject({
      allowed: false,
    });
  });

  it("rejects commands outside the allowlist", () => {
    expect(evaluateShellCommand("curl https://evil.example", ["npm"])).toMatchObject({
      allowed: false,
    });
    expect(evaluateShellCommand("python -c 'x'", ["npm"])).toMatchObject({
      allowed: false,
    });
  });

  it("rejects empty, whitespace-only, and newline-terminated input", () => {
    expect(evaluateShellCommand("", ALLOW)).toMatchObject({ allowed: false });
    expect(evaluateShellCommand("   ", ALLOW)).toMatchObject({ allowed: false });
    expect(evaluateShellCommand("npm test\nrm -rf /", ALLOW)).toMatchObject({
      allowed: false,
    });
  });

  it("does not require the first token to be allowlisted twice for git", () => {
    expect(evaluateShellCommand("git diff --stat HEAD~1", ["git"])).toEqual({
      allowed: true,
    });
  });
});

describe("assertWorkspacePath", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ap-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "ap-outside-"));
  const outsideSecret = path.join(outside, "secret.txt");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts existing and new paths inside the worktree", () => {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), "x");
    expect(assertWorkspacePath(root, "src/a.ts", [])).toBe(
      realpathSync(path.join(root, "src", "a.ts")),
    );
    expect(assertWorkspacePath(root, "src/new-file.ts", [])).toBe(
      path.join(realpathSync(root), "src", "new-file.ts"),
    );
    expect(assertWorkspacePath(root, root, [])).toBe(realpathSync(root));
  });

  it("rejects paths outside the worktree", () => {
    expect(() => assertWorkspacePath(root, "../secret", [])).toThrow(
      "outside worktree",
    );
    expect(() => assertWorkspacePath(root, "/etc/passwd", [])).toThrow(
      "outside worktree",
    );
  });

  it("rejects symlink escapes through existing ancestors", () => {
    writeFileSync(outsideSecret, "top secret");
    symlinkSync(outside, path.join(root, "link-out"));
    expect(() => assertWorkspacePath(root, "link-out/secret.txt", [])).toThrow(
      "outside worktree",
    );
  });

  it("rejects paths under protected paths", () => {
    mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "x");
    expect(() =>
      assertWorkspacePath(root, ".github/workflows/ci.yml", [".github/workflows"]),
    ).toThrow("protected");
    expect(() => assertWorkspacePath(root, "src/a.ts", ["src"])).toThrow(
      "protected",
    );
  });

  it("accepts sibling paths of a protected path", () => {
    const rootReal = realpathSync(root);
    expect(assertWorkspacePath(root, "src-other/b.ts", ["src"])).toBe(
      path.join(rootReal, "src-other", "b.ts"),
    );
    expect(assertWorkspacePath(root, ".github/README.md", [".github/workflows"])).toBe(
      path.join(rootReal, ".github", "README.md"),
    );
  });
});
