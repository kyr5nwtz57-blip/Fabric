// router.ts — 智能护栏路由器（硬边界：超时/重试上限/成本熔断/降级链）
// 零依赖（Node 18+ 原生 fetch）
import * as fs from "fs";
import * as path from "path";
import { logTelemetry, todaySpend, detectTrafficSpike, TelemetryRecord } from "./telemetry";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  costPerMInput: number;
  costPerMOutput: number;
  tier: "P0" | "P1" | "P2";
  maxOutputTokens: number;
  apiKeyEnv: string;
}

export interface Guardrails {
  maxCostPerRun: number;
  dailyBudget: number;
  maxRetriesPerProvider: number;
  timeoutMs: number;
}

export interface RouteResult {
  text: string;
  providerId: string;
  model: string;
  costUsd: number;
  latencyMs: number;
}

type ProviderState = { failures: number; trippedUntil: number };
const providerState = new Map<string, ProviderState>();
const recentRecords: TelemetryRecord[] = [];

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config", "providers.json"), "utf-8")
);
const GUARD: Guardrails = config.guardrails;
const PROVIDERS: Provider[] = config.providers.map((p: Provider) => ({
  ...p,
  apiKeyEnv: p.apiKeyEnv ?? `${p.id.toUpperCase()}_API_KEY`,
}));

// 历史优化分排序（成本升序为兜底序；生产可扩展为 加权(速度+成本+准确率)）
function rankProviders(allowExpensive: boolean): Provider[] {
  const spend = todaySpend(GUARD.dailyBudget);
  if (spend.tripped) {
    console.warn(`[GUARDRAIL] 日预算已用 $${spend.spent.toFixed(2)}，全量降级至 P2`);
    return PROVIDERS.filter(p => p.tier === "P2");
  }
  const pool = allowExpensive ? PROVIDERS : PROVIDERS.filter(p => p.tier !== "P0");
  return [...pool].sort((a, b) =>
    (a.costPerMInput + a.costPerMOutput) - (b.costPerMInput + b.costPerMOutput)
  );
}

function tripCircuitBreaker(p: Provider): void {
  providerState.set(p.id, { failures: 0, trippedUntil: Date.now() + GUARD.maxRetriesPerProvider * 0 + 60_000 });
  console.error(`[CIRCUIT_BREAKER] ${p.id} 连续失败熔断 60s，自动切换下一供应商`);
}

function estimateCost(p: Provider, inTok: number, outTok: number): number {
  return (inTok / 1e6) * p.costPerMInput + (outTok / 1e6) * p.costPerMOutput;
}

async function executeWithTimeout(p: Provider, prompt: string): Promise<{ text: string; inTok: number; outTok: number }> {
  const key = process.env[p.apiKeyEnv] ?? process.env.LLM_API_KEY;
  if (!key) throw new Error(`missing_api_key:${p.apiKeyEnv}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GUARD.timeoutMs);
  try {
    const res = await fetch(p.baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: p.maxOutputTokens,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content
      ?? data.content?.[0]?.text
      ?? data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") throw new Error("unexpected_response_shape");
    return {
      text,
      inTok: data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0,
      outTok: data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function optimizeAndRoute(task: string, prompt: string): Promise<RouteResult> {
  // 异常流量哨兵：疑似 token 抽取攻击 → 直接拒绝，防止烧穿预算
  if (detectTrafficSpike(recentRecords.slice(-500), config.guardrails.trafficSpikeRatio)) {
    throw new Error("[GUARDRAIL] 检测到异常流量峰值（疑似攻击），已拒绝执行。管理员需人工确认。");
  }

  const ranked = rankProviders(true);
  const inTokEst = Math.ceil(prompt.length / 3.5); // 粗估，正式以 usage 为准

  for (const p of ranked) {
    const st = providerState.get(p.id);
    if (st && st.trippedUntil > Date.now()) continue;

    // 单次成本护栏：预估超限 → 该供应商出局
    if ((inTokEst / 1e6) * p.costPerMInput + (p.maxOutputTokens / 1e6) * p.costPerMOutput
        > GUARD.maxCostPerRun) {
      console.warn(`[GUARDRAIL] ${p.id} 预估成本超单次上限 $${GUARD.maxCostPerRun}，跳过`);
      continue;
    }

    for (let attempt = 0; attempt < GUARD.maxRetriesPerProvider; attempt++) {
      const t0 = Date.now();
      try {
        const r = await executeWithTimeout(p, prompt);
        const cost = estimateCost(p, r.inTok, r.outTok);
        const rec: TelemetryRecord = {
          ts: new Date().toISOString(), kind: "production", providerId: p.id,
          model: p.model, task, latencyMs: Date.now() - t0,
          inputTokens: r.inTok, outputTokens: r.outTok, costUsd: cost, outcome: "success",
        };
        logTelemetry(rec); recentRecords.push(rec);
        return { text: r.text, providerId: p.id, model: p.model, costUsd: cost, latencyMs: Date.now() - t0 };
      } catch (err: any) {
        const outcome: TelemetryRecord["outcome"] =
          err.name === "AbortError" ? "timeout"
          : String(err.message).startsWith("http_") ? "http_error"
          : "http_error";
        const rec: TelemetryRecord = {
          ts: new Date().toISOString(), kind: "production", providerId: p.id,
          model: p.model, task, latencyMs: Date.now() - t0,
          inputTokens: inTokEst, outputTokens: 0, costUsd: 0, outcome, httpStatus: undefined,
        };
        logTelemetry(rec); recentRecords.push(rec);
        const failures = (providerState.get(p.id)?.failures ?? 0) + 1;
        if (failures >= GUARD.maxRetriesPerProvider) { tripCircuitBreaker(p); break; }
        providerState.set(p.id, { failures, trippedUntil: 0 });
      }
    }
  }
  // 全部失败 → 中止而非无限重试（防止失控烧钱）
  throw new Error("[GUARDRAIL] 所有供应商已熔断或超限。任务中止以防止成本失控，请人工介入。");
}
