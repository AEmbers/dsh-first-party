// DSH Host 依赖面契约（事实来源：docs/dsh-contract.md 建档，0.1.2-alpha.2；
// 字段形状以官方 `.d.ts`/源码为准，本文件是「依赖面」的唯一类型源）。
// 仅类型导出。dsh 升级核查流程（dsh-contract.md 第七节）改为 diff 本文件 +
// client-contract.ts。
//
// 建模纪律：读取侧字段尽量可选（双版本兼容分支：0.1.1-rc.2 ↔ 0.1.2-alpha.x），
// 运行时守卫（typeof 检查）不能补救错误假设——字段本不存在时守卫只是静默
// no-op（issue #9 实证），故类型按「文档承诺 + 探针钉真实实例」双锚。

// ---- 会话事件（core/session，54 种）----

// 0.1.5-alpha.1 已知事件类型全集（dsh-contract.md §四；Session format v3）
export type SessionEventType =
  | 'agent-preset/selected'
  | 'agent/inbox/spliced'
  | 'approval/asked'
  | 'approval/decided'
  | 'approval/policy'
  | 'assistant/attempt'
  | 'assistant/message'
  | 'command/done'
  | 'command/run'
  | 'compaction/end'
  | 'compaction/prune'
  | 'compaction/start'
  | 'compaction/summary'
  | 'feedback/message-delete'
  | 'feedback/message-put'
  | 'feedback/record'
  | 'goal/change'
  | 'hook/invoked'
  | 'hook/result'
  | 'llm/retry'
  | 'llm/retry-started'
  | 'model/selection'
  | 'permission/preset'
  | 'plan/mode'
  | 'request/context'
  | 'request/header'
  | 'sandbox/mode'
  | 'schedule/change'
  | 'session-log-deepseek/delivery-accepted'
  | 'session/end-seed'
  | 'session/title'
  | 'session/title-llm-request'
  | 'step/end'
  | 'step/start'
  | 'subagent/descriptor'
  | 'subagent/model-selection-policy'
  | 'system/message'
  | 'team/member'
  | 'team/message/delivered'
  | 'team/message/queued'
  | 'team/task'
  | 'todo/write'
  | 'tool-workflow/agent-end'
  | 'tool-workflow/agent-start'
  | 'tool-workflow/run-end'
  | 'tool-workflow/run-start'
  | 'tool/call'
  | 'tool/ptc-dispatch'
  | 'tool/ptc-dispatch-start'
  | 'tool/result'
  | 'turn/end'
  | 'turn/start'
  | 'user/message'
  | 'web/deepseek-search-llm-request'

// 事件信封：{ type, seq, time, data, ignorable? }（0.1.2-alpha.2 恢复 ignorable）
export interface SessionEvent {
  type: SessionEventType
  seq: number
  time: number
  ignorable?: boolean
  data?: SessionEventData
}

// 事件来源：kind 区分 user/plugin/tool…；rpcId 是浏览器 prompt 的提交身份，
// 同一批内容在「inbox 入队」与「user/message 落日志」两处共用同一个值。
export interface SessionEventSource {
  kind?: string
  rpcId?: string
  [key: string]: unknown
}

// 插件实际消费的事件 data 字段（读取侧可选；text 块拼接见 messageTextFromEvents）
export interface SessionEventData {
  id?: string | number
  source?: SessionEventSource
  title?: string
  content?: Array<{ type?: string; text?: string }>
  // agent/inbox/spliced：本次插进 inbox 的项。source.kind === 'user' 的项即
  // 一次排队投递——撤回的 fork 切点会把这类事件一并复制进子会话（见
  // snapshots.ts scanStaleQueueItemIds），故这是清理残留排队项的唯一线索。
  // id 就是该消息的 message id，也是官方 updateQueue 的寻址键。
  inserted?: Array<{ id?: string; source?: SessionEventSource }>
  [key: string]: unknown
}

// ---- 会话（core/session：SessionStore + api/session-controller 的 ISessions 扩展）----

export interface SessionHeader {
  id: string
  cwd?: string
  origin?: string
}

export interface Session {
  id: string
  header?: SessionHeader
  // 0.1.5-rc.1 实测：会话对象只暴露 snapshotEvents()，无 events 访问器——
  // 读内存事件一律先探 snapshotEvents，events 是旧版字段（读到即用，
  // 读不到落磁盘降级链）。
  snapshotEvents?(): SessionEvent[]
  events?: SessionEvent[]
}

export interface SessionStore {
  get(id: string): Session | undefined
  list(): Session[]
  create?(id?: string, options?: unknown): Session
}

// 0.1.2 迁包后 fork 签名逐字段一致；不传 increaseTitle 避免「xxx 2」递增（I6）
export interface SessionsForkService {
  fork(opts: { sessionId: string; atSeq?: number; increaseTitle?: boolean }): Promise<string>
}

// ---- sessionQuery（冷会话查询）----

