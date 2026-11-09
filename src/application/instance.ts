import { mkdir, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { atomicJson } from "../storage/files.ts";
import { token } from "../utils.ts";
export interface Instance {
  pid: number;
  id: string;
  origin?: string;
  key?: string;
}
export async function acquireInstance(directory: string): Promise<
  | {
      owned: true;
      publish: (origin: string, key: string) => Promise<void>;
      close: () => Promise<void>;
    }
  | { owned: false; instance: Instance }
> {
  await mkdir(directory, { recursive: true });
  // SQLite's exclusive file lock is released by the OS even after a hard exit.
  // Metadata only reopens the winning instance; it is never the lock itself.
  const path = join(directory, "instance.json"),
    id = token();
  const guard = new DatabaseSync(join(directory, "instance-lock.sqlite"));
  try {
    guard.exec("BEGIN EXCLUSIVE");
  } catch (e) {
    guard.close();
    if ((e as { errcode?: number }).errcode !== 5) throw e; // SQLITE_BUSY
    let instance: Instance;
    try {
      instance = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error("工作台正在启动，请稍后重试");
    }
    return { owned: false, instance };
  }
  try {
    await atomicJson(path, { pid: process.pid, id });
  } catch (e) {
    guard.close();
    throw e;
  }
  return {
    owned: true,
    publish: async (origin, key) => {
      await atomicJson(path, { pid: process.pid, id, origin, key });
    },
    close: async () => {
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (value.id === id) await rm(path);
      } finally {
        guard.close();
      }
    },
  };
}
export async function reopenInstance(instance: Instance) {
  if (!instance.origin || !instance.key)
    throw new Error("工作台正在启动，请稍后重试");
  const url = new URL(instance.origin);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password
  )
    throw new Error("工作台地址无效");
  const r = await fetch(`${url.origin}/api/reopen`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: instance.key }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error("无法重开已有工作台");
}
