import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import type { CheckCommandDeps } from "./commands/check.js";
import { registerCheckCommand } from "./commands/check.js";

export type CliDeps = CheckCommandDeps;

/**
 * Build the autopilot CLI. Dependencies are injectable so command tests can
 * substitute fakes; real adapters are constructed lazily when omitted.
 */
export function buildProgram(deps: CliDeps = {}): Command {
  const program = new Command();
  program
    .name("autopilot")
    .description("Autonomous development orchestration for Pi")
    .version("0.1.0");
  registerCheckCommand(program, deps);
  return program;
}

/**
 * True only when this module is the process entry point. `realpathSync`
 * normalizes symlinked installs (e.g. `npm link`), so the comparison works
 * whether the CLI is launched via `tsx`, `node dist/cli.js`, or the `bin`
 * shim.
 */
function isEntryModule(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  void buildProgram()
    .parseAsync()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`autopilot: ${message}\n`);
      process.exitCode = 1;
    });
}
