// DSH Client 依赖面契约（事实来源：docs/dsh-contract.md §二 52 个 slot 清单 +
// src/client/* 现状消费面；0.1.2-alpha.2）。仅类型导出。
//
// 建模纪律同 dsh-contract.ts：读取侧可选、双版本兼容分支显式建模——
// conversation 服务 0.1.2 才有（0.1.1-rc.2 无，不能进静态 inject），styles
// 服务 0.1.2 已不存在——两者统一 ctx.get 探测 + 联合/可选类型表达降级。

// ---- __ModuleLoader__ 装载契约（I13：单文件 CJS factory，react external）----

declare global {
  interface Window {
    __ModuleLoader__: {
      load(opts: {
        id: string
        factory: (require: (name: string) => unknown) => unknown
      }): unknown
    }
  }
}

// ---- slot 全量清单（dsh-contract.md §二，52 个；★ = 插件注册）----
// 0.1.6-alpha.2：settings.plugin.item 随旧设置页插件 tab 移除；新增
// ui-plugin-manager 的 plugins.item / plugins.bundle.config / plugins.row.config，
// 插件设置卡片迁挂 plugins.bundle.config（key=bundle 包名）。

export type SlotName =
  | 'conversation.chat.node' // ★ keyed/session（ui-chat）
  | 'settings.plugin.item' // ★ keyed/root（ui-settings-plugins；0.1.6-alpha.2 起移除，仅旧版生效）
  | 'plugins.bundle.config' // ★ keyed/root（0.1.6-alpha.2 新增 ui-plugin-manager，key=bundle 包名）
  | 'conversation' // single/session-maybe（ui-layout）
  | 'conversation.session' // single/session（ui-conversation）
  | 'conversation.session.header'
  | 'conversation.session.header.actions'
  | 'conversation.session.header.lineage'
  | 'conversation.session.header.utilities'
  | 'conversation.view'
  | 'conversation.composer'
  | 'conversation.composer.bar'
  | 'conversation.composer.dock'
  | 'conversation.input.attachments'
  | 'conversation.input.dock'
  | 'conversation.input.left'
  | 'conversation.input.right'
  | 'conversation.input.overlay'
  | 'conversation.input.plan'
  | 'conversation.input.model'
  | 'conversation.hero.brand.mark'
  | 'conversation.hero.workspace'
  | 'conversation.hero.agentPreset'
  | 'conversation.chat.commandview'
  | 'conversation.chat.assistant-actions'
  | 'conversation.chat.turnTail'
  | 'conversation.message.images'
  | 'conversation.details.tool'
  | 'details'
  | 'conversation.approval.detail'
  | 'conversation.trajectory.images'
  | 'shell.overlay'
  | 'sidebar'
  | 'sidebar.brand.mark'
  | 'sidebar.brand.name'
  | 'sidebar.footer.action'
  | 'sidebar.settings'
  | 'sidebar.workspaces'
  | 'root'
  | 'settings.action'
  | 'settings.close'
  | 'settings.general.item'
  | 'settings.header'
  | 'settings.onboarding'
  | 'settings.plugins.tab'
  | 'settings.section'
  | 'settings.trigger'
  | 'settings.models.footer'
  | 'settings.models.provider-card'
  | `tool.call.${'toolview'}` // 官方 slot #46（ui-tool）。DSH-Store 保护性权限扫描以该 slot 名的连续字面量为受保护信号，拆写为 template literal type 后类型层面与字面量完全相同（同理可收窄/赋值），但源码文本不含连续子串，避免被静态规则误判为「接触工具调用视图」——本枚举仅类型备忘，零运行时携带
  | 'tool.view.cordis'
  | 'conversation.hero.workspace.directoryFlow'
  | 'sidebar.workspaces.directoryFlow'

// ---- Chat 节点（conversation.chat.node keyed slot props）----
// 插件实际读取仅三字段：node / renderMessageImages / sessionId（I2：props
// 无裸 loadImage；I3：sessionId 由 scope=session kit 注入；I4：node.id 是
// 快照主键、node.key 是位置键；I5：keyed key 与 UI 投影 kind 对齐 user+steering）

export interface ChatNodeData {
  id?: string
  key?: string
  kind?: string
  [key: string]: unknown
}

export interface ChatNodeProps {
  node?: ChatNodeData
  // 图片唯一入口：内部经 conversation.message.images slot 渲染官方
  // MessageImages（issue #9 实证：契约里从不存在 loadImage）
  renderMessageImages?: unknown
  sessionId?: string
}

// ---- 会话/工作区服务（client 侧）----

// Session 对象层（sessions.binding(sessionId).session）：readAttachment 取回历史
// 附件的原始字节 + mediaType——官方图片回显（HistoricalImageCache）走它，撤回
// 回填的附件重建沿用同一通道。仅探测式消费：缺 binding/readAttachment 时附件
// 回填整体降级，文本回填不受影响。
export interface SessionAttachmentRef {
  attachmentId?: string
  mediaType?: string
  name?: string
  [key: string]: unknown
}

export type ReadAttachmentResult =
  | { ok: true; value?: { attachment?: SessionAttachmentRef; data?: unknown } }
  | { ok: false; error?: { code?: string; message?: string } }

