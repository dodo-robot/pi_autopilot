import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";
import { BootstrapService, BootstrapSizeError } from "../../../src/bootstrap/bootstrap-service.js";
import type { BootstrapperResult } from "../../../src/domain/contracts.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import type { AutopilotConfig } from "../../../src/config/schema.js";
import type { RequirementDoc } from "../../../src/reconciliation/prompt.js";

let tmpDir: string;
afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

const repository: RepositoryContext = {
  root: "/tmp/fake-repo",
  repository: { owner: "acme", repo: "widgets" },
  originUrl: "git@github.com:acme/widgets.git",
  currentBranch: "main",
  isClean: true,
};

const config = {
  bootstrap: { tokenThreshold: 80_000, requirementsPaths: undefined },
  agentPolicy: { protectedPaths: [] },
} as unknown as AutopilotConfig;

const model = { model: "anthropic/claude-haiku", thinking: "high" as const, source: "repository" as const };

const goodResult: BootstrapperResult = {
  projectBoard: { title: "Widgets", columns: ["Todo", "In Progress", "Done"] },
  epics: [{ title: "Auth", description: "Authentication", issues: [{ title: "Login", body: "..." }] }],
  dependencies: [],
  tracks: [{ wave: 1, issues: ["Login"] }],
};

class FakePi {
  calls: PiRunRequest[] = [];
  async run(req: PiRunRequest): Promise<PiExecution> {
    this.calls.push(req);
    return {
      result: goodResult,
      exitCode: 0,
      durationMs: 100,
      stdout: "",
      stderr: "",
      resultPath: "/fake/result.json",
      sessionDir: "/fake/session",
    };
  }
}

function makeService(pi = new FakePi(), threshold = 80_000) {
  tmpDir = mkdtempSync(path.join(tmpdir(), "bootstrap-service-test-"));
  const paths = appPaths(tmpDir);
  const artifacts = new ArtifactStore(paths);
  return {
    service: new BootstrapService({
      repository,
      config: { ...config, bootstrap: { tokenThreshold: threshold } } as unknown as AutopilotConfig,
      pi,
      artifacts,
      paths,
      bootstrapperModel: model,
      bootstrapperTimeoutMs: 5_000,
      planId: "bootstrap-20260823-test01",
      now: () => "2026-08-23T10:00:00Z",
    }),
    pi,
    paths,
  };
}

const doc: RequirementDoc = { path: "requirements.md", content: "## Auth\nUsers must log in." };

describe("BootstrapService.plan", () => {
  it("calls Pi and returns a plan ID and markdown path", async () => {
    const { service, pi } = makeService();
    const result = await service.plan([doc]);
    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0].role).toBe("bootstrapper");
    expect(result.planId).toBe("bootstrap-20260823-test01");
    expect(result.markdownPath).toContain("bootstrap-plan.md");
  });

  it("throws BootstrapSizeError when docs exceed threshold", async () => {
    const { service } = makeService(new FakePi(), 1); // threshold of 1 token
    await expect(service.plan([doc])).rejects.toBeInstanceOf(BootstrapSizeError);
  });

  it("saves plan.json that can be loaded back", async () => {
    const { service, paths } = makeService();
    const { planId } = await service.plan([doc]);
    const artifacts = new ArtifactStore(paths);
    const raw = await artifacts.readJson(planId, "plan.json");
    expect((raw as { planId: string }).planId).toBe(planId);
  });
});
