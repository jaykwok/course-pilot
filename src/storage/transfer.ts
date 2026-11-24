import { normalize } from "../domain/identity.ts";
import { redact } from "../log.ts";
import type { Recovery } from "../utils.ts";
import type { Repository, Task } from "./repository.ts";

export const IMPORT_INBOX = "local:imports";
export type ExportSelection = "pending" | "failed" | "all";
export interface TaskIssue {
  reason: string;
  message: string;
  recovery: Recovery;
  sections?: { section: string; message: string; recovery: Recovery }[];
}
export interface QueueBundle {
  format: "course-pilot.tasks";
  version: 1;
  exportedAt: string;
  tasks: { url: string; state: "pending" | "failed"; issue?: TaskIssue }[];
  sources: { parent: string; child: string; required: boolean }[];
}

const SENSITIVE_PARAM =
  /token|authorization|cookie|password|secret|^(?:code|ticket|bootstrap|key|api[_-]?key|sso_?ticket|auth_?code|access_?key|session_?id|sid|signature|sig)$/i;

function cleanParams(params: URLSearchParams, depth = 0) {
  for (const key of [...params.keys()]) {
    if (SENSITIVE_PARAM.test(key)) {
      params.delete(key);
      continue;
    }
    if (
      depth < 2 &&
      ["paasurl", "url", "redirecturl"].includes(key.toLowerCase())
    ) {
      const cleaned = params.getAll(key).map((value) => {
        try {
          if (/^https?:/i.test(value)) return stripUrlSecrets(value, depth + 1);
          const q = value.indexOf("?");
          if (q >= 0) {
            const inner = new URLSearchParams(value.slice(q + 1));
            cleanParams(inner, depth + 1);
            return value.slice(0, q) + (inner.size ? `?${inner}` : "");
          }
        } catch {}
        return value;
      });
      params.delete(key);
      for (const value of cleaned) params.append(key, value);
    }
  }
}

function stripUrlSecrets(raw: string, depth = 0): string {
  const url = new URL(raw);
  cleanParams(url.searchParams, depth);
  const hashQuery = url.hash.indexOf("?");
  if (hashQuery >= 0) {
    const route = url.hash.slice(0, hashQuery);
    const params = new URLSearchParams(url.hash.slice(hashQuery + 1));
    cleanParams(params, depth);
    url.hash = route + (params.size ? `?${params}` : "");
  }
  return url.href;
}

export function portableUrl(raw: string): string {
  return normalize(stripUrlSecrets(normalize(raw)));
}

function issue(value: TaskIssue): TaskIssue {
  if (!value || typeof value !== "object")
    throw new Error("任务异常记录格式无效");
  const recovery: Recovery = value.recovery === "blocked" ? "blocked" : "retry";
  const sections = Array.isArray(value.sections)
    ? value.sections
        .filter((s) => s && typeof s === "object")
        .slice(0, 500)
        .map((section) => ({
          section: section.section == null ? "" : redact(section.section),
          message: section.message == null ? "" : redact(section.message),
          recovery: (section.recovery === "blocked"
            ? "blocked"
            : "retry") as Recovery,
        }))
    : undefined;
  return {
    reason: value.reason == null ? "" : redact(value.reason),
    message: value.message == null ? "" : redact(value.message),
    recovery,
    ...(sections?.length ? { sections } : {}),
  };
}

export function taskIssue(task: Task): TaskIssue {
  return issue({
    reason: task.details.reason,
    message: task.details.message,
    recovery: task.details.recovery,
    sections: task.details.sections,
  });
}

/** Normalize links and merge duplicate tasks in the current file format. */
export function normalizeBundle(bundle: QueueBundle): QueueBundle {
  if (
    !bundle ||
    typeof bundle !== "object" ||
    Array.isArray(bundle) ||
    bundle.format !== "course-pilot.tasks" ||
    bundle.version !== 1 ||
    !Array.isArray(bundle.tasks) ||
    !Array.isArray(bundle.sources)
  )
    throw new Error("导入文件格式不受支持或结构不完整");
  if (bundle.tasks.length > 5000 || bundle.sources.length > 20000)
    throw new Error("导入文件任务或来源数量超出限制");
  const tasks = new Map<string, QueueBundle["tasks"][number]>();
  for (const task of bundle.tasks) {
    if (
      !task ||
      typeof task !== "object" ||
      typeof task.url !== "string" ||
      !["pending", "failed"].includes(task.state)
    )
      throw new Error("导入文件中的任务项格式无效");
    const url = portableUrl(task.url);
    const diagnostic = task.issue ? issue(task.issue) : undefined;
    const previous = tasks.get(url);
    tasks.set(url, {
      url,
      state: previous?.state === "pending" ? "pending" : task.state,
      ...(diagnostic || previous?.issue
        ? { issue: diagnostic || previous!.issue }
        : {}),
    });
  }
  const sources = new Map<string, QueueBundle["sources"][number]>();
  for (const source of bundle.sources) {
    if (
      !source ||
      typeof source !== "object" ||
      typeof source.parent !== "string" ||
      typeof source.child !== "string" ||
      typeof source.required !== "boolean"
    )
      throw new Error("导入文件中的来源关系格式无效");
    const normalized = {
      parent: portableUrl(source.parent),
      child: portableUrl(source.child),
      required: source.required,
    };
    const key = JSON.stringify([normalized.parent, normalized.child]);
    normalized.required ||= sources.get(key)?.required === true;
    sources.set(key, normalized);
  }
  return {
    format: "course-pilot.tasks",
    version: 1,
    exportedAt:
      typeof bundle.exportedAt === "string"
        ? bundle.exportedAt
        : new Date().toISOString(),
    tasks: [...tasks.values()],
    sources: [...sources.values()],
  };
}

