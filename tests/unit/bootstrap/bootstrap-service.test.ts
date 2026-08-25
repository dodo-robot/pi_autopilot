import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";
import { BootstrapService, BootstrapSizeError } from "../../../src/bootstrap/bootstrap-service.js";
import type { BootstrapServiceDeps } from "../../../src/bootstrap/bootstrap-service.js";
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
  bootstrap: { tokenThreshold: 80_000, requirementsPaths: undefined, skillPaths: [] },
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

function makeService(
  pi = new FakePi(),
  threshold = 80_000,
  github?: {
    listOpenEpicTitles: () => Promise<string[]>;
    listOpenLeafIssues?: () => Promise<Array<{ number: number; title: string; requirementCodes: string[] }>>;
  },
) {
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
      github,
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

  it("fetches open epic titles from GitHub and includes them verbatim in the prompt", async () => {
    const pi = new FakePi();
    const github = {
      listOpenEpicTitles: async () => ["M1 — Data Ingestion & Staging", "M2 — Motore di Calcolo"],
    };
    const { service } = makeService(pi, 80_000, github);
    await service.plan([doc]);
    expect(pi.calls[0].prompt).toContain("M1 — Data Ingestion & Staging");
    expect(pi.calls[0].prompt).toContain("M2 — Motore di Calcolo");
  });

  it("fetches open leaf issues from GitHub and includes them in the prompt", async () => {
    const pi = new FakePi();
    const github = {
      listOpenEpicTitles: async () => [],
      listOpenLeafIssues: async () => [
        { number: 123, title: "M1-13 Scorporo cespite in sotto-cespiti", requirementCodes: ["RF-M1-030"] },
      ],
    };
    const { service } = makeService(pi, 80_000, github);
    await service.plan([doc]);
    expect(pi.calls[0].prompt).toContain("#123");
    expect(pi.calls[0].prompt).toContain("RF-M1-030");
  });

  it("falls back to no existing epics when the GitHub lookup fails, without failing plan()", async () => {
    const pi = new FakePi();
    const github = {
      listOpenEpicTitles: async () => {
        throw new Error("gh is not authenticated");
      },
    };
    const { service } = makeService(pi, 80_000, github);
    const result = await service.plan([doc]);
    expect(result.planId).toBe("bootstrap-20260823-test01");
    expect(pi.calls[0].prompt).toMatch(/no (existing )?(open )?epics/i);
  });

  it("works without a github dep at all (existing callers keep working)", async () => {
    const { service, pi } = makeService();
    await service.plan([doc]);
    expect(pi.calls[0].prompt).toMatch(/no (existing )?(open )?epics/i);
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

  it("answers a bootstrapper question via the onQuestion seam", async () => {
    const { service, pi } = makeService();
    // Patch the pi fixture to emit a question file during the run and wait for
    // the answer before submitting the result.
    const originalFake = pi;
    originalFake.calls = [];
    originalFake.run = async (req: PiRunRequest): Promise<PiExecution> => {
      originalFake.calls.push(req);
      const askDir = path.join(req.diagnosticsDir, "ask");
      mkdirSync(askDir, { recursive: true });
      const questionFile = path.join(askDir, "000-question.json");
      writeFileSync(questionFile, JSON.stringify({ seq: 0, question: "Which scope?", context: "look" }), "utf8");
      // Wait for the pump to write the answer (simulates ask_human blocking).
      const answerFile = path.join(askDir, "000-answer.json");
      const deadline = Date.now() + 3_000;
      while (!existsSync(answerFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!existsSync(answerFile)) {
        throw new Error("answer never arrived");
      }
      return {
        result: goodResult,
        exitCode: 0,
        durationMs: 100,
        stdout: "",
        stderr: "",
        resultPath: path.join(req.diagnosticsDir, "result.json"),
        sessionDir: req.sessionDir,
      };
    };

    // Swap in a service wired with onQuestion.
    const paths = (await import("../../../src/platform/paths.js")).appPaths(tmpDir);
    const artifacts = new ArtifactStore(paths);
    const svc = new BootstrapService({
      repository,
      config: { ...config, bootstrap: { tokenThreshold: 80_000, skillPaths: [] } } as unknown as AutopilotConfig,
      pi: originalFake as unknown as BootstrapServiceDeps["pi"],
      artifacts,
      paths,
      bootstrapperModel: model,
      planId: "bootstrap-20260823-test01",
      now: () => "2026-08-23T10:00:00Z",
      onQuestion: async (q) => {
        expect(q.question).toBe("Which scope?");
        return "M1 only";
      },
    });
    await svc.plan([doc]);
  });

  it("writes a RESUME.txt pointer when the session times out", async () => {
    const { service, pi, paths } = makeService();
    const originalFake = pi;
    originalFake.run = async (req: PiRunRequest): Promise<PiExecution> => {
      originalFake.calls.push(req);
      // Simulate a session dir with a conversation file present, then throw a
      // PiRunError whose message matches the timeout pattern.
      mkdirSync(req.sessionDir, { recursive: true });
      writeFileSync(path.join(req.sessionDir, "session.jsonl"), "{}", "utf8");
      mkdirSync(path.join(req.diagnosticsDir, "ask"), { recursive: true });
      const err = new (await import("../../../src/pi/pi-runner.js")).PiRunError(
        "bootstrapper session timed out after 90ms",
        "bootstrapper",
        { stdout: "", stderr: "", resultPath: path.join(req.diagnosticsDir, "result.json") },
      );
      throw err;
    };
    await expect(service.plan([doc])).rejects.toThrow(/timed out/);
    // planId run dir should have a RESUME.txt pointing at the session + ask dir.
    const runDir = path.join(paths.runDir("bootstrap-20260823-test01"));
    const resumePath = path.join(runDir, "RESUME.txt");
    expect(existsSync(resumePath)).toBe(true);
    const content = readFileSync(resumePath, "utf8");
    expect(content).toContain("bootstrap-20260823-test01");
    expect(content).toContain("session");
    expect(content).toContain("ask");
  });
});
