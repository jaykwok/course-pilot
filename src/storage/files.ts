import { mkdir, open, rename, rm, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sleep, token } from "../utils.ts";

const TRANSIENT_FS = new Set(["EPERM", "EBUSY", "EACCES"]);

export async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || "";
      if (!TRANSIENT_FS.has(code) || attempt >= 5) throw error;
      await sleep(Math.min(20 * 2 ** attempt, 200));
    }
  }
}

export async function atomicJson(path: string, data: unknown) {
  await atomicText(path, JSON.stringify(data, null, 2));
}
export async function atomicText(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${token().slice(0, 12)}.tmp`;
  try {
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(data, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await renameWithRetry(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("数据文件损坏，请保留文件后重新配置");
  }
}
