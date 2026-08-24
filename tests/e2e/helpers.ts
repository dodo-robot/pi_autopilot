import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram } from "../../src/cli.js";
import type { CliDeps } from "../../src/cli.js";
import type {
  CreatePullRequestInput,
  GitHubIssue,
  GitHubPort,
  IssueCommentRef,
  PullRequestRef,
} from "../../src/github/github-adapter.js";
import type { RepositoryContext } from "../../src/github/repository-context.js";
import { safeProcessEnv } from "../../src/github/repository-context.js";
import { ProcessRunner } from "../../src/platform/process-runner.js";
import type { FakeScenario } from "../../src/testing/fake-pi.js";

/**
 * Shared fixtures for the M1 acceptance suite (`tests/e2e/*.test.ts`).
 * Deliberately NOT a `*.test.ts` file: vitest treats every matching file
 * as an independent test module, so re-exporting helpers from a real test
 * file would import (and therefore re-run) that file's `describe`/`it`
 * blocks a second time whenever another suite imports it, and their
 * shared top-level fixture-repo names would collide under vitest's
 * parallel file execution. See "Fixture collision warning" in the task
 * brief.
 *
 * Every suite that imports this module exercises the COMPILED CLI
 * (`buildProgram` wired with the real `PiRunner`, real `WorkspaceManager`,
 * real `VerificationRunner`, and real `Publisher` — no scripted
 * `RunPiRunner`/`RefinerRunner` fake is injected anywhere). The only test
 * seams used are constructor-injection points that already exist in
 * `src/cli.ts` for exactly this purpose:
 *
 *   - `createGitHub`: returns an in-memory fake satisfying `GitHubPort`,
 *     the same seam every command-level integration test in this repo
 *     uses in place of a real `gh`-authenticated Octokit client.
 *   - `piCommand`: overrides the `pi` executable `PiRunner` spawns. It is
 *     pointed at the compiled `dist/testing/fake-pi.js` binary — a real,
 *     standalone, scenario-driven executable (`src/testing/fake-pi.ts`),
 *     not an environment-controlled branch inside production code. Every
 *     other line of the workflow (readiness gate, workspace/branch
 *     creation, verification command execution, tree-hash/commit
 *     identity, PR/comment publication) runs for real against a fixture
 *     Git repository and bare remote.
 *   - `createRepositoryContext` (only on `run`/`resume`/`abandon`, per
 *     `RunCommandDeps`): `check` and `prepare` have no such seam and
 *     always call the real `resolveRepositoryContext`, which rejects any
 *     `origin` that isn't a GitHub-shaped URL (it never contacts GitHub
 *     itself — the check is a pure string parse). So the fixture's
 *     `origin` is a GitHub-shaped URL while running `check`/`prepare`,
 *     then rewritten to the real bare-repo remote before `run`/`resume`,
 *     which supply a synthetic `RepositoryContext` and only ever need
 *     `origin` for real `git push`.
 *
 * `npm run build` must run before any e2e suite (`test:e2e` depends on the
 * compiled `dist/testing/fake-pi.js`); {@link requireCompiledFakePi} fails
 * with a clear message otherwise.
 */

export const FAKE_PI_PATH = fileURLToPath(
  new URL("../../dist/testing/fake-pi.js", import.meta.url),
);

export function requireCompiledFakePi(): string {
  if (!existsSync(FAKE_PI_PATH)) {
    throw new Error(
      `compiled fake Pi executable not found at ${FAKE_PI_PATH}; run 'npm run build' before the e2e suite`,
    );
  }
  chmodSync(FAKE_PI_PATH, 0o755);
  return FAKE_PI_PATH;
}

export const MINIMAL_YAML = `version: 1
commands:
  setup:
    - "true"
  verify:
    - "test -f .verify-ok"
`;

export const OWNER = "acme";

/**
 * Build a GitHub issue whose body embeds the `FAKE_PI_SCENARIO:<path>`
 * marker `fake-pi` reads. The refiner prompt is built from this body, so
 * every `check`/`prepare`/readiness-phase-of-`run` refiner session can
 * find its scenario file. `scenarioPath` may be omitted for scenarios
 * that only need the refiner's built-in default (READY) behavior.
 */