function collectBundle(
  repo: Repository,
  account: string | null,
  selection: ExportSelection,
): QueueBundle {
  const selected = new Map<
    string,
    { task: Task; state: "pending" | "failed" }
  >();
  if (selection !== "failed")
    for (const queue of ["learn", "discover", "exam", "review"] as const)
      for (const task of repo.queue(account, queue))
        if (task.status !== "COMPLETED")
          selected.set(task.id, { task, state: "pending" });
  if (selection !== "pending")
    for (const task of repo.queue(account, "failure"))
      selected.set(task.id, { task, state: "failed" });
  const sources: QueueBundle["sources"] = [];
  const seen = new Set(selected.keys());
  const frontier = [...seen];
  for (let i = 0; i < frontier.length; i++) {
    for (const edge of repo.db
      .prepare("SELECT parent,required FROM edges WHERE child=?")
      .all(frontier[i])) {
      const parent = repo.task(String(edge.parent));
      sources.push({
        parent: parent.url,
        child: repo.task(frontier[i]).url,
        required: !!edge.required,
      });
      if (!seen.has(parent.id)) {
        seen.add(parent.id);
        frontier.push(parent.id);
      }
    }
  }
  return {
    format: "course-pilot.tasks",
    version: 1,
    exportedAt: new Date().toISOString(),
    tasks: [...selected.values()].map(({ task, state }) => ({
      url: task.url,
      state,
      ...(state === "failed"
        ? { issue: taskIssue(task) }
        : task.details.importedIssue
          ? { issue: task.details.importedIssue }
          : {}),
    })),
    sources,
  };
}

export function exportBundle(
  repo: Repository,
  account: string | null,
  selection: ExportSelection,
): QueueBundle {
  return normalizeBundle(collectBundle(repo, account, selection));
}

function applyBundle(repo: Repository, bundle: QueueBundle, account: string) {
  let added = 0,
    retained = 0;
  for (const item of bundle.tasks) {
    const task = repo.upsert(item.url, account);
    // Local completion, failures and uncertain submissions take precedence over
    // another person's exported state. A fresh recipient gets runnable tasks.
    if (task.status === "COMPLETED" || repo.hasFailure(task.id)) {
      retained++;
      continue;
    }
    if (item.issue)
      repo.outcome(task.id, task.status, { importedIssue: item.issue });
    const queued = repo.db
      .prepare("SELECT 1 FROM queues WHERE task_id=?")
      .get(task.id);
    if (queued) {
      retained++;
      continue;
    }
    repo.enqueue(
      task,
      task.kind === "course"
        ? "learn"
        : task.kind === "exam"
          ? task.manualSubmit
            ? "review"
            : "exam"
          : "discover",
    );
    added++;
  }
  for (const source of bundle.sources) {
    const parent = repo.upsert(source.parent, account),
      child = repo.upsert(source.child, account);
    // Merged provenance can contain back edges. As in discovery, keep all
    // tasks while adding only acyclic execution dependencies.
    repo.link(parent, child, source.required);
  }
  return { added, retained };
}

export function importBundle(
  repo: Repository,
  input: QueueBundle,
  account: string,
) {
  const bundle = normalizeBundle(input);
  return repo.transaction(() => applyBundle(repo, bundle, account));
}

export function adoptImports(repo: Repository, account: string) {
  const bundle = collectBundle(repo, IMPORT_INBOX, "all");
  if (!bundle.tasks.length) return 0;
  return repo.transaction(() => {
    const result = applyBundle(repo, bundle, account);
    repo.db
      .prepare(
        "DELETE FROM queues WHERE task_id IN (SELECT id FROM tasks WHERE account=?)",
      )
      .run(IMPORT_INBOX);
    return result.added;
  });
}
