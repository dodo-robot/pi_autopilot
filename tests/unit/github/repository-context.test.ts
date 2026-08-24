import { describe, expect, it } from "vitest";
import type {
  ProcessRequest,
  ProcessResult,
} from "../../../src/platform/process-runner.js";
import {
  assertRepositoryMatches,
  parseGitHubRemote,
  RepositoryContextError,
  resolveRepositoryContext,
  safeProcessEnv,
} from "../../../src/github/repository-context.js";

const REMOTE_SSH = "git@github.com:acme/widgets.git";

interface CannedResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/** Deterministic stand-in for a real git subprocess. */
class FakeRunner {
  readonly calls: string[] = [];

  constructor(private readonly responses: Record<string, CannedResult>) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    const key = [request.command, ...request.args].join(" ");
    this.calls.push(key);
    const entry = this.responses[key];
    if (entry === undefined) {
      throw new Error(`unexpected command: ${key}`);
    }
    return {
      exitCode: entry.exitCode ?? 0,
      signal: null,
      stdout: entry.stdout ?? "",
      stderr: entry.stderr ?? "",
      durationMs: 1,
      timedOut: false,
    };
  }
}

function gitRunner(
  overrides: Record<string, CannedResult> = {},
): FakeRunner {
  return new FakeRunner({
    "git rev-parse --show-toplevel": { stdout: "/tmp/repo" },
    "git remote get-url origin": { stdout: REMOTE_SSH },
    "git status --porcelain": { stdout: "" },
    "git branch --show-current": { stdout: "main" },
    ...overrides,
  });
}

describe("parseGitHubRemote", () => {
  it("parses SSH remotes", () => {
    expect(parseGitHubRemote("git@github.com:acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses HTTPS remotes with and without a .git suffix", () => {
    expect(parseGitHubRemote("https://github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(parseGitHubRemote("https://github.com/acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses http and ssh URL forms", () => {
    expect(parseGitHubRemote("http://github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(parseGitHubRemote("ssh://git@github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });

  it("accepts SSH host aliases of github.com", () => {
    expect(parseGitHubRemote("git@github.com-smityx:Smityx/revalbis.git")).toEqual({
      owner: "Smityx",
      repo: "revalbis",
    });
    expect(parseGitHubRemote("git@github.com-other:acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });

  it("rejects non-GitHub remotes", () => {
    expect(parseGitHubRemote("git@gitlab.com:acme/widgets.git")).toBeNull();
    expect(parseGitHubRemote("https://example.com/acme/widgets.git")).toBeNull();
    expect(parseGitHubRemote("")).toBeNull();
  });
});

describe("resolveRepositoryContext", () => {
  it("resolves the canonical root, origin, branch, and cleanliness", async () => {
    const runner = gitRunner();
    const ctx = await resolveRepositoryContext("/tmp/repo", runner);
    expect(ctx).toEqual({
      root: "/tmp/repo",
      repository: { owner: "acme", repo: "widgets" },
      originUrl: REMOTE_SSH,
      currentBranch: "main",
      isClean: true,
    });
    expect(runner.calls).toEqual([
      "git rev-parse --show-toplevel",
      "git remote get-url origin",
      "git status --porcelain",
      "git branch --show-current",
    ]);
  });

  it("reports a dirty checkout without failing", async () => {
    const runner = gitRunner({ "git status --porcelain": { stdout: " M src/a.ts\n?? untracked.txt" } });
    const ctx = await resolveRepositoryContext("/tmp/repo", runner);
    expect(ctx.isClean).toBe(false);
  });

  it("fails when the directory is not a git repository", async () => {
    const runner = gitRunner({
      "git rev-parse --show-toplevel": { exitCode: 128, stderr: "fatal: not a git repository" },
    });
    await expect(resolveRepositoryContext("/tmp/nope", runner)).rejects.toThrow(
      RepositoryContextError,
    );
    await expect(resolveRepositoryContext("/tmp/nope", runner)).rejects.toThrow(
      /not a git repository/,
    );
  });

  it("fails when no origin remote is configured", async () => {
    const runner = gitRunner({
      "git remote get-url origin": { exitCode: 2, stderr: "error: No such remote" },
    });
    await expect(resolveRepositoryContext("/tmp/repo", runner)).rejects.toThrow(
      /no git remote 'origin'/,
    );
  });

  it("fails when the origin is not a GitHub repository", async () => {
    const runner = gitRunner({
      "git remote get-url origin": { stdout: "git@gitlab.com:acme/widgets.git" },
    });
    await expect(resolveRepositoryContext("/tmp/repo", runner)).rejects.toThrow(
      /not a GitHub repository/,
    );
  });
});

describe("safeProcessEnv", () => {
  it("propagates provider keys and PI selectors", () => {
    const keyName = "TEST_PROPAGATE_DEEPSEEK_API_KEY";
    const original = process.env.DEEPSEEK_API_KEY;
    const originalPi = process.env.PI_MODEL;
    process.env.DEEPSEEK_API_KEY = "sk-test-123";
    process.env.PI_MODEL = "deepseek/deepseek-v4-flash";
    try {
      const env = safeProcessEnv();
      expect(env.DEEPSEEK_API_KEY).toBe("sk-test-123");
      expect(env.PI_MODEL).toBe("deepseek/deepseek-v4-flash");
      // Non-listed secrets are not leaked.
      process.env[keyName] = "secret";
      expect(safeProcessEnv()[keyName]).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = original;
      if (originalPi === undefined) delete process.env.PI_MODEL;
      else process.env.PI_MODEL = originalPi;
      delete process.env[keyName];
    }
  });
});

describe("assertRepositoryMatches", () => {
  const ctx = {
    root: "/tmp/repo",
    repository: { owner: "acme", repo: "widgets" },
    originUrl: REMOTE_SSH,
    currentBranch: "main",
    isClean: true,
  };

  it("accepts a matching repository reference", () => {
    expect(() =>
      assertRepositoryMatches(ctx, { owner: "acme", repo: "widgets" }),
    ).not.toThrow();
  });

  it("rejects a mismatched owner or repo", () => {
    expect(() =>
      assertRepositoryMatches(ctx, { owner: "other", repo: "widgets" }),
    ).toThrow(/belongs to other\/widgets but origin is acme\/widgets/);
    expect(() =>
      assertRepositoryMatches(ctx, { owner: "acme", repo: "other" }),
    ).toThrow(/belongs to acme\/other but origin is acme\/widgets/);
  });
});