export function makeIssue(
  scenarioPath: string | null,
  overrides: Partial<GitHubIssue> = {},
): GitHubIssue {
  const marker = scenarioPath !== null ? `\n\nFAKE_PI_SCENARIO:${scenarioPath}` : "";
  return {
    number: 42,
    nodeId: "I_42",
    title: "Add token refresh validation",
    body:
      [
        "Refresh tokens must be rejected when expired.",
        "",
        "## Acceptance criteria",
        "- [ ] A refresh with an expired token returns 401",
      ].join("\n") + marker,
    updatedAt: "2026-08-18T00:00:00Z",
    state: "open",
    htmlUrl: "https://github.com/acme/e2e-fixture/issues/42",
    ...overrides,
  };
}

/**
 * Build a refiner READY result whose `taskDraft.context` also embeds the
 * scenario marker, so it survives into the frozen `TaskSnapshot` and
 * therefore into the implementer/reviewer prompts (`run-service.ts`
 * builds those prompts from the snapshot, not the original issue body).
 */
export function readyRefinerPayload(
  scenarioPath: string,
  repoName: string,
  overrides: Partial<Record<string, unknown>> = {},
): unknown {
  return {
    outcome: "READY",
    taskDraft: {
      schemaVersion: 1,
      repository: { owner: OWNER, repo: repoName },
      issue: { number: 42, nodeId: "I_42", updatedAt: "2026-08-18T00:00:00Z" },
      // Slugifies to exactly "token-refresh" (WorkspaceManager.slugifyTitle),
      // matching the branch name the acceptance brief specifies verbatim.
      objective: "Token refresh",
      context: `The auth module owns session refresh. FAKE_PI_SCENARIO:${scenarioPath}`,
      expectedBehavior: ["Expired refresh tokens are rejected"],
      acceptanceCriteria: [
        { id: "ac1", text: "A refresh with an expired token returns 401" },
      ],
      constraints: [],
      nonGoals: [],
      validation: ["true"],
      dependencies: [],
      canonicalReferences: [],
      sourceBodyHash: "will-be-overwritten",
      ...overrides,
    },
    missingInformation: [],
    dependencies: [],
    ambiguities: [],
  };
}

export class FakeGitHubServer implements GitHubPort {
  issue: GitHubIssue;
  pullRequests: PullRequestRef[] = [];
  issueComments: IssueCommentRef[] = [];
  updateIssueBodyCalls = 0;
  private nextPrNumber = 100;
  private nextCommentId = 1;

  constructor(issue: GitHubIssue) {
    this.issue = issue;
  }

  async getIssue(): Promise<GitHubIssue> {
    return this.issue;
  }

  async findIssueByTitle(title: string): Promise<GitHubIssue | null> {
    const desired = title.trim().toLowerCase();
    const source = this as { issues?: Map<number, GitHubIssue>; issue?: GitHubIssue };
    const issues = source.issues !== undefined
      ? [...source.issues.values()]
      : source.issue !== undefined
        ? [source.issue]
        : [];
    return issues.find((issue) => issue.title.trim().toLowerCase() === desired) ?? null;
  }

  async updateIssueBody(number: number, body: string): Promise<GitHubIssue> {
    this.updateIssueBodyCalls += 1;
    this.issue = { ...this.issue, number, body, updatedAt: "2026-08-18T01:00:00Z" };
    return { ...this.issue };
  }

  async createIssueComment(_number: number, body: string): Promise<void> {
    this.issueComments.push({ id: this.nextCommentId++, body });
  }

  async closeIssue(_number: number): Promise<void> {
    this.issue = { ...this.issue, state: "closed" };
  }

  async findPullRequestByHead(head: string): Promise<PullRequestRef | null> {
    return this.pullRequests.find((pr) => pr.head === head) ?? null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    const number = this.nextPrNumber++;
    const pr: PullRequestRef = {
      number,
      url: `https://github.com/${OWNER}/e2e-fixture/pull/${number}`,
      head: input.head,
      state: "open",
    };
    this.pullRequests.push(pr);
    return pr;
  }

  async findIssueCommentByMarker(
    _issueNumber: number,
    marker: string,
  ): Promise<IssueCommentRef | null> {
    return this.issueComments.find((c) => c.body.includes(marker)) ?? null;
  }
}

/** Minimal fake bare-remote inspector used only for test assertions. */
export class FakeRemote {
  constructor(private readonly remotePath: string) {}

  async hasBranch(branch: string): Promise<boolean> {
    const runner = new ProcessRunner();
    const result = await runner.run({
      command: "git",
      args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      cwd: this.remotePath,
      timeoutMs: 10_000,
      env: safeProcessEnv(),
    });
    return result.exitCode === 0;
  }
}

