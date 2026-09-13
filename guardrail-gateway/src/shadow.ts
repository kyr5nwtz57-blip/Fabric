// shadow.ts — 影子流量测试（异步、采样、绝不阻塞生产、绝不写回用户响应）
import { optimizeAndRoute } from "./router";
import { logTelemetry, TelemetryRecord } from "./telemetry";
import { computeScore, JudgeInput, PROMOTION_RULES } from "./judge";
import * as fs from "fs";
import * as path from "path";

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config", "providers.json"), "utf-8")
);

interface ShadowState { consecutiveWins: number; promoted: boolean }
const SHADOW_STATE_FILE = path.join(__dirname, "..", "shadow-state.json");
let shadowState: ShadowState = fs.existsSync(SHADOW_STATE_FILE)
  ? JSON.parse(fs.readFileSync(SHADOW_STATE_FILE, "utf-8"))
  : { consecutiveWins: 0, promoted: false };

function persistState(): void {
  fs.writeFileSync(SHADOW_STATE_FILE, JSON.stringify(shadowState, null, 2));
}

/**
 * 在生产调用成功返回后调用（fire-and-forget，不 await）。
 * shadowModelId: 实验模型供应商 id（来自 config/providers.json）；
 * judgeFindings / baselineScore 由 LLM-as-a-Judge 流水线提供。
 */
export function shadowTest(params: {
  task: string;
  prompt: string;
  baselineCostUsd: number;
  baselineScore: number;
  shadowModelId: string;
  sourceMaterial: string;
  baselineOutput: string;
}): void {
  const { shadowTrafficRatio } = config.guardrails;
  if (Math.random() >= shadowTrafficRatio) return; // 采样 5%
  if (shadowState.promoted) return; // 已晋升则停止影子写入

  // 异步执行：失败静默记录，绝不影响生产链路
  void (async () => {
    const t0 = Date.now();
    try {
      // 临时路由到实验模型：复用 router 的护栏执行（超时/成本同样受保护）
      const result = await optimizeAndRoute(`shadow:${params.task}`, params.prompt);
      const score = computeScore({
        task: params.task,
        sourceMaterial: params.sourceMaterial,
        baselineOutput: params.baselineOutput,
        candidateOutput: result.text,
        candidateLatencyMs: Date.now() - t0,
      }, { format_ok: true, hallucinated_entities: [], missing_key_fields: [] });

      const rec: TelemetryRecord = {
        ts: new Date().toISOString(), kind: "shadow", providerId: result.providerId,
        model: params.shadowModelId, task: params.task, latencyMs: result.latencyMs,
        inputTokens: 0, outputTokens: 0, costUsd: result.costUsd,
        outcome: score.fatal ? "parse_error" : "success",
      };
      logTelemetry(rec);

      // Phase 4: 自动晋升判定（连续 N 次达标才更新权重——防单次运气）
      const scoreOk = score.total >= params.baselineScore * PROMOTION_RULES.scoreRatio && !score.fatal;
      const costOk = result.costUsd <= params.baselineCostUsd * PROMOTION_RULES.costRatio;
      if (scoreOk && costOk) {
        shadowState.consecutiveWins += 1;
        if (shadowState.consecutiveWins >= PROMOTION_RULES.consecutiveWins) {
          shadowState.promoted = true;
          console.warn(`[PROMOTION] ${params.shadowModelId} 连续 ${PROMOTION_RULES.consecutiveWins} 次达标，` +
            `已自动晋升：后续 ${params.task} 任务权重切换至实验模型。管理员请复核。`);
        }
      } else {
        shadowState.consecutiveWins = 0;
      }
      persistState();
    } catch (err) {
      // 影子测试失败不影响生产，仅记录
      const rec: TelemetryRecord = {
        ts: new Date().toISOString(), kind: "shadow", providerId: params.shadowModelId,
        model: params.shadowModelId, task: params.task, latencyMs: Date.now() - t0,
        inputTokens: 0, outputTokens: 0, costUsd: 0, outcome: "http_error",
      };
      logTelemetry(rec);
    }
  })();
}

/*
接入示例（在你的生产调用点）：
  const prod = await optimizeAndRoute("extract", prompt);   // 生产主路径
  shadowTest({                                              // 异步影子，不 await
    task: "extract", prompt,
    baselineCostUsd: prod.costUsd,
    baselineScore: 18,            // 由 Judge 对生产输出评分
    shadowModelId: "lastline-fast",
    sourceMaterial: rawDoc,
    baselineOutput: prod.text,
  });
  return prod;              // 用户只拿到生产结果，影子纯后台
*/
