import { Command } from "commander";
import { appPaths } from "../platform/paths.js";
import { PidFile } from "../daemon/pid-file.js";

export interface StopCommandDeps {
  dataDir?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  /** Injectable: replaces process.kill(pid, "SIGTERM"). */
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Injectable: replaces setInterval polling. */
  waitForExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
}

const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

function defaultWaitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      try {
        process.kill(pid, 0);
        if (Date.now() >= deadline) {
          clearInterval(interval);
          resolve(false);
        }
      } catch {
        clearInterval(interval);
        resolve(true);
      }
    }, POLL_INTERVAL_MS);
  });
}

export function registerStopCommand(program: Command, deps: StopCommandDeps = {}): void {
  const stdout = deps.stdout ?? ((t: string) => process.stdout.write(`${t}\n`));
  const stderr = deps.stderr ?? ((t: string) => process.stderr.write(`${t}\n`));
  const setExitCode = deps.setExitCode ?? ((c: number) => {
    process.exitCode = c;
  });
  const sendSignal = deps.sendSignal ?? ((pid, sig) => process.kill(pid, sig));
  const waitForExit = deps.waitForExit ?? defaultWaitForExit;

  program
    .command("stop")
    .description("Stop the running daemon")
    .action(async () => {
      const paths = appPaths(deps.dataDir);
      const pidFile = new PidFile({
        pidPath: paths.pidPath,
        daemonDir: paths.daemonDir,
        sendSignal: (pid, sig) => sendSignal(pid, sig as NodeJS.Signals),
      });

      if (!pidFile.isLive()) {
        stderr("no daemon running");
        setExitCode(1);
        return;
      }

      const pid = pidFile.read()!;
      sendSignal(pid, "SIGTERM");

      const stopped = await waitForExit(pid, STOP_TIMEOUT_MS);
      if (stopped) {
        stdout(`daemon stopped (PID ${pid})`);
      } else {
        stderr(`daemon did not stop within ${STOP_TIMEOUT_MS / 1000}s (PID ${pid}) — kill manually`);
        setExitCode(1);
      }
    });
}
