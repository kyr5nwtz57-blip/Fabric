// telemetry.ts — 成本/延迟/失败遥测（JSONL 追加写，零依赖）
// 每条记录：provider / latencyMs / tokens / costUsd / outcome / ts
import * as fs from "fs";
import * as path from "path";

export interface TelemetryRecord {
  ts: string;
  kind: "production" | "shadow" | "judge";
  providerId: string;
  model: string;
  task: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  outcome: "success" | "timeout" | "http_error" | "cost_exceeded" | "parse_error";
  httpStatus?: number;
}

const LOG_FILE = process.env.TELEMETRY_FILE
  ?? path.join(__dirname, "..", "telemetry.jsonl");

export function logTelemetry(rec: TelemetryRecord): void {
  fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + "\n");
}

// 每日预算熔断检查：读当日记录累计 costUsd
export function todaySpend(dailyBudget: number): { spent: number; tripped: boolean } {
  if (!fs.existsSync(LOG_FILE)) return { spent: 0, tripped: false };
  const today = new Date().toISOString().slice(0, 10);
  let spent = 0;
  for (const line of fs.readFileSync(LOG_FILE, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as TelemetryRecord;
      if (rec.ts.startsWith(today) && rec.kind === "production") spent += rec.costUsd;
    } catch { /* 容忍损坏行 */ }
  }
  return { spent, tripped: spent >= dailyBudget };
}

// 异常流量检测：5 分钟窗口请求数 vs 上一窗口，环比超 trafficSpikeRatio → 疑似攻击
export function detectTrafficSpike(recent: TelemetryRecord[], spikeRatio: number): boolean {
  const now = Date.now();
  const win = 5 * 60 * 1000;
  const cur = recent.filter(r => now - Date.parse(r.ts) < win).length;
  const prev = recent.filter(
    r => now - Date.parse(r.ts) >= win && now - Date.parse(r.ts) < 2 * win
  ).length;
  if (prev < 10) return false; // 样本太少不判定，防误杀
  return cur > prev * spikeRatio;
}
