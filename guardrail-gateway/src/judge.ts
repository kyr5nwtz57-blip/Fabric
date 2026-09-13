// judge.ts — LLM-as-a-Judge 数学评分（先定标准，后打分；禁止主观判断）
// 评分体系：格式+5 / 忠实度±10 / 字段召回0-3 / 延迟0-2；满分 20（格式失败直接 0）
import * as fs from "fs";
import * as path from "path";
import { TelemetryRecord } from "./telemetry";

export interface JudgeInput {
  task: string;
  sourceMaterial: string;   // 原始输入材料（用于忠实度判定）
  baselineOutput: string;   // 生产模型输出（召回比对基准）
  candidateOutput: string;  // 影子模型输出
  candidateLatencyMs: number;
}

export interface JudgeScore {
  total: number;
  breakdown: { format: number; faithfulness: number; recall: number; latency: number };
  fatal: boolean;
  reason: string;
}

const JUDGE_PROMPT = `你是严格的输出审计员。对照【源材料】判定【候选输出】，只输出 JSON：
{"format_ok": true|false, "hallucinated_entities": ["..."], "missing_key_fields": ["..."]}
判定规则：
- format_ok：候选输出可被解析为目标结构（JSON/约定格式）
- hallucinated_entities：候选输出中出现但源材料不存在的实体、数字、结论（幻觉=重罪）
- missing_key_fields：baseline 有关键字段而候选输出缺失的字段
禁止评价文风。禁止输出 JSON 以外的任何内容。`;

// 规则部分本地计算（确定性），幻觉判定交给裁判模型（此处给出接口，接入时填 provider）
export function computeScore(input: JudgeInput, judgeModelFindings: {
  format_ok: boolean;
  hallucinated_entities: string[];
  missing_key_fields: string[];
}): JudgeScore {
  // 1. 格式（+5 / 归零出局）
  if (!judgeModelFindings.format_ok) {
    return { total: 0, fatal: true, reason: "格式不合规，直接出局",
      breakdown: { format: 0, faithfulness: 0, recall: 0, latency: 0 } };
  }
  // 2. 忠实度（幻觉实体 -10/个）
  const faithfulness = Math.max(-10, -10 * judgeModelFindings.hallucinated_entities.length);
  // 3. 字段召回（0-3）
  const recall = judgeModelFindings.missing_key_fields.length === 0 ? 3
    : judgeModelFindings.missing_key_fields.length === 1 ? 1 : 0;
  // 4. 延迟（0-2）
  const latency = input.candidateLatencyMs < 2000 ? 2 : input.candidateLatencyMs < 5000 ? 1 : 0;
  const total = 5 + faithfulness + recall + latency;
  return {
    total,
    fatal: faithfulness <= -10,
    reason: faithfulness <= -10 ? "出现幻觉（引入源材料不存在的实体）" : "达标",
    breakdown: { format: 5, faithfulness, recall, latency },
  };
}

export const PROMOTION_RULES = {
  scoreRatio: 0.95,   // 影子总分 ≥ 基线总分 × 0.95
  costRatio: 0.8,     // 且影子单次成本 ≤ 基线 × 0.8
  consecutiveWins: 30, // 连续 30 次达标 → 更新路由权重
};

// report 子命令：读取 telemetry.jsonl 生成晋升候选报告
export function report(telemetryFile = path.join(__dirname, "..", "telemetry.jsonl")): string {
  if (!fs.existsSync(telemetryFile)) return "暂无遥测数据。影子测试需先接入真实流量。";
  const recs: TelemetryRecord[] = fs.readFileSync(telemetryFile, "utf-8")
    .split("\n").filter(Boolean).map(l => JSON.parse(l));
  const prod = recs.filter(r => r.kind === "production" && r.outcome === "success");
  const shadow = recs.filter(r => r.kind === "shadow" && r.outcome === "success");
  if (!prod.length || !shadow.length) return "样本不足（需生产+影子各≥1条成功记录）。";
  const avg = (a: TelemetryRecord[], k: "costUsd" | "latencyMs") =>
    a.reduce((s, r) => s + r[k], 0) / a.length;
  const prodCost = avg(prod, "costUsd"), shadowCost = avg(shadow, "costUsd");
  const prodLat = avg(prod, "latencyMs"), shadowLat = avg(shadow, "latencyMs");
  return [
    `生产样本 ${prod.length} 条 | 影子样本 ${shadow.length} 条`,
    `平均成本: 生产 $${prodCost.toFixed(5)} vs 影子 $${shadowCost.toFixed(5)}（${((1 - shadowCost / prodCost) * 100).toFixed(1)}% 差异）`,
    `平均延迟: 生产 ${prodLat.toFixed(0)}ms vs 影子 ${shadowLat.toFixed(0)}ms`,
    `晋升判定: 影子成本 ≤ 生产×${PROMOTION_RULES.costRatio} → ${shadowCost <= prodCost * PROMOTION_RULES.costRatio ? "✅ 成本达标（结合 Judge 分数确认）" : "❌ 未达标"}`,
  ].join("\n");
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "report") console.log(report());
  else console.log("用法: npx tsx judge.ts report");
}
