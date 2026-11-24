import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { publicSettings } from "../config.ts";
import { redact } from "../log.ts";
import type { Repository, Queue } from "./repository.ts";
import { portableUrl, taskIssue } from "./transfer.ts";

export interface DiagnosticSnapshot {
  account: string;
  operationId: string | null;
  kind: string | null;
  view: {
    title?: string;
    status?: string;
    summary?: {
      title?: string;
      tone?: string;
      rows?: [string, unknown][];
    } | null;
    notification?: {
      tone?: string;
      message?: string;
    } | null;
    progress?: unknown;
  };
  dashboard: Record<string, any>;
  logs: { seq: number; message: string; level: string }[];
  droppedLogs: number;
}

export interface DiagnosticOptions {
  repo: Repository;
  logsDir: string;
  settingsPath: string;
  root: string;
  snapshot: DiagnosticSnapshot;
  accountLabel: (account: string) => string;
}

function readPackageVersion(path: string): string {
  try {
    return String(JSON.parse(readFileSync(path, "utf8")).version || "unknown");
  } catch {
    return "unknown";
  }
}

function safeUrl(raw: string): string {
  try {
    return portableUrl(raw);
  } catch {
    return redact(raw);
  }
}

function sanitizeOutcome(raw: unknown): string {
  if (raw == null) return "";
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const copy: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (/answer|cookie|token|secret|key|password/i.test(key)) continue;
        copy[key] = value;
      }
      return redact(JSON.stringify(copy));
    }
  } catch {}
  return redact(raw);
}

