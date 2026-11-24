import {
  appendFileSync,
  mkdirSync,
  existsSync,
  statSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
const MAX_LOG_BYTES = 10 * 1024 * 1024;
export function redact(input: unknown): string {
  if (input == null) return "";
  return String(input instanceof Error ? input.message : input)
    .replace(/(https?:\/\/)([^/\s@]+)@/gi, "$1[已隐藏]@")
    .replace(
      /([?&#](?:token|code|ticket|authorization|bootstrap|key|api[_-]?key|access[_-]?token|secret|password|sig|signature)=)[^&#\s]*/gi,
      "$1[已隐藏]",
    )
    .replace(
      /((?:"|')?(?:authorization|cookie|course_web|x-token|x-control-client|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|token|ticket|bootstrap|password|secret)(?:"|')?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|\[已隐藏\]|[^\r\n,;}\]&]+)/gi,
      (_, prefix: string) =>
        prefix.trimEnd().endsWith(":") &&
        (prefix.startsWith('"') || prefix.startsWith("'"))
          ? `${prefix}"[已隐藏]"`
          : `${prefix}[已隐藏]`,
    )
    .replace(
      /\b(?:Bearer(?:__|\s+|%5F%5F|%20)|Basic(?:\s+|%20))[^\s"'&,;]+/gi,
      (match) => (/^basic/i.test(match) ? "Basic [已隐藏]" : "Bearer [已隐藏]"),
    )
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
    const line = `${new Date().toISOString()} [${level}] ${diskText}\n`;
    try {
      if (existsSync(path)) {
        try {
          const stats = statSync(path);
          const day = stats.mtime.toISOString().slice(0, 10);
          if (day !== today || stats.size >= MAX_LOG_BYTES)
            renameSync(
              path,
              join(this.directory, `app-${level}-${day}-${Date.now()}.log`),
            );
        } catch {}
      }
      try {
        appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          mkdirSync(this.directory, { recursive: true });
          appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
        } else throw error;
      }
    } catch (error) {
      if (process.env.COURSE_AFK_QUIET !== "1")
        console.error("写入日志文件失败:", redact(error));
    }
    this.listener?.(text, level);
    if (process.env.COURSE_AFK_QUIET !== "1") console.log(text);
  }
}
