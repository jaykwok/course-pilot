import { writeFileSync } from "node:fs";
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
function openLockDb(lockPath: string): DatabaseSync {
  const openAndLock = () => {
    const db = new DatabaseSync(lockPath);
    try {
      db.exec("BEGIN EXCLUSIVE");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  try {
    return openAndLock();
  } catch (error) {
    const errcode = (error as { errcode?: number }).errcode;
    // Recreate lock-only DB if it was corrupted on a previous hard crash.
    if (errcode === 11 || errcode === 26) {
      return ((): never => {
        throw error;
      })();
    }
    throw error;
  }
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
    lockPath = join(directory, "instance-lock.sqlite"),
    id = token();
  let guard: DatabaseSync;
  try {
    guard = openLockDb(lockPath);
  } catch (e) {
    const errcode = (e as { errcode?: number }).errcode;
    if (errcode === 11 || errcode === 26) {
      await rm(lockPath, { force: true }).catch(() => {});
      guard = openLockDb(lockPath);
    } else if (errcode === 5) {
      // SQLITE_BUSY
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new Error("工作台正在启动，请稍后重试");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("工作台正在启动，请稍后重试");
      return { owned: false, instance: parsed as Instance };
    } else throw e;
  }
  try {
    // Synchronously clear any stale origin/key before yielding to the event loop.
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, id }, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      await atomicJson(path, { pid: process.pid, id });
    }
  } catch (e) {
    guard.close();
    throw e;
  }
  let closed = false;
  return {
    owned: true,
    publish: async (origin, key) => {
      await atomicJson(path, { pid: process.pid, id, origin, key });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (value?.id === id) await rm(path, { force: true });
      } catch {
      } finally {
        try {
          guard.close();
        } catch {}
      }
    },
  };
}
export async function reopenInstance(instance: Instance) {
  if (
    !instance ||
    typeof instance.origin !== "string" ||
    !instance.origin ||
    typeof instance.key !== "string" ||
    !instance.key
  )
    throw new Error("工作台正在启动，请稍后重试");
  let url: URL;
  try {
    url = new URL(instance.origin);
  } catch {
    throw new Error("工作台地址无效");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password
  )
    throw new Error("工作台地址无效");
  let r: Response;
  try {
    r = await fetch(`${url.origin}/api/reopen`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: instance.key }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error("已有工作台正在启动或关闭，请稍后重试");
  }
  try {
    if (!r.ok) throw new Error("无法重开已有工作台");
  } finally {
    await r.body?.cancel().catch(() => {});
  }
}