function readRecentDiskLogs(
  logsDir: string,
  level: "error" | "warn" | "info",
  maxBytes: number,
  maxLines: number,
): string[] {
  if (!existsSync(logsDir)) return [];
  const prefix = `app-${level}`;
  const files = readdirSync(logsDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".log"))
    .map((name) => {
      const full = join(logsDir, name);
      try {
        return { name, full, mtime: statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3);
  const collected: string[] = [];
  let budget = maxBytes;
  for (const file of files) {
    if (budget <= 0 || collected.length >= maxLines) break;
    try {
      const raw = readFileSync(file.full, "utf8");
      const slice = raw.length > budget ? raw.slice(-budget) : raw;
      const lines = slice
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => redact(line));
      if (!lines.length) continue;
      collected.push(`--- ${file.name} ---`);
      const remaining = maxLines - collected.length;
      const chosen = lines.length > remaining ? lines.slice(-remaining) : lines;
      collected.push(...chosen);
      budget -= slice.length;
    } catch {}
  }
  return collected;
}

function timestampSlug(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function buildDiagnosticLog(options: DiagnosticOptions): {
  filename: string;
  content: string;
} {
  const now = new Date();
  const { repo, logsDir, settingsPath, root, snapshot, accountLabel } = options;
  const appVersion = readPackageVersion(join(root, "package.json"));
  const nodriverVersion = readPackageVersion(
    join(root, "node_modules", "nodriver-ts", "package.json"),
  );
  const settings = publicSettings(settingsPath);
  const lines: string[] = [];

  lines.push("========================================");
  lines.push("Course Pilot 诊断与错误日志（已自动脱敏）");
  lines.push("========================================");
  lines.push(`导出时间: ${now.toISOString()}`);
  lines.push(`应用版本: ${appVersion}`);
  lines.push(`nodriver-ts: ${nodriverVersion}`);
  lines.push(`Node.js: ${process.version}`);
  lines.push(`系统环境: ${process.platform} ${process.arch} (${release()})`);
  lines.push(
    `当前账号: ${redact(snapshot.dashboard.account || "未登录")} (凭证状态: ${snapshot.dashboard.credential?.status || "unknown"})`,
  );
  lines.push(
    `运行状态: operation=${snapshot.kind || "idle"}, title=${redact(snapshot.view.title || "")}, status=${redact(snapshot.view.status || "")}`,
  );
  if (snapshot.view.notification)
    lines.push(
      `最近提示: [${snapshot.view.notification.tone || "info"}] ${redact(snapshot.view.notification.message || "")}`,
    );
  if (snapshot.view.summary) {
    lines.push(
      `最近摘要: [${snapshot.view.summary.tone || "info"}] ${redact(snapshot.view.summary.title || "")}`,
    );
    for (const [k, v] of snapshot.view.summary.rows || [])
      lines.push(`  - ${redact(k)}: ${redact(v)}`);
  }
  lines.push(
    `脱敏配置: ${redact(JSON.stringify({ learning: settings.learning, openai: { baseURL: settings.openai.baseURL, model: settings.openai.model, protocol: settings.openai.protocol, output: settings.openai.output, retries: settings.openai.retries, timeout: settings.openai.timeout, totalTimeout: settings.openai.totalTimeout, keyConfigured: settings.openai.keyConfigured }, browser: settings.browser }))}`,
  );

  lines.push("");
  lines.push("=== 异常任务与失败详情 ===");
  const accounts = repo.queueAccounts();
  let issueCount = 0;
  for (const account of accounts) {
    const label = redact(accountLabel(account));
    const counts = Object.fromEntries(
      (["learn", "discover", "failure", "exam", "review"] as Queue[]).map(
        (queue) => [queue, repo.queue(account, queue).length],
      ),
    );
    lines.push(
      `账号 ${label}: 待学=${counts.learn}, 待解析=${counts.discover}, 异常=${counts.failure}, 待考=${counts.exam}, 复查=${counts.review}`,
    );
    for (const task of repo.queue(account, "failure")) {
      issueCount++;
      const detail = taskIssue(task);
      lines.push(
        `[异常任务 #${issueCount}] (${detail.recovery === "retry" ? "可重试" : "需外部处理"} / ${detail.reason}) ${safeUrl(task.url)}`,
      );
      lines.push(`  原因: ${detail.message}`);
      for (const section of detail.sections || [])
        lines.push(
          `  - 章节 ${section.section} [${section.recovery === "retry" ? "可重试" : "需外部处理"}]: ${section.message}`,
        );
    }
    for (const task of repo.queue(account, "review")) {
      issueCount++;
      const detail = taskIssue(task);
      lines.push(
        `[考试复查 #${issueCount}] (${detail.reason || task.status}) ${safeUrl(task.url)}`,
      );
      if (detail.message) lines.push(`  说明: ${detail.message}`);
    }
  }
  if (!issueCount) lines.push("（当前无异常任务或待复查考试）");

  lines.push("");
  lines.push("=== 最近异常执行记录 (SQLite runs) ===");
  const runs = repo.db
    .prepare(
      "SELECT r.created_at, r.kind, r.status, r.outcome, t.url FROM runs r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.status != 'COMPLETED' ORDER BY r.created_at DESC LIMIT 50",
    )
    .all();
  if (!runs.length) lines.push("（无非完成执行记录）");
  for (const row of runs) {
    lines.push(
      `${row.created_at} [${row.kind}/${row.status}] ${safeUrl(String(row.url || ""))}`,
    );
    const outcome = sanitizeOutcome(row.outcome);
    if (outcome) lines.push(`  outcome: ${outcome.slice(0, 1500)}`);
  }

  const intents = repo.db
    .prepare(
      "SELECT i.created_at, i.operation, i.state, t.url FROM intents i LEFT JOIN tasks t ON t.id = i.task_id WHERE i.state = 'PENDING' ORDER BY i.created_at DESC LIMIT 20",
    )
    .all();
  if (intents.length) {
    lines.push("");
    lines.push("=== 未确认操作意图 (PENDING intents) ===");
    for (const row of intents)
      lines.push(
        `${row.created_at} [${row.operation}/${row.state}] ${safeUrl(String(row.url || ""))}`,
      );
  }

  for (const [title, level, maxBytes, maxLines] of [
    ["错误日志 (app-error.log)", "error", 160 * 1024, 1500],
    ["警告日志 (app-warn.log)", "warn", 100 * 1024, 1000],
    ["最近运行日志 (app-info.log)", "info", 100 * 1024, 1000],
  ] as const) {
    lines.push("");
    lines.push(`=== ${title} ===`);
    const disk = readRecentDiskLogs(logsDir, level, maxBytes, maxLines);
    if (disk.length) lines.push(...disk);
    else lines.push("（暂无记录）");
  }

  lines.push("");
  lines.push(
    `=== 内存实时日志（共 ${snapshot.logs.length} 条${snapshot.droppedLogs ? `，已滚动省略更早 ${snapshot.droppedLogs} 条` : ""}） ===`,
  );
  if (snapshot.logs.length) {
    for (const entry of snapshot.logs)
      lines.push(`#${entry.seq} [${entry.level}] ${redact(entry.message)}`);
  } else {
    lines.push("（暂无内存日志）");
  }

  return {
    filename: `course-pilot-error-log-${timestampSlug(now)}.txt`,
    content: lines.join("\n") + "\n",
  };
}
