import { stringify as toYaml } from "yaml";

export function proposeConfig(bootstrapperModel: string): string {
  const config = {
    version: 1,
    workspace: {
      baseBranch: "main",
      branchPrefix: "autopilot/",
    },
    commands: {
      verify: ["npm test"],
    },
    agents: {
      bootstrapper: { model: bootstrapperModel, thinking: "high" },
      implementer:  { model: "anthropic/claude-sonnet-4", thinking: "high" },
      reviewer:     { model: "anthropic/claude-sonnet-4", thinking: "high" },
      reconciler:   { model: "anthropic/claude-sonnet-4", thinking: "high" },
    },
  };
  return toYaml(config, { lineWidth: 0 });
}
