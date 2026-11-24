import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { acquireInstance } from "../src/application/instance.ts";
import { redact } from "../src/log.ts";
import { atomicJson } from "../src/storage/files.ts";
import { portableUrl } from "../src/storage/transfer.ts";

function projectRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("无法定位项目根目录");
    dir = parent;
  }
  return dir;
}

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "include-sensitive": { type: "boolean", default: false },
  },
  strict: true,
});

const root = projectRoot();
const dataDir = join(root, "data");
const lock = await acquireInstance(dataDir);
if (!lock.owned) throw new Error("请先关闭工作台，再使用数据工具");

let db: DatabaseSync | undefined;
try {
  const dbPath = join(dataDir, "workbench.sqlite");
  const tables = [
    "tasks",
    "queues",
    "edges",
    "runs",
    ...(values["include-sensitive"] ? ["intents", "exam_history"] : []),
  ];
  const data: Record<string, Record<string, unknown>[]> = Object.fromEntries(
    tables.map((name) => [name, []]),
  );
  if (existsSync(dbPath)) {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const existing = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    for (const table of tables) {
      if (!existing.has(table)) continue;
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<
        string,
        unknown
      >[];
      data[table] = rows.map((row) => {
        const copy = { ...row };
        if (table === "tasks") {
          if (typeof copy.url === "string") {
            try {
              copy.url = portableUrl(copy.url);
            } catch {
              copy.url = redact(copy.url);
            }
          }
          if (typeof copy.details === "string")
            copy.details = redact(copy.details);
        } else if (table === "runs" && typeof copy.outcome === "string") {
          copy.outcome = redact(copy.outcome);
        }
        return copy;
      });
    }
  }
  if (values.output !== undefined) {
    if (!values.output.trim()) throw new Error("--output 缺少路径");
    await atomicJson(resolve(values.output), data);
    console.log("已导出工作台数据");
  } else {
    console.log(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(data).map(([key, rows]) => [key, rows.length]),
        ),
        null,
        2,
      ),
    );
  }
} finally {
  try {
    db?.close();
  } catch {}
  await lock.close();
}
