import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import type { AbandonCommandDeps } from "./commands/abandon.js";
import { registerAbandonCommand } from "./commands/abandon.js";
import type { AnalyzeCommandDeps } from "./commands/analyze.js";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import type { CheckCommandDeps } from "./commands/check.js";
import { registerCheckCommand } from "./commands/check.js";
import type { InspectCommandDeps } from "./commands/inspect.js";
import { registerInspectCommand } from "./commands/inspect.js";
import type { PrepareCommandDeps } from "./commands/prepare.js";
import { registerPrepareCommand } from "./commands/prepare.js";
import type { ReconcileCommandDeps } from "./commands/reconcile.js";
import { registerReconcileCommand } from "./commands/reconcile.js";
import type { BootstrapCommandDeps } from "./commands/bootstrap.js";
import { registerBootstrapCommand } from "./commands/bootstrap.js";
import type { ResumeCommandDeps } from "./commands/resume.js";
import { registerResumeCommand } from "./commands/resume.js";
import type { RunCommandDeps } from "./commands/run.js";
import { registerRunCommand } from "./commands/run.js";
import type { RunsCommandDeps } from "./commands/runs.js";
import { registerRunsCommand } from "./commands/runs.js";
import type { StatusCommandDeps } from "./commands/status.js";
import { registerStatusCommand } from "./commands/status.js";
import type { StartCommandDeps } from "./commands/start.js";
import { registerStartCommand } from "./commands/start.js";
import type { StopCommandDeps } from "./commands/stop.js";
import { registerStopCommand } from "./commands/stop.js";

export type CliDeps = CheckCommandDeps &
  PrepareCommandDeps &
  AnalyzeCommandDeps &
  RunCommandDeps &
  StatusCommandDeps &
  InspectCommandDeps &
  ResumeCommandDeps &
  RunsCommandDeps &
  AbandonCommandDeps &
  StartCommandDeps &
  StopCommandDeps &
  ReconcileCommandDeps &
  BootstrapCommandDeps;

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
  registerPrepareCommand(program, deps);
  registerAnalyzeCommand(program, deps);
  registerReconcileCommand(program, deps);
  registerBootstrapCommand(program, deps);
  registerRunCommand(program, deps);
  registerRunsCommand(program, deps);
  registerStatusCommand(program, deps);
  registerInspectCommand(program, deps);
  registerResumeCommand(program, deps);
  registerAbandonCommand(program, deps);
  registerStartCommand(program, deps);
  registerStopCommand(program, deps);
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
    const entry = realpathSync(argv1);
    // Direct launch of the source/compiled module via tsx or `node dist/cli.js`:
    // the running entry IS this module.
    if (import.meta.url === pathToFileURL(entry).href) return true;
    // npm-link / global install (`autopilot`) launches the bin/autopilot.js
    // shim, which imports ../dist/cli.js and therefore has a different argv[1].
    return entry.endsWith(`${sep}bin${sep}autopilot.js`);
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
