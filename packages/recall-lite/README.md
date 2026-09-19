# dsh-recall-lite

DSH（DeepSeek Harness）的消息撤回插件：工作区文件与对话历史一起回到某条消息发出
**之前**，该消息的文本与附件自动放回输入框，改完即可重发。

文件走独立影子 git 快照（不碰项目自身的 git），对话走官方 `sessions.fork`，
原会话归档可找回。

**相对上游的唯一实质改动：启动期不再对全部历史工作区做 eager 预热。**

## 为什么需要这个 fork

上游 [dsh-recall-plugin](https://github.com/limbo947/dsh-recall-plugin) 在 `apply()`
末尾对**每个历史工作目录**启动一条 6 段 Promise 链，每段都会 spawn 一次 shell，
无 `await`、无并发上限：

```
resolveStore → tryUpgradeToHome → ensureGit → loadIndex → rebuildOrphans → cleanupLegacy
```

于是「历史工作目录数」直接等于「启动期并发子进程数」。实测 78 个 cwd 会在启动
瞬间制造数百个 shell 子进程，打满 CPU，进而让渲染进程启动超时；`host-boot`
阶段从 22.1s 恶化到 42.3s。

而这些预热工作对实际使用**完全是冗余的**——三条使用路径各自本就自足：

| 使用路径 | 为何不依赖预热 |
|---|---|
| 写快照 | `captureSnapshot` 自带 `resolveStore → tryUpgradeToHome → ensureGit → loadIndex` |
| 撤回 / 预览 | 必须先打开会话，打开会话必经 `init` 端点，`init` 内部是同一套初始化 |
| 快照管理列表 | 走磁盘 dump（`dumpStores`），不读内存索引 |

## 改动对照

| 项 | 上游 | 本 fork |
|---|---|---|
| 启动期 shell spawn | 每个历史 cwd × 6 段链 | **0**（`warmup: 'lazy'` 默认） |
| 工作区初始化时机 | 启动时全部 | 首次被真正用到时 |
| 预热策略 | 不可配置 | `warmup: 'lazy' \| 'startup'` |
| 其余逻辑 | — | 完全保留，未改动 |

`insert.id` 刻意保持与上游一致（`recall`），因此 profile 里已有的 `- id: recall`
覆盖行无需改写即可继续生效。

## 安装

```bash
# 1. 先卸载上游（同一 insert id，不能共存）
dsh plugin --profile desktop remove dsh-recall-plugin

# 2. 从本地目录安装（构建产物 lib/ 已入库，无需本地构建）
dsh plugin --profile desktop add <本仓库路径>/packages/recall-lite

# 3. 重启 DSH
```

如果此前在 profile 的 `cordis.patch.yml` 里自定义过 `id: recall` 行的 config，
那些覆盖会继续生效（配置键名未变）。

### 回退到上游

```bash
dsh plugin --profile desktop remove dsh-recall-lite
dsh plugin --profile desktop add dsh-recall-plugin
```

两者共用同一份快照数据（存储位置与格式未改动），来回切换不丢历史撤回点。

## 配置

在 profile 的 `cordis.patch.yml` 里按 `id: recall` 重述整行即可覆盖（patch 按行
替换 config，不做深度合并）：

```yaml
- id: recall
  name: 'dsh-recall-lite'
  config:
    warmup: 'lazy'        # 默认。启动期零 shell；如需排查启动问题可切 'startup'
    gcSnaps: 50           # 每积累多少条快照触发一次 git gc
    gcHours: 24           # 距上次 gc 超过多少小时触发
    maxFileBytes: 104857600
    refillDraft: true     # 撤回后把消息文本回填输入框
```

`warmup` 可选值：

- `'lazy'`（默认）——启动期不起任何 shell，连 shell 探活轮询也省掉。工作区在
  首次被用到时初始化。
- `'startup'`——完整保留上游 eager 行为，**仅用于 A/B 对照实测**。工作区数量
  大时会显著拖慢启动。

非法值（拼错、空串、`undefined`）一律回落 `'lazy'`。

### 验证「预热确实已摘掉」

重启后查 host 日志，应出现：

```
[recall-lite] warmup=lazy：启动期不预热工作区，工作区将在首次使用时初始化
```

且启动阶段不应再出现大批 `pwsh` 子进程。

## 开发

```bash
npm install --legacy-peer-deps
npm run build        # esbuild 逐文件转译 → lib/
npm run typecheck
npm run test         # vitest
```

改代码请改 `src/`，不要手改 `lib/`（`lib/` 是构建产物，但需要入库以便分发）。

## 许可

MIT。本包是 dsh-recall-plugin（MIT，基线 2.3.24）的衍生作品，上游许可证原文
完整保留于本目录 `LICENSE`。改动清单见仓库根 `docs/plan.md`。
