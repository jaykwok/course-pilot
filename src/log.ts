import {
  appendFileSync,
  mkdirSync,
  existsSync,
  statSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
export function redact(input: unknown): string {
  return String(input instanceof Error ? input.message : input)
    .replace(
      /([?&#](?:token|code|ticket|authorization|bootstrap|key|access_token)=)[^&#\s]*/gi,
      "$1[已隐藏]",
    )
    .replace(
      /((?:authorization|cookie|x-token|api[_-]?key|access[_-]?token|token|ticket|bootstrap|password)\s*[:=]\s*)[^\r\n,;]+/gi,
      "$1[已隐藏]",
    )
    .replace(/\bBearer(?:__|\s+)[\w.\-]+/gi, "Bearer [已隐藏]")
    .replace(/\bsk-[\w-]+/g, "[已隐藏]")
    .slice(0, 12000);
}
export function formatLogDetail(input: unknown): string {
  if (!(input instanceof Error)) return redact(input);
  const parts: string[] = [redact(`${input.name}: ${input.message}`)];
  const report = (input as { report?: Record<string, unknown> }).report;
  if (report && typeof report === "object") {
    const summary: Record<string, unknown> = {
      action: report.action,
      status: report.status,
      events: report.events,
      dispatched: report.dispatched,
      sent: report.sent,
      actualMs:
        typeof report.actualMs === "number"
          ? Math.round(report.actualMs)
          : undefined,
      plannedMs:
        typeof report.plannedMs === "number"
          ? Math.round(report.plannedMs)
          : undefined,
      skippedMoves: report.skippedMoves,
      lateReplies: report.lateReplies,
      presentationRecoveries: report.presentationRecoveries,
      cleanup: report.cleanup,
    };
    parts.push(`report=${redact(JSON.stringify(summary))}`);
  }
  if (input.cause !== undefined) {
    const cause =
      input.cause instanceof Error
        ? `${input.cause.name}: ${input.cause.message}`
        : String(input.cause);
    parts.push(`cause=${redact(cause)}`);
  }
  if (input.stack) {
    const frames = input.stack
      .split(/\r?\n/)
      .slice(1, 7)
      .map((line) => line.trim())
      .filter(Boolean);
    if (frames.length) parts.push(`stack=${redact(frames.join(" <- "))}`);
  }
  return parts.join(" | ").slice(0, 12000);
}
export class Logger {
  readonly directory: string;
  listener?: (message: string, level: string) => void;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
  }
  log(
    message: unknown,
    level: "info" | "warn" | "error" = "info",
    context?: string,
  ) {
    const prefix = context ? `${redact(context)}：` : "",
      text = `${prefix}${redact(message)}`,
      diskText = `${prefix}${
        level !== "info" && message instanceof Error
          ? formatLogDetail(message)
          : redact(message)
      }`,
      path = join(this.directory, `app-${level}.log`);
    const today = new Date().toISOString().slice(0, 10);
    if (existsSync(path)) {
      const day = statSync(path).mtime.toISOString().slice(0, 10);
      if (day !== today)
        renameSync(
          path,
          join(this.directory, `app-${level}-${day}-${Date.now()}.log`),
        );
    }
    appendFileSync(
      path,
      `${new Date().toISOString()} [${level}] ${diskText}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    this.listener?.(text, level);
    if (process.env.COURSE_AFK_QUIET !== "1") console.log(text);
  }
}