export interface SessionRecord {
  header: SessionHeader
  live: boolean
  persisted: boolean
}

export interface SessionLogSnapshot {
  session: SessionHeader
  events: SessionEvent[]
}

// observeSession 的观测租约：events 是全量逻辑日志（含 fork 继承前缀）。官方在
// 租约上装 Symbol.dispose，本文件不建模符号键（ES2022 lib 无该类型），释放由
// snapshots.ts 的 disposeLease 运行时探测。
export interface SessionObservationLease {
  events?: SessionEvent[]
}

export interface SessionQueryEngine {
  listSessions(signal?: unknown): Promise<SessionRecord[]>
  readSession(sessionId: string): Promise<SessionLogSnapshot>
  // seeded 会话（撤回 fork 出的子会话）上 readSession 恒抛——官方 Session.create
  // 校验要求 seed 恰等于 fork 继承前缀，而读取侧给的是全量日志，必然不等
  // （0.1.5-rc.2 实测）。observeSession 经 restore 恢复、无此约束；旧版 dsh 无此
  // API（可选），缺失时调用侧维持原行为。
  observeSession?(sessionId: string): Promise<SessionObservationLease>
}

// ---- shell（命令执行）----

export interface ShellExecRequest {
  command: string
  timeoutMs?: number
  stdoutMaxBytes?: number
  stdin?: string
  sandboxPolicy?: { mode: string; workspaceRoot?: string }
}

export interface ShellRunResult {
  exitCode?: number
  stdout?: { text?: string; truncated?: boolean }
  stderr?: { text?: string }
}

export interface ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecRequest
  run(spec: ShellExecRequest): Promise<ShellRunResult>
}

// ---- agents（Agent 注册表，P0-1 运行中 agent 拦截）----

export interface AgentInfo {
  id: string
  status: 'idle' | 'running' | string
  session?: { header?: { cwd?: string } }
}

export interface AgentRegistry {
  list(): AgentInfo[]
  get?(id: string): AgentInfo | undefined
}

// ---- connection（载体无关 API 路由注册表；web 与桌面端统一）----

// 插件只消费 fetch 注册面。exact 匹配：注册 path 与请求 pathname 全等才有响应，
// 未命中由宿主共享分发器返回 404——插件不再自建前缀分发（桌面端 composition
// 禁用 webserver row，硬依赖 webServer 会让 fiber 永久 pending）。
export type ConnectionFetchMethod = 'GET' | 'HEAD' | 'POST'
export interface ConnectionFetchRoute {
  readonly path: string
  readonly methods: readonly ConnectionFetchMethod[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}
export interface HostConnectionFetch {
  // 返回异步 disposer，但注册本体挂在 connection 插件自身的 fiber 上（实现里
  // owner = this.ctx，不是调用者）——调用方必须用 ctx.effect 包裹返回值，
  // HMR 重载才不会撞「exact Fetch route ... is already registered」。
  register(route: ConnectionFetchRoute): () => Promise<void>
}
export interface HostConnectionHandle {
  readonly fetch: HostConnectionFetch
}

// ---- settings（设置 namespace 注册 + 读写）----

export interface SettingsSectionHooks<T> {
  setSource(fn: () => T): void
  onChange(): void
}

export interface SettingsScope<T> {
  get(): T
  watch(fn: () => void): unknown
}

// routes-manage 消费面：describe/update/replace/writable
export interface SettingsDescriptor {
  ns?: string
  user?: Record<string, unknown>
}

export interface SettingsService {
  installSection<T>(owner: unknown, ns: string, schema: unknown, entry: T, hooks: SettingsSectionHooks<T>): void
  register<T>(ns: string, schema: unknown, options?: unknown): SettingsScope<T>
  describe?(): SettingsDescriptor[]
  update?(ns: string, patch: Record<string, unknown>): Promise<unknown>
  replace?(ns: string, value: unknown): Promise<unknown>
  writable?: boolean
}

// ---- Host 插件 ctx（cordis 4：服务先 inject 声明才能 ctx.<name> 访问，I10）----

export interface HostContext {
  shell: ShellExecutor
  sessions: SessionStore
  agents: AgentRegistry
  get<T = unknown>(name: string): T | undefined
  inject(names: string[], callback: (ctx: InjectedContext) => void): unknown
  on(event: string, listener: (session: Session, event: SessionEvent) => void): unknown
  effect(fn: () => void | (() => void | Promise<void>)): unknown
}

// ctx.inject([...], cb) 回调上下文（cordis 可选/延迟注入：服务缺席不 pending，
// 回调只在本次 names 就绪时执行）。字段是「注入服务合集」——settings 分支只读
// settings、connection 分支只读 connection；合并在一个形状里仅为 inject 签名统一，
// 回调内不得跨注入读取另一字段（本次注入中它并不可达）。
export interface InjectedContext {
  settings: SettingsService
  connection: HostConnectionHandle
  effect(fn: () => void | (() => void | Promise<void>)): unknown
}