/**
 * Temp directories created by helpers in this module, registered so each
 * importing suite's own `afterEach` can clean them up. Suites push their
 * own additional temp dirs (scenario dirs, etc.) onto the same array they
 * declare locally; this module only tracks what it itself creates
 * (fixture repos/remotes/data dirs) via {@link trackedTempDirs}.
 */
export const trackedTempDirs: string[] = [];

export async function git(cwd: string, args: string[]): Promise<string> {
  const runner = new ProcessRunner();
  const result = await runner.run({
    command: "git",
    args,
    cwd,
    timeoutMs: 30_000,
    env: safeProcessEnv(),
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/**
 * Create a bare remote plus a primary clone with one commit. `origin` is
 * set to a GitHub-shaped URL (required by `check`/`prepare`, which have
 * no repository-context test seam); `run`/`resume` rewrite it to the real
 * bare-remote path via {@link pointOriginAtBareRemote} immediately before
 * they need to push. Every fixture repo/remote/worktree-parent directory
 * this creates is tracked in {@link trackedTempDirs}. Callers MUST use a
 * distinct `repoName` per test (see the brief's fixture-collision
 * warning) — this repo already namespaces its own temp directories by
 * `repoName`, but the shared OS-tmpdir `.pi-autopilot-worktrees/<repoName>`
 * subtree is what actually collides if two tests reuse the same name
 * while running in parallel.
 */
export async function createFixtureRepo(
  repoName: string,
): Promise<{ root: string; remote: string }> {
  const remote = mkdtempSync(path.join(tmpdir(), `ap-e2e-remote-${repoName}-`));
  trackedTempDirs.push(remote);
  await git(remote, ["init", "--bare", "-b", "main"]);

  const root = mkdtempSync(path.join(tmpdir(), `ap-e2e-repo-${repoName}-`));
  trackedTempDirs.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["remote", "add", "origin", `git@github.com:${OWNER}/${repoName}.git`]);

  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(path.join(root, ".pi", "autopilot.yaml"), MINIMAL_YAML, "utf8");
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  trackedTempDirs.push(path.join(path.dirname(root), ".pi-autopilot-worktrees", repoName));
  return { root, remote };
}

export async function pointOriginAtBareRemote(root: string, remote: string): Promise<void> {
  await git(root, ["remote", "set-url", "origin", remote]);
  await git(root, ["push", "origin", "main"]);
}

/** Write a fresh scenario file (and reset its attempt-counter/log sidecars). */
export function writeScenario(dir: string, scenario: FakeScenario): string {
  const scenarioPath = path.join(dir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario), "utf8");
  rmSync(`${scenarioPath}.attempts.json`, { force: true });
  rmSync(`${scenarioPath}.log.jsonl`, { force: true });
  return scenarioPath;
}

export interface Harness {
  exitCodes: number[];
  stdoutLines: string[];
  stderrLines: string[];
  github: FakeGitHubServer;
  dataDir: string;
  run: (args: string[], overrides?: Partial<CliDeps>) => Promise<unknown>;
}

/**
 * Build a CLI harness for one fixture repo. `run` rebuilds `CliDeps` on
 * every call so `--confirm`/other per-command overrides can be supplied
 * without needing a second harness. The harness's own `dataDir` is
 * tracked in {@link trackedTempDirs}.
 */
export function makeHarness(root: string, repoName: string, issue: GitHubIssue): Harness {
  const exitCodes: number[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-e2e-data-"));
  trackedTempDirs.push(dataDir);
  const github = new FakeGitHubServer(issue);
  const fakePiPath = requireCompiledFakePi();

  const repositoryContext: RepositoryContext = {
    root,
    repository: { owner: OWNER, repo: repoName },
    originUrl: `git@github.com:${OWNER}/${repoName}.git`,
    currentBranch: "main",
    isClean: true,
  };

  const run = (args: string[], overrides: Partial<CliDeps> = {}) => {
    const deps: CliDeps = {
      cwd: root,
      dataDir,
      piCommand: fakePiPath,
      createRepositoryContext: async () => repositoryContext,
      createGitHub: async () => github,
      idFactory: () => "e2e-run-1",
      stdout: (text) => stdoutLines.push(text),
      stderr: (text) => stderrLines.push(text),
      setExitCode: (code) => exitCodes.push(code),
      ...overrides,
    };
    return buildProgram(deps).parseAsync(["node", "autopilot", ...args]);
  };

  return { exitCodes, stdoutLines, stderrLines, github, dataDir, run };
}

/** Remove and clear every temp directory tracked by helpers in this module. */
export function cleanupTrackedTempDirs(): void {
  while (trackedTempDirs.length > 0) {
    const dir = trackedTempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
}
