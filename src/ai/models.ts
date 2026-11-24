import OpenAI from "openai";
import type { Settings } from "../config.ts";

export async function listModels(
  settings: Pick<Settings["openai"], "baseURL" | "apiKey" | "timeout">,
  signal?: AbortSignal,
): Promise<string[]> {
  const client = new OpenAI({
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    timeout: settings.timeout * 1000,
    maxRetries: 0,
  });
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("获取模型超时，请稍后重试。"));
  }, settings.timeout * 1000);
  timer.unref?.();
  try {
    const { data: page, response } = await client.models
      .list({ signal: controller.signal })
      .withResponse();
    const contentType = response.headers.get("content-type") || "";
    const rawBody = (page as unknown as { body?: { data?: unknown } }).body;
    if (
      !/\bjson\b/i.test(contentType) ||
      (rawBody !== undefined && !Array.isArray(rawBody?.data)) ||
      !Array.isArray(page.data)
    )
      throw new Error("接口未返回有效的 JSON 模型列表，请检查接口地址。");
    return [
      ...new Set(
        page.data
          .map((model) =>
            typeof model?.id === "string" ? model.id.trim() : "",
          )
          .filter(Boolean),
      ),
    ].sort();
  } catch (error) {
    if (timedOut || error instanceof OpenAI.APIConnectionTimeoutError)
      throw new Error("获取模型超时，请稍后重试。");
    if (signal?.aborted || error instanceof OpenAI.APIUserAbortError)
      throw new Error("获取模型已取消。");
    if (error instanceof OpenAI.APIConnectionError)
      throw new Error("无法连接 AI 接口，请检查接口地址和网络。");
    if (error instanceof OpenAI.APIError) {
      const hint =
        error.status === 401 || error.status === 403
          ? "请检查 API Key 和访问权限。"
          : error.status === 404
            ? "该地址未提供模型列表，请检查接口地址，或手动填写模型名称。"
            : error.status === 429
              ? "请求过于频繁，请稍后重试。"
              : "请稍后重试，或手动填写模型名称。";
      throw new Error(
        `获取模型失败（HTTP ${error.status ?? "未知"}）。${hint}`,
      );
    }
    if (error instanceof Error && /JSON 模型列表/.test(error.message))
      throw error;
    throw new Error("无法读取接口返回的模型列表，可手动填写模型名称。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
