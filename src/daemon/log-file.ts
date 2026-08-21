import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export class LogFile {
  private readonly logPath: string;
  private readonly daemonDir: string;
  private readonly maxBytes: number;

  constructor(deps: { logPath: string; daemonDir: string; maxBytes?: number }) {
    this.logPath = deps.logPath;
    this.daemonDir = deps.daemonDir;
    this.maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  info(message: string): void {
    this.append("INFO", message);
  }

  error(message: string): void {
    this.append("ERROR", message);
  }

  private append(level: string, message: string): void {
    mkdirSync(this.daemonDir, { recursive: true });
    this.maybeRotate();
    const line = `${new Date().toISOString()} [${level}]  ${message}\n`;
    appendFileSync(this.logPath, line);
  }

  private maybeRotate(): void {
    if (!existsSync(this.logPath)) return;
    const { size } = statSync(this.logPath);
    if (size <= this.maxBytes) return;
    renameSync(this.logPath, `${this.logPath}.1`);
  }
}
