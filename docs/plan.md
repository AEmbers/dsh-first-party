# dsh-first-party 决策与改动记录

> 本文件记录**为什么这么做**，以及改动到什么程度。凡是能实测的数字都写实测值，
> 推断与未验证项明确标注。

## 1. 起点：一个可复现的启动瓶颈

在 25 个 bundle（2 官方 + 23 第三方）的 desktop profile 上做装前/装后对照：

| 指标 | 处置前 | 处置后 |
|---|---|---|
| `~/.dsh/sessions` 工作区分组数 | 82 | 11 |
| `startup.jsonl` 的 `host-boot` 阶段 | 42.3s | 22.1s |
| `dsh-recall-plugin` 单独净增（装前/装后对照） | — | **+4.2s** |

根因不是计算量，而是**启动期创建的 shell 子进程数**。`dsh-recall-plugin`
在 `apply()` 末尾对每个历史工作目录启动一条 6 段 Promise 链：

```
resolveStore → tryUpgradeToHome → ensureGit → loadIndex → rebuildOrphans → cleanupLegacy
```

每段都会 spawn 一次 shell，**无 await、无并发上限**。于是：

> 工作目录数 = 启动期并发子进程数

78 个 cwd 会在启动瞬间制造数百个 shell 子进程，打满 CPU，渲染进程启动超时
（`The Renderer did not report boot health within 30000ms`）。

## 2. 功能盘点：为什么只挑 recall

按「源码/产物行数」称重 23 个第三方 bundle，分三档：

| 档位 | 代表 | 行数量级 | 决策 |
|---|---|---|---|
| 巨型 | `@xmanrui/dsh-im`、`@linxin666/dsh-web-all`、`dshmarket`、`@changfenhuang/dsh-genui` | 1.3万 ~ 5.8万 | **不碰**。重写成本远高于收益 |
| 中型 | `dsh-skill-picker`、`dsh-ui-usage-billing`、`dsh-tool-normalizer`、`dsh-ui-tweaks` | 2.4k ~ 2.6万 | 暂不动。无实测启动开销证据 |
| 微型 + 高热 | **`dsh-recall-plugin`（5.4k）** | 数百 ~ 5.4k | **本次目标** |

`dsh-recall-plugin` 正好卡在「体量小 × 启动开销最大」的交叉点：它是唯一被实测
出 +4.2s 的插件，而它的总产物只有 5.4k 行。收益/成本比最高。

其余微型插件（`sidebar-width` 222 行、`opencode-session` 217 行、
`buddy-checkin` 546 行、`prompt-polish` 953 行）没有实测启动开销证据，
本阶段不动——避免为「整合」而整合。

## 3. 关键决策：合法 fork + 定向重构，而不是从零重写

上游 `dsh-recall-plugin` 是 **MIT 许可**（Copyright (c) 2026 dsh-recall-plugin
contributors，基线 2.3.24）。MIT 明确允许修改与再分发。

选择 fork 而非重写的理由：

1. **行为兼容有保障**。撤回涉及影子 git、排除表、大文件、BOM 编码、
   Windows/pwsh 与 posix 双模板、孤儿重建、GC、并发队列等大量边界情形，
   从零实现等于把这些坑重新踩一遍。
2. **改动面极小**。真正要改的只有「启动期预热」这一处，其余 8000+ 行
   逻辑不需要动——重写却要全部重新验证。
3. **目标达成度相同**。「自己掌控、不受上游更新影响」由 fork 本身达成，
   与是否重写无关。

代价：需要保留上游版权声明与许可，并在文档中明确标注衍生关系（已做，见
根 `LICENSE` 与 `packages/recall-lite/LICENSE`）。

## 4. 改动设计：eager → lazy

### 4.1 论证：预热对真实使用路径完全是冗余的

改造前先验证了三条使用路径是否依赖预热产物：

| 路径 | 是否依赖预热 | 证据 |
|---|---|---|
| 写快照 | **否**，自带完整初始化 | `captureSnapshot` 内部 `resolveStore → tryUpgradeToHome → ensureGit → loadIndex`（`snapshots.ts:546-569`） |
| 撤回 / 预览 | **否**，必经 `init` 端点 | 撤回必须先打开会话；`init` 内部就是同一套 `ensureGit → loadIndex → rebuildOrphans`（`routes-core.ts:37-66`） |
| 快照管理列表 | **否**，走磁盘 dump | `collectAllSnapshotRecords` / `dumpStores` 直接扫磁盘，不读内存索引 |

结论：上游**早已存在按需初始化入口**（`init` 端点，客户端每开一个会话必经），
启动预热只是「提前把所有工作区做一遍」。因此移除它不会造成功能缺失。

### 4.2 改动清单

| 文件 | 改动 |
|---|---|
| `src/host/index.ts` | 预热块由无条件执行改为 `cfg.warmup` 分派；`lazy` 下连 shell 探活轮询一并省掉（探活本身就要 spawn） |
| `src/host/config.ts` | 新增 `warmup` 配置项（schema + DEFAULTS + 解析白名单收敛） |
| `src/types/config.ts` | 新增 `WarmupMode` 类型 |
| `cordis.patch.yml` | `name` 改为 `dsh-recall-lite`；补 `warmup` 默认值与说明 |
| 全仓 | 包名统一 `dsh-recall-plugin` → `dsh-recall-lite`（24 文件 / 37 处）；`insert.id` 刻意保持 `recall` 以兼容既有 profile 覆盖行 |

### 4.3 配置语义

```yaml
# profile 的 cordis.patch.yml 里按 id: recall 重述整行即可覆盖
- id: recall
  name: 'dsh-recall-lite'
  config:
    warmup: 'lazy'      # 默认：启动期零 shell，首次使用时初始化
#   warmup: 'startup'   # 上游 eager 行为，仅供 A/B 对照实测
```

非法值（拼错、空串、`undefined`）一律回落 `'lazy'`——默认必须是安全的那个，
配置写错不该让用户付出启动变慢的代价。

## 5. 验证方法（未完成项明确标注）

| 项 | 方法 | 状态 |
|---|---|---|
| 构建通过 | `npm run build` | 待执行 |
| 产物含正确注册 id | `build-client.mjs` 内置字面量断言 | 待执行 |
| 类型检查 | `npm run typecheck` | 待执行 |
| 启动期零预热 | host 日志出现 `[recall-lite] warmup=lazy` 且无预热 spawn | 待实测 |
| 启动耗时改善 | `startup.jsonl` 的 `host-boot` 与切换前对照 | 待实测 |
| 撤回功能不回归 | 实际发消息 → 撤回 → 确认文件与对话都回退 | 待实测 |
| 快照管理列表可见 | 打开快照管理，确认历史快照仍列出 | 待实测 |

> **未验证即未完成。** 上表「待实测」项在实测通过前，不应视为已达成。

## 6. 后续路线

按「有实测证据才动手」推进：

1. **先实测本包**：确认启动耗时改善幅度与功能零回归，再考虑扩包。
2. **观察其他插件**：只有拿到「某插件确实拖慢启动」的实测数据，才立项替代。
3. **不做的事**：不为了「统一」去重写巨型插件；不把多个插件强行塞进一个
   bundle（单点崩溃会波及全部功能，且升级粒度变粗）。
