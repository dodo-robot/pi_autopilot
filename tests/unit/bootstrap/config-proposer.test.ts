import { describe, expect, it } from "vitest";
import { proposeConfig } from "../../../src/bootstrap/config-proposer.js";
import { parse as parseYaml } from "yaml";
import { AutopilotConfigSchema } from "../../../src/config/schema.js";

describe("proposeConfig", () => {
  it("produces valid YAML that passes AutopilotConfigSchema", () => {
    const yaml = proposeConfig("anthropic/claude-sonnet-4");
    const parsed = parseYaml(yaml);
    // commands.verify must have at least one entry (schema requires min 1)
    const result = AutopilotConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("includes the bootstrapper model", () => {
    const yaml = proposeConfig("anthropic/claude-opus-4");
    expect(yaml).toContain("claude-opus-4");
  });

  it("includes all expected roles", () => {
    const yaml = proposeConfig("anthropic/claude-sonnet-4");
    expect(yaml).toContain("bootstrapper:");
    expect(yaml).toContain("implementer:");
    expect(yaml).toContain("reviewer:");
  });
});