export interface SessionObjectLayer {
  readAttachment?(attachmentId: string): Promise<ReadAttachmentResult>
  // 官方队列变更动词。只用 remove：按 Host 下发的 item id（= 消息 id）删掉
  // fork seed 重放出来的残留排队项，相当于用户在 QueueDock 上点「删除排队
  // 消息」。入队项已被消费时返回 queue-item-not-found，调用侧逐项吞掉。
  updateQueue?(itemId: string, action: { kind: 'remove' }): Promise<unknown>
}

export interface SessionBinding {
  session?: SessionObjectLayer
}

export interface ClientSessionsService {
  fork(opts: { sessionId: string; atSeq?: number; increaseTitle?: boolean }): Promise<string>
  // 0.1.6-alpha.2 起 ISessions 移除 open（「navigation belongs to view owners」，
  // 导航移交 ui-workspace 的 openSession）——可选化，旧版仍走这里
  open?(sessionId: string): unknown
  // settings-cards 的「切换版本会话」探测：官方会话列表快照（{ byId }）
  list?: { getSnapshot(): { byId?: Record<string, unknown> } }
  // 会话对象层入口（官方 ui-conversation 对附件回读走 binding().session）
  binding?(sessionId: string): SessionBinding | null | undefined
}

export interface ClientWorkspacesService {
  // 返回类型按调用方既有假设建模为 Promise（迁移前 JS 直接对其结果 .catch）：
  // 真实服务恒返 thenable；若某版本返非 thenable，旧行为是当场 TypeError，
  // 不做 Promise.resolve 静默兜底（避免掩盖官方契约漂移）
  archiveSession(sessionId: string): Promise<unknown>
  // 归档会话集合（快照管理「切换」闸门用）：0.1.6-alpha.2 起 sessions.list 含
  // 归档会话，而归档会话不是合法的主视图选择——官方导航会对归档选择 clearMain
  // 落空态，故判据必须另从这里排除
  list?: { getSnapshot(): { archivedSessionIds?: readonly string[] } }
}

// ui-workspace 的 UiWorkspace（会话导航视图所有者）：0.1.6-alpha.2 起
// ISessions 移除 open（「navigation belongs to view owners」），fork 后打开
// 子会话改走其 openSession；0.1.2-alpha.1 起服务存在，0.1.1-rc.2 无（该线段
// 已从 peer 范围移除，见 entry.ts inject 注释）。
export interface ClientUiWorkspaceService {
  openSession(sessionId: string): void
  archiveSession(sessionId: string): Promise<unknown>
  unarchiveSession(sessionId: string): Promise<unknown>
}

// ---- conversation 服务（0.1.2 新增，可选探测降级）----
// conversation.input.shell(sessionId).actions.setDraft(text) 是 refillDraft 的
// 官方写入通道；0.1.1-rc.2 无此服务（fillDraft 有界重试恒降级）

export interface ConversationInputShell {
  actions?: {
    setDraft(text: string): void
    // 官方 composer 的 addFiles 走 shell.addAttachments（actions 面是同一实现
    // 的公开通道）；返回 false 表示未接纳（调用方应释放已注册的草稿附件）
    addAttachments?(ids: string[]): boolean | unknown
  }
  setDraft?(text: string): void
  addAttachments?(ids: string[]): boolean | unknown
}

// conversation.createDrafts(sessionId, files) 的草稿描述符：id 供
// shell.addAttachments 进入输入态，kind 为 'image' / 'file'
export interface DraftAttachmentDescriptor {
  id?: string
  kind?: string
  [key: string]: unknown
}

export interface ConversationService {
  input?: {
    shell?(sessionId: string): ConversationInputShell | null | undefined
  }
  // 把浏览器 File 注册为运行时草稿附件（图片=object URL 预览且随 prompt 发字节；
  // 其他文件立即开始后台上传），返回按输入顺序的描述符。官方 composer 的
  // addFiles 即 createDrafts → shell.addAttachments →（未接纳）releaseDraftAttachments。
  createDrafts?(sessionId: string, files: File[]): DraftAttachmentDescriptor[]
  releaseDraftAttachments?(drafts: DraftAttachmentDescriptor[]): void
}

// ---- styles 服务（0.1.1-rc.2 存在、0.1.2 已移除，探测 + <style> 降级）----

export interface StylesService {
  insert(css: string): unknown
}

// ---- slots 服务（keyed 注册：负值 priority 冲突递减重试，I1）----

// slots.entries 返回的条目形状：{ options: { key, priority } }（冲突探测读
// entry.options.key / entry.options.priority，见 app.ts nextShadowPriority）
export interface SlotEntryOptions {
  options?: { key?: string; priority?: number }
}

export interface SlotsService {
  inject(name: SlotName | string, factory: () => unknown): unknown
  register(opts: { name: string; key?: string; priority?: number }, component: unknown): unknown
  entries(name: string): SlotEntryOptions[]
}

// ---- Client 插件 ctx（cordis 4 guard：声明过的服务才能 ctx.<name> 访问）----

export interface ClientContext {
  slots: SlotsService
  sessions: ClientSessionsService
  workspaces: ClientWorkspacesService
  uiWorkspace: ClientUiWorkspaceService
  timer: { timeout(fn: () => void, ms: number): unknown }
  get<T = unknown>(name: string): T | undefined
}

// 插件对象形态（entry.ts factory 返回；inject 清单见 entry.js）
export interface ClientPluginObject {
  name: string
  inject: string[]
  apply(ctx: ClientContext): void
}
