// 配置域类型（事实来源：src/host/config.ts 的 Config schema 与 DEFAULTS）。
// 仅类型导出——共享运行时常量继续住 src/host/config.ts。
//
// config.ts 的 `createConfig(raw: RawConfig): ResolvedConfig` 与
// `DEFAULTS: ResolvedConfig` 标注（schema 增删字段时漏改 DEFAULTS 编译期报错，
// 消灭「改默认值两处同步改」的人工同步面）。

/**
 * 启动期预热策略（本 fork 新增）。
 *
 * 上游对每个历史工作目录在 apply 期就起一条 6 段 Promise 链（每段 spawn 一次
 * shell），工作目录数 = 启动期并发子进程数。实测 78 个 cwd 会把 CPU 打满并
 * 让渲染进程启动超时。
 *
 * - `'lazy'`（默认）：启动期一条 shell 都不起。工作区的初始化改由既有按需
 *   入口承担——`init` 端点（客户端每打开一个会话必经）、快照写入路径
 *   （captureSnapshot 自带 ensureGit）、快照管理列表（走磁盘 dump）。
 * - `'startup'`：保留上游的 eager 行为，仅用于对照实测排障。
 */
export type WarmupMode = 'lazy' | 'startup'

export interface ResolvedConfig {
  gcSnaps: number
  gcHours: number
  maxFileBytes: number
  maxSnapshotsPerWorkspace: number
  baseExcludes: string[]
  refillDraft: boolean
  snapshotEnabled: boolean
  archiveOriginal: boolean
  retentionDays: number
  warmup: WarmupMode
}

export type RawConfig = Partial<ResolvedConfig>
