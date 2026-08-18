import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTrackedTempDirs,
  createFixtureRepo,
  FakeRemote,
  git,
  makeHarness,
  makeIssue,
  pointOriginAtBareRemote,
  readyRefinerPayload,
  writeScenario,
} from "./helpers.js";

/**
 * The M1 successful-run acceptance case: exercises the compiled CLI
 * through `check`, `prepare`, and `run` against a fixture repository and
 * bare remote, a fake GitHub server, and the scenario-driven fake Pi
 * executable. See `tests/e2e/helpers.ts` for the full explanation of how
 * this reconciles "compiled CLI" with "constructor-injection-only" test
 * seams.
 */

const localTempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs();
  while (localTempDirs.length > 0) {
    const dir = localTempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("supervised task run (compiled CLI, real workflow, fake Pi)", () => {
  it("runs check, prepare, and run end to end to an opened PR", async () => {
    const repoName = "e2e-fixture";
    const { root, remote } = await createFixtureRepo(repoName);
    const originalHead = await git(root, ["rev-parse", "HEAD"]);
    const scenarioDir = mkdtempSync(path.join(tmpdir(), "ap-e2e-scenario-"));
    localTempDirs.push(scenarioDir);
    const scenarioPath = path.join(scenarioDir, "scenario.json");

    writeScenario(scenarioDir, {
      steps: [
        {
          role: "refiner",
          action: "result",
          payload: readyRefinerPayload(scenarioPath, repoName),
        },
        {
          role: "implementer",
          action: "result",
          payload: {
            outcome: "COMPLETED",
            summary: "Implemented token refresh validation.",
            changedPaths: ["src/token-refresh.ts"],
            commandsAttempted: ["true"],
            unresolvedProblems: [],
            evidenceLocations: [],
          },
          mutate: {
            writeFiles: {
              "src/token-refresh.ts": "export const tokenRefresh = true;\n",
              ".verify-ok": "ok\n",
            },
          },
        },
      ],
    });
    const harness = makeHarness(root, repoName, makeIssue(scenarioPath));
    const remoteInspector = new FakeRemote(remote);

    // 1. `check` is read-only and must never mutate GitHub.
    await harness.run(["check", "42"]);
    expect(harness.exitCodes.at(-1)).toBe(0);
    expect(harness.github.updateIssueBodyCalls).toBe(0);
    expect(harness.stdoutLines.join("\n")).toContain("Status: READY");

    // 2. `prepare` previews and (with approval) applies only the managed
    // section. This fixture issue is already READY, so the applied
    // managed section still reflects a real, freshly-drafted execution
    // contract from a fresh (fake) refiner session.
    harness.stdoutLines.length = 0;
    harness.exitCodes.length = 0;
    await harness.run(["prepare", "42"], { confirm: async () => true });
    expect(harness.exitCodes.at(-1)).toBe(0);
    expect(harness.github.updateIssueBodyCalls).toBe(1);

    // 3. `run` executes the ready task end to end. `origin` now points at
    // the real bare remote so the publisher's `git push` succeeds.
    await pointOriginAtBareRemote(root, remote);
    harness.stdoutLines.length = 0;
    harness.exitCodes.length = 0;
    await harness.run(["run", "42"]);

    expect(harness.exitCodes.at(-1)).toBe(0);
    expect(await remoteInspector.hasBranch("autopilot/42-token-refresh")).toBe(true);
    expect(harness.github.pullRequests).toHaveLength(1);
    expect(harness.github.issueComments[0]!.body).toContain("Run ID:");

    const primaryCheckoutHead = await git(root, ["rev-parse", "HEAD"]);
    expect(primaryCheckoutHead).toBe(originalHead);
  });
});
