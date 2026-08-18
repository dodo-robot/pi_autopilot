import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadRepositoryConfig,
  resolveRoleModel,
} from "../../../src/config/load-config.js";
import type {
  AutopilotConfig,
  RoleAgentsConfig,
  RoleModelEntry,
  RoleModelOverride,
} from "../../../src/config/schema.js";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/config",
);

function tempConfigRoot(yaml: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "autopilot-config-"));
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(path.join(root, ".pi", "autopilot.yaml"), yaml, "utf8");
  return root;
}

function loadMinimalFixture(): Promise<AutopilotConfig> {
  const raw = readFileSync(path.join(fixtureDir, "minimal.yaml"), "utf8");
  return loadRepositoryConfig(tempConfigRoot(raw));
}

describe("loadRepositoryConfig", () => {
  it("loads and validates a minimal repository config", async () => {
    const config = await loadMinimalFixture();
    expect(config.version).toBe(1);
    expect(config.commands.verify).toEqual(["npm test"]);
    expect(config.commands.setup).toEqual(["npm ci"]);
    expect(config.agents.implementer?.model).toBe("anthropic/claude-sonnet-4");
    expect(config.workspace.baseBranch).toBe("main");
    expect(config.agentPolicy.allowedCommands).toEqual([
      "npm",
      "npx",
      "node",
      "rg",
      "find",
    ]);
    expect(config.publication.autoMerge).toBe(false);
  });

  it("applies documented defaults for omitted optional sections", async () => {
    const root = tempConfigRoot(
      `version: 1\ncommands:\n  verify:\n    - npm test\n`,
    );
    const config = await loadRepositoryConfig(root);
    expect(config.workspace.baseBranch).toBe("main");
    expect(config.workspace.requireCleanCheckout).toBe(true);
    expect(config.agentPolicy.allowNetwork).toBe(false);
    expect(config.budgets.review.maxCorrectionCycles).toBe(2);
    expect(config.budgets.implementation.maxAttempts).toBe(3);
  });

  it("rejects a config with an empty verification command list", async () => {
    const root = tempConfigRoot(
      `version: 1\ncommands:\n  setup:\n    - npm ci\n  verify: []\n`,
    );
    await expect(loadRepositoryConfig(root)).rejects.toThrow(
      "commands.verify must contain at least one command",
    );
  });

  it("rejects a config with no commands section at all", async () => {
    const root = tempConfigRoot(`version: 1\n`);
    await expect(loadRepositoryConfig(root)).rejects.toThrow(
      /commands|verify/,
    );
  });

  it("rejects an unsupported schema version", async () => {
    const root = tempConfigRoot(
      `version: 2\ncommands:\n  verify:\n    - npm test\n`,
    );
    await expect(loadRepositoryConfig(root)).rejects.toThrow(
      /version|literal|Expected/i,
    );
  });

  it("rejects a missing config file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "autopilot-noconfig-"));
    await expect(loadRepositoryConfig(root)).rejects.toThrow(
      /missing repository config/,
    );
  });
});

describe("resolveRoleModel", () => {
  const piDefault: RoleModelEntry = {
    model: "anthropic/claude-haiku",
    thinking: "low",
  };

  const userAgents: RoleAgentsConfig = {
    refiner: { model: "anthropic/claude-sonnet-4", thinking: "medium" },
  };

  const repoAgents: RoleAgentsConfig = {
    reviewer: { model: "openai/gpt-5.2", thinking: "high" },
  };

  it("applies a CLI override above repository and user defaults", () => {
    const cli: RoleModelOverride = { model: "openai/gpt-5.2", thinking: "high" };
    expect(
      resolveRoleModel("reviewer", cli, repoAgents, userAgents, piDefault),
    ).toEqual({
      model: "openai/gpt-5.2",
      thinking: "high",
      source: "cli",
    });
  });

  it("falls back to repository, then user, then Pi default", () => {
    expect(
      resolveRoleModel("reviewer", null, repoAgents, userAgents, piDefault),
    ).toEqual({ model: "openai/gpt-5.2", thinking: "high", source: "repository" });

    expect(
      resolveRoleModel("refiner", null, null, userAgents, piDefault),
    ).toEqual({
      model: "anthropic/claude-sonnet-4",
      thinking: "medium",
      source: "user",
    });

    expect(resolveRoleModel("refiner", null, null, null, piDefault)).toEqual({
      model: "anthropic/claude-haiku",
      thinking: "low",
      source: "pi-default",
    });
  });

  it("merges a partial CLI override into the resolved entry", () => {
    const cli: RoleModelOverride = { model: "openai/gpt-5.2" };
    expect(
      resolveRoleModel("implementer", cli, null, userAgents, piDefault),
    ).toEqual({ model: "openai/gpt-5.2", thinking: "low", source: "cli" });
  });

  it("uses the repository entry only for the requested role", () => {
    expect(
      resolveRoleModel("implementer", null, repoAgents, null, piDefault),
    ).toEqual({ model: "anthropic/claude-haiku", thinking: "low", source: "pi-default" });
  });
});
