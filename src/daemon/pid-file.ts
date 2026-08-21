import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export interface PidFileDeps {
  pidPath: string;
  daemonDir: string;
  sendSignal?: (pid: number, signal: number | NodeJS.Signals) => void;
  fs?: {
    mkdirSync(path: string, opts: { recursive: boolean }): void;
    writeFileSync(path: string, data: string): void;
    readFileSync(path: string, encoding: "utf8"): string;
    unlinkSync(path: string): void;
    existsSync(path: string): boolean;
  };
}

export class PidFile {
  private readonly pidPath: string;
  private readonly daemonDir: string;
  private readonly sendSignal: (pid: number, signal: number | NodeJS.Signals) => void;
  private readonly fns: NonNullable<PidFileDeps["fs"]>;

  constructor(deps: PidFileDeps) {
    this.pidPath = deps.pidPath;
    this.daemonDir = deps.daemonDir;
    this.sendSignal = deps.sendSignal ?? ((pid, sig) => process.kill(pid, sig));
    this.fns = deps.fs ?? {
      mkdirSync,
      writeFileSync,
      readFileSync,
      unlinkSync,
      existsSync,
    };
  }

  write(): void {
    this.writePid(process.pid);
  }

  writePid(pid: number): void {
    this.fns.mkdirSync(this.daemonDir, { recursive: true });
    this.fns.writeFileSync(this.pidPath, String(pid));
  }

  read(): number | null {
    if (!this.fns.existsSync(this.pidPath)) return null;
    const raw = this.fns.readFileSync(this.pidPath, "utf8").trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  delete(): void {
    if (!this.fns.existsSync(this.pidPath)) return;
    this.fns.unlinkSync(this.pidPath);
  }

  isLive(): boolean {
    const pid = this.read();
    if (pid === null) return false;
    try {
      this.sendSignal(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        this.delete();
        return false;
      }
      // EPERM means process exists but we can't signal it — still live
      return true;
    }
  }
}
