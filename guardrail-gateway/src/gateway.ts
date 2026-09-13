// gateway.ts — OpenAI 兼容护栏网关
// Fabric / 任意 OpenAI 客户端 把 base_url 指向 http://localhost:8787/v1 即可，
// 全部请求经过：供应商排序 → 熔断检查 → 成本/超时护栏 → 执行 → 遥测 → （5%）影子测试
// 零依赖，Node 18+：node dist/gateway.js
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { optimizeAndRoute, RouteResult } from "./router";
import { todaySpend } from "./telemetry";
import { shadowTest } from "./shadow";

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config", "providers.json"), "utf-8")
);
const PORT = Number(process.env.GATEWAY_PORT ?? 8787);
const GATEWAY_KEY = process.env.GATEWAY_KEY; // 可选：客户端鉴权

function openAiError(status: number, message: string) {
  return JSON.stringify({ error: { message, type: "guardrail_error", code: status } });
}

function requireAuth(req: http.IncomingMessage): boolean {
  if (!GATEWAY_KEY) return true;
  return (req.headers.authorization ?? "") === `Bearer ${GATEWAY_KEY}`;
}

function handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!requireAuth(req)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(openAiError(401, "网关鉴权失败：请设置正确的 GATEWAY_KEY"));
    return;
  }
  let body = "";
  req.on("data", (c: Buffer) => { body += c; if (body.length > 2_000_000) req.destroy(); });
  req.on("end", () => {
    let parsed: any;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(openAiError(400, "请求体不是合法 JSON"));
      return;
    }
    const messages: { role: string; content: string }[] = parsed.messages ?? [];
    const prompt = messages.map(m => `[${m.role}]\n${m.content}`).join("\n\n");
    const task = parsed.user ?? "chat"; // 客户端可用 user 字段标记任务类型

    optimizeAndRoute(task, prompt)
      .then((r: RouteResult) => {
        // 影子测试（异步、5% 采样、绝不阻塞本响应）
        try {
          shadowTest({
            task, prompt,
            baselineCostUsd: r.costUsd,
            baselineScore: 18, // 基线满分 20 的默认预期；精确基线分由 Judge 流水线回填
            shadowModelId: "lastline-fast",
            sourceMaterial: prompt,
            baselineOutput: r.text,
          });
        } catch { /* 影子测试永不影响生产 */ }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: `gw-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: r.model,
          choices: [{ index: 0, message: { role: "assistant", content: r.text }, finish_reason: "stop" }],
          usage: { prompt_tokens: Math.ceil(prompt.length / 3.5), completion_tokens: Math.ceil(r.text.length / 3.5) },
          gateway: { provider: r.providerId, cost_usd: Number(r.costUsd.toFixed(6)), latency_ms: r.latencyMs },
        }));
      })
      .catch((err: Error) => {
        // 全部熔断/超限/攻击嫌疑 → OpenAI 错误格式，绝不静默重试
        res.writeHead(503, { "content-type": "application/json" });
        res.end(openAiError(503, err.message));
      });
  });
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
    return handleChatCompletions(req, res);
  }
  if (req.method === "GET" && url === "/health") {
    const spend = todaySpend(config.guardrails.dailyBudget);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      status: "ok",
      daily_spend_usd: Number(spend.spent.toFixed(4)),
      daily_budget_usd: config.guardrails.dailyBudget,
      budget_tripped: spend.tripped,
    }));
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(openAiError(404, `未知路径 ${url}。可用：POST /v1/chat/completions, GET /health`));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[GUARDRAIL_GATEWAY] 监听 http://127.0.0.1:${PORT}/v1 — 双护栏生效：` +
    `单次 $${config.guardrails.maxCostPerRun} / 日预算 $${config.guardrails.dailyBudget}`);
});
