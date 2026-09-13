# 🛡️ Guardrail Gateway — Fabric LLM 调用护栏网关

> 自主优化架构师组件 · 与 Fabric 主程序零侵入集成
> 双护栏：单次执行 ≤ $0.05 / 日预算 ≤ $10（熔断后自动降级）

## 这是什么

一个 **OpenAI 兼容的本地网关**（Node 18+，运行时零依赖）。Fabric 的所有 LLM 请求经由网关转发后自动获得：

- **三级供应商降级链**：主路径熔断 → P1 轻量 → P2 兜底（每级 5s 超时、最多重试 3 次）
- **成本熔断**：单次预估超 $0.05 拒发；当日累计 ≥ $10 全量降级到 P2 + 告警
- **异常流量熔断**：5 分钟窗口环比 +500% 疑似 token 抽取攻击 → 直接拒绝
- **LLM-as-a-Judge 影子测试**：5% 采样异步测试廉价模型，连续 30 次达标自动晋升（不影响生产）
- **逐笔遥测**：`telemetry.jsonl` 记录成本/延迟/失败，驱动一切自动化决策

## 快速开始

```bash
cd guardrail-gateway
npm install
npm run build               # 编译到 dist/（需 Node 18+）
export P0_API_KEY=sk-xxx    # 至少配一个供应商 Key（也支持 LLM_API_KEY 通配）
export GATEWAY_KEY=my-gw-key  # 可选：网关客户端鉴权
npm start                   # 默认监听 http://127.0.0.1:8787
curl http://127.0.0.1:8787/health   # 查看日预算余量
```

## Fabric 接入（3 步，不改 Go 源码）

1. `fabric --setup` → 选择 OpenAI 供应商
2. **API Base URL** 填 `http://127.0.0.1:8787/v1`
3. **API Key** 填网关密钥（即 `GATEWAY_KEY`；未设置则任意值）

此后所有 `fabric` 命令的请求都经过护栏路由。

任何 OpenAI 兼容客户端（Python/CLI/桌面应用）同理：把 base_url 指向网关即可。

## 配置调优

编辑 `config/providers.json`：

| 字段 | 说明 |
|---|---|
| `guardrails.maxCostPerRun` | 单次成本上限（美元），默认 0.05 |
| `guardrails.dailyBudget` | 日预算熔断线，默认 10 |
| `guardrails.shadowTrafficRatio` | 影子采样比例，默认 0.05 |
| `providers[]` | 三级供应商，改 baseUrl/model/单价以匹配你实际使用的厂商 |

供应商 Key 通过环境变量注入：`P0_API_KEY` / `P1_API_KEY` / `P2_API_KEY`，或统一 `LLM_API_KEY`。

## 目录结构

```
src/gateway.ts     OpenAI 兼容 HTTP 服务（/v1/chat/completions, /health）
src/router.ts      护栏路由核心：排序/熔断/降级/成本核算
src/judge.ts       LLM-as-a-Judge 数学评分 + 晋升报告（npx tsx src/judge.ts report）
src/shadow.ts      5% 影子流量异步测试（绝不阻塞生产）
src/telemetry.ts   成本遥测 + 日预算熔断 + 异常流量检测
dist/              编译产物（npm run build 生成，不入库）
```

## 安全边界

- 所有供应商失败 → 安全中止并返回 503，**绝不无限重试**
- 幻觉检测阈值：引入源材料不存在的实体直接判 0 分出局，永不晋升
- 路由权重自动更新记录在 `shadow-state.json`，可人工回滚
