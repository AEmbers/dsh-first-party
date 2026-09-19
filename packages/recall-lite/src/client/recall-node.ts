/**
 * dsh-recall-lite — client 撤回节点（UserRecallNode + recallPanel）
 *
 * 从原 lib/client.js 抽出：kind 单表、变更摘要、确认面板、用户消息重绘
 * （文本/图片/JSON 块，图片经官方 renderMessageImages 管线）、撤回执行链
 * （preview→execute→fork→回填）。KIND_INFO/summaryText 模块级导出供单测。
 */

import type { ReactApi, UtilApi } from './util.js'
import type { ClientContext, ClientSessionsService, ClientWorkspacesService, ClientUiWorkspaceService, ChatNodeProps, ConversationService, ConversationInputShell } from '../types/client-contract.js'
import type { SnapshotInfoResponse, PreviewResponse, ExecuteResponse, DiffChange, RecallScope } from '../types/api.js'

// 用户消息内容块（text/image/JSON 等）：只读已知字段，其余透传 unknown
export interface ChatBlock {
  type?: string
  text?: string
  attachment?: unknown
  [key: string]: unknown
}

// 被撤回消息里可回填为草稿附件的块引用：image / file 两类块都带 durable
// attachment 引用（{attachmentId, ...}）。
export interface DraftAttachmentRef {
  attachmentId: string
  name?: string
}

// 纯函数（模块级导出供单测）：从内容块提取附件引用。只认带非空 attachmentId 的
// image/file 块；缺 name 的由回填侧按 mediaType 派生文件名。
export function attachmentRefsFromBlocks(blocks: ChatBlock[]): DraftAttachmentRef[] {
  const refs: DraftAttachmentRef[] = []
  for (const block of blocks) {
    if (!block || (block.type !== 'image' && block.type !== 'file')) continue
    const ref = block.attachment as { attachmentId?: unknown; name?: unknown } | null | undefined
    if (!ref || typeof ref.attachmentId !== 'string' || ref.attachmentId === '') continue
    const entry: DraftAttachmentRef = { attachmentId: ref.attachmentId }
    if (typeof ref.name === 'string' && ref.name !== '') entry.name = ref.name
    refs.push(entry)
  }
  return refs
}

// 缺省附件文件名：媒体类型 → 「attachment-N.<subtype>」（image/png → png）
export function defaultAttachmentName(mediaType: unknown, index: number): string {
  const text = String(mediaType || '')
  const slash = text.indexOf('/')
  const sub = (slash >= 0 ? text.slice(slash + 1) : text).replace(/[^a-z0-9.+-]/gi, '')
  return 'attachment-' + String(index + 1) + '.' + (sub || 'bin')
}

// 文件卡片的展示信息（官方 UserStyleBubble 对 file 块渲染成「图标 + 文件名 +
// 扩展名/大小」卡片；插件的自定义渲染器必须自己复刻，否则 file 块会落到
// JSON 兜底里变成一坨原文）。
export interface FileCardInfo {
  name: string
  ext: string
  size: string
}

// 扩展名徽标文本：取最后一个点之后的部分，大写并截断到 4 字符（PDF/JSON/DOCX）；
// 无扩展名或点名结尾回退 'FILE'。
function fileExtOf(name: string): string {
  const dot = name.lastIndexOf('.')
  const raw = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : ''
  const ext = raw.replace(/[^a-z0-9]/gi, '').toUpperCase()
  return ext ? ext.slice(0, 4) : 'FILE'
}

// 附件体积文本：官方卡片写「6.7KB」这种紧凑形态（无空格、KB 起一位小数），
// 与设置页磁盘占用的 sizeText（MB 起、带空格）是两种语境，不复用。
function fileCardSizeText(bytes: unknown): string {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : NaN
  if (Number.isNaN(n)) return ''
  if (n < 1024) return String(Math.round(n)) + 'B'
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB'
  return (n / 1073741824).toFixed(1) + 'GB'
}

// 纯函数（模块级导出供单测）：file 块 → 文件卡片信息。只认 type === 'file'；
// 引用形状异常（缺 attachment）时给兜底名，绝不返回 null —— file 块一旦漏回
// JSON 兜底就是「整块原文」的可见回归，宁可渲染一张信息不全的卡片。
export function fileCardInfo(block: ChatBlock | null | undefined): FileCardInfo | null {
  if (!block || block.type !== 'file') return null
  const ref = block.attachment as { name?: unknown; bytes?: unknown } | null | undefined
  const name = ref && typeof ref === 'object' && typeof ref.name === 'string' && ref.name !== '' ? ref.name : '未命名文件'
  return { name, ext: fileExtOf(name), size: fileCardSizeText(ref && typeof ref === 'object' ? ref.bytes : undefined) }
}

// kind 语义单表承载（文案/徽章类名/汇总顺序）：新增 kind 时只改这一处
export type ChangeKind = 'modified' | 'restored' | 'added'
export const KIND_INFO: Record<ChangeKind, { label: string; cls: string }> = {
  modified: { label: '修改', cls: 'modified' },
  restored: { label: '恢复', cls: 'restored' },
  added: { label: '删除', cls: 'added' }
}

export interface ChangeCounts {
  modified: number
  restored: number
  added: number
}

export function summaryText(counts: ChangeCounts): string {
  const parts: string[] = []
  for (const kind of Object.keys(KIND_INFO) as ChangeKind[]) {
    if (counts[kind] > 0) parts.push(KIND_INFO[kind].label + ' ' + counts[kind])
  }
  return parts.join(' · ')
}

// 撤回面板的状态机：idle（默认，仅按钮）→ loading（预览中）→ error →
// confirm（变更清单 + 确认）→ executing（回退中）→ done（结果）
export type RecallStage =
  | { stage: 'idle' }
  | { stage: 'loading' }
  | { stage: 'error'; message: string }
  | { stage: 'confirm'; changes: DiffChange[]; total: number; truncated: boolean; treeId: string | null; time: number | null; cutSeq: number | null }
  | { stage: 'executing'; changes: DiffChange[] }
  | { stage: 'done'; count: number; chatReverted: boolean; chatError: string }

export interface RecallNodeApi {
  UserRecallNode: (props: ChatNodeProps) => unknown
}

export function buildRecallNode(
  React: ReactApi,
  util: UtilApi,
  ctx: ClientContext,
  sessionsSvc: ClientSessionsService,
  workspacesSvc: ClientWorkspacesService,
  uiWorkspaceSvc?: ClientUiWorkspaceService
): RecallNodeApi {
  const { api, ensureInit, showThrottledToast, writeClipboard, clockText, pluginConfig, messageFor } = util

  function CopyIcon() {
    return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
      React.createElement('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }),
      React.createElement('path', { d: 'M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5' })
    )
  }

  function CheckIcon() {
    return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('path', { d: 'm3 8.5 3.2 3.2L13 5' })
    )
  }

  function UndoIcon() {
    return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('path', { d: 'M7.5 3.5 3.5 7.5l4 4' }),
      React.createElement('path', { d: 'M4.5 7.5h5a3 3 0 0 1 0 6H8' })
    )
  }

  // scope/onScopeChange：模式选择是确认面板内的组件态（both/session-only），
  // 面板文案矩阵（清单语义/安全快照预告/按钮/executing/done）随其分叉；放
  // recallPanel 参数而非模块级——HMR 与多消息节点并挂时各面板状态互不串扰。
  function recallPanel(recall: RecallStage, closePanel: () => void, executeRecall: () => void, scope: RecallScope, onScopeChange: (s: RecallScope) => void) {
    if (recall.stage === 'loading') {
      return React.createElement('div', { className: 'dsh-recall-panel' },
        React.createElement('div', { className: 'dsh-recall-panel-title' }, '正在计算变更…')
      )
    }
    if (recall.stage === 'error') {
      return React.createElement('div', { className: 'dsh-recall-panel' },
        React.createElement('div', { className: 'dsh-recall-panel-title' }, '无法回退'),
        React.createElement('div', { className: 'dsh-recall-panel-note' }, recall.message || ''),
        React.createElement('div', { className: 'dsh-recall-panel-actions' },
          React.createElement('button', { type: 'button', className: 'dsh-recall-btn', onClick: closePanel }, '关闭')
        )
      )
    }
    if (recall.stage === 'confirm') {
      const changes = recall.changes || []
      const total = typeof recall.total === 'number' ? recall.total : changes.length
      const counts: ChangeCounts = { modified: 0, restored: 0, added: 0 }
      for (const c of changes) {
        if (c && (counts as unknown as Record<string, number>)[c.kind] !== undefined) (counts as unknown as Record<string, number>)[c.kind]++
      }
      const rows: Array<ReturnType<typeof React.createElement>> = changes.map((c: DiffChange, i: number) => {
        const info = KIND_INFO[c.kind as ChangeKind]
        return React.createElement('div', { className: 'dsh-recall-file', key: i },
          React.createElement('span', { className: 'dsh-recall-badge dsh-recall-badge-' + (info ? info.cls : '') }, info ? info.label : (c.kind || '')),
          React.createElement('span', { className: 'dsh-recall-rel' }, c.rel || '')
        )
      })
      // cutSeq 为 null 表示该消息是会话第一条用户消息：文件可回退但对话无从回退
      const canRevertChat = typeof recall.cutSeq === 'number'
      // session-only 仅在对话可回退时可达（radio 组只在 canRevertChat 时渲染，
      // 首条消息的面板与现状完全一致）
      const sessionOnly = canRevertChat && scope === 'session-only'
      if (recall.truncated) {
        rows.push(React.createElement('div', { className: 'dsh-recall-panel-note', key: 'truncated' },
          sessionOnly
            ? '…仅显示前 ' + changes.length + ' 条，共 ' + total + ' 处差异'
            : '…仅显示前 ' + changes.length + ' 条，共 ' + total + ' 个文件将变更'
        ))
      }
      return React.createElement('div', { className: 'dsh-recall-panel' },
        React.createElement('div', { className: 'dsh-recall-panel-title' }, '整段回退'),
        sessionOnly
          ? // session-only：零文件改动即无不可逆操作缺口——安全快照预告随之隐藏
            //（不打安全快照），主说明换成模式语义
            React.createElement('div', { className: 'dsh-recall-panel-note' },
              '项目文件保持当前状态，不会被回退或删除；对话回退到该消息之前。'
            )
          : React.createElement('div', { className: 'dsh-recall-panel-note' },
              '将项目恢复到' + (recall.time ? ' ' + clockText(recall.time) + ' ' : ' ') + '发送该消息时的状态。共 ' + total + ' 个文件将变更' + (summaryText(counts) ? '（' + summaryText(counts) + '）' : '') + '。此操作会覆盖当前文件内容；回退前会自动保存一份当前状态的安全快照（不含在下方清单内）。'
            ),
        sessionOnly ? null : React.createElement('div', { className: 'dsh-recall-panel-note' },
          canRevertChat
            ? '对话将一并回退到该消息之前：该消息及之后的全部对话会从当前视图移除，原会话归档保存（可从归档找回）。'
            : '该消息是本会话中第一条用户消息，无法回退对话；确认后仅回退项目文件。'
        ),
        sessionOnly && changes.length > 0
          ? // 文件清单保留展示但降级为参考语义：清单照常算（Host preview 链路
            // 不分叉），只是告知用户所选模式不会真的改这些文件
            React.createElement('div', { className: 'dsh-recall-panel-note', key: 'ref-note' },
              '以下差异仅作参考，所选模式不会改动文件。'
            )
          : null,
        changes.length > 0 ? React.createElement('div', { className: 'dsh-recall-list' }, ...rows) : null,
        canRevertChat
          ? // 模式二选一（原生 radio，键盘方向键可达）：临场选择不设全局配置项；
            // 默认 both 与现状一致，面板每次打开都复位到默认起点
            React.createElement('div', { className: 'dsh-recall-scope', role: 'radiogroup', 'aria-label': '撤回范围' },
              React.createElement('label', { className: 'dsh-recall-scope-item' },
                React.createElement('input', { type: 'radio', name: 'dsh-recall-scope', checked: scope === 'both', onChange: () => onScopeChange('both') }),
                React.createElement('span', { className: 'dsh-recall-scope-label' }, '回退文件与对话')
              ),
              React.createElement('label', { className: 'dsh-recall-scope-item' },
                React.createElement('input', { type: 'radio', name: 'dsh-recall-scope', checked: scope === 'session-only', onChange: () => onScopeChange('session-only') }),
                React.createElement('span', { className: 'dsh-recall-scope-label' }, '仅撤回对话')
              )
            )
          : null,
        React.createElement('div', { className: 'dsh-recall-panel-actions' },
          React.createElement('button', { type: 'button', className: 'dsh-recall-btn', onClick: closePanel }, '取消'),
          React.createElement('button', { type: 'button', className: 'dsh-recall-btn dsh-recall-btn-danger', onClick: executeRecall }, sessionOnly ? '确认撤回对话' : '确认回退')
        )
      )
    }
    if (recall.stage === 'executing') {
      return React.createElement('div', { className: 'dsh-recall-panel' },
        React.createElement('div', { className: 'dsh-recall-panel-title' }, scope === 'session-only' ? '正在撤回对话…' : '正在回退…')
      )
    }
    if (recall.stage === 'done') {
      return React.createElement('div', { className: 'dsh-recall-panel' },
        React.createElement('div', { className: 'dsh-recall-panel-title' }, '回退完成'),
        React.createElement('div', { className: 'dsh-recall-panel-note' },
          scope === 'session-only'
            ? // session-only 文案矩阵：文件侧零改动是确定事实，失败时也只描述对话侧
              (recall.chatReverted
                ? '对话已回退到该消息之前，项目文件保持当前状态。新会话已打开，原会话已归档（可从归档找回）。'
                : '对话回退失败：' + (recall.chatError || '未知原因') + '。项目文件未做任何改动。')
            : (recall.chatReverted
                ? '项目文件与对话已回退到该消息之前。新会话已打开，原会话已归档（可从归档找回）。'
                : '项目已恢复到发送该消息时的状态。' + (recall.chatError ? ' 对话回退失败：' + recall.chatError : ''))
        ),
        React.createElement('div', { className: 'dsh-recall-panel-actions' },
          React.createElement('button', { type: 'button', className: 'dsh-recall-btn', onClick: closePanel }, '关闭')
        )
      )
    }
    return null
  }

  // 撤回后把被撤回消息的文本与附件回填到输入框，方便用户修改后重新发送。
  // 官方 conversation 服务提供 input（InputHub）→ per-session shell → actions，
  // 走与输入框自身同一条官方写入通道。附件沿用官方 composer 的 addFiles 链路
  // （ui-conversation 实证）：sessions.binding 门禁 → session.readAttachment 取回
  // 字节 → conversation.createDrafts 注册草稿附件 → shell 的 addAttachments 进
  // 输入态（未接纳时 releaseDraftAttachments 释放）。fork + open 之后 shell /
  // binding 可能需要一个 tick 才就绪，做有界重试：最多 8 次、间隔 150ms；服务面
  // 缺失时静默跳过（文本与附件各自独立降级，附件读不出不影响撤回主流程）。
  function fillDraft(targetSessionId: string, draftText: string, attachmentFiles: Promise<File[]> | null): void {
    if (!targetSessionId || (!draftText && attachmentFiles === null)) return
    let attempts = 0
    let attachStarted = false
    const attempt = () => {
      let textDone = draftText === ''
      try {
        // conversation 服务 0.1.2 才有（0.1.1-rc.2 无，ui-conversation 提供），
        // 不能进静态 inject——否则 0.1.1-rc.2 上声明缺失服务插件静默不启动。
        // 走 ctx.get 探测：guard 的 get 对缺失/未声明服务安全返回 undefined，
        // 拿不到就降级重试（0.1.1-rc.2 恒降级；0.1.2 视服务可见性而定）。
        const conversation = ctx.get<ConversationService>('conversation')
        if (conversation && conversation.input && typeof conversation.input.shell === 'function') {
          const shell = conversation.input.shell(targetSessionId)
          if (shell) {
            if (!textDone) {
              if (shell.actions && typeof shell.actions.setDraft === 'function') {
                shell.actions.setDraft(draftText)
                textDone = true
              } else if (typeof shell.setDraft === 'function') {
                shell.setDraft(draftText)
                textDone = true
              }
            }
            if (!attachStarted && attachmentFiles !== null) {
              attachStarted = startAttachDrafts(conversation, shell, targetSessionId, attachmentFiles)
            }
          }
        }
      } catch (e) { /* fall through to retry */ }
      const attachDone = attachmentFiles === null || attachStarted
      if ((!textDone || !attachDone) && attempts++ < 8) setTimeout(attempt, 150)
    }
    attempt()
  }

  // 附件回填（后半程）：把早读好的 File 注册为子会话的草稿附件。返回「链路是否
  // 已发起」——服务面缺失返回 false，交由调用方有界重试；发起后逐项失败只降级
  // 该项，不再重试。
  function startAttachDrafts(conversation: ConversationService, shell: ConversationInputShell, sessionId: string, files: Promise<File[]>): boolean {
    if (typeof conversation.createDrafts !== 'function') return false
    const actions = shell.actions
    let add: ((ids: string[]) => unknown) | null = null
    if (actions && typeof actions.addAttachments === 'function') add = (ids) => actions.addAttachments ? actions.addAttachments(ids) : false
    else if (typeof shell.addAttachments === 'function') add = (ids) => shell.addAttachments ? shell.addAttachments(ids) : false
    if (add === null) return false
    ;(async () => {
      let list: File[] = []
      try { list = await files } catch (e) { return }
      if (!Array.isArray(list) || list.length === 0) return
      try {
        const drafts = conversation.createDrafts ? conversation.createDrafts(sessionId, list) : []
        const descriptors = Array.isArray(drafts) ? drafts : []
        const ids = descriptors.map((draft) => draft && draft.id).filter((id): id is string => typeof id === 'string' && id !== '')
        if (ids.length === 0) return
        const accepted = add(ids)
        // 官方 addFiles 的失败回滚：未接纳时释放已注册的草稿附件
        if (accepted === false && typeof conversation.releaseDraftAttachments === 'function') conversation.releaseDraftAttachments(descriptors)
      } catch (e) { /* 附件未回填；文本回填不受影响 */ }
    })()
    return true
  }

  // 附件早读（前半程）：撤回执行一开始调用——此刻源会话仍在册（归档在 fork
  // 之后才发生）、附件引用可解析；fork + open 完成后再由 fillDraft 注册进子会话。
  // readAttachment 的授权绑定在「消息所在会话」上（官方图片回显同款），故必须用
  // 源会话 id。逐项 try/catch：单项失败跳过，不阻断其余附件。
  function preloadAttachmentFiles(sourceSessionId: string, refs: DraftAttachmentRef[]): Promise<File[]> {
    return (async () => {
      const sessions = ctx.sessions
      const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(sourceSessionId) : undefined
      const session = binding && binding.session
      if (!session || typeof session.readAttachment !== 'function') return []
      const out: File[] = []
      for (const ref of refs) {
        try {
          const result = await session.readAttachment(ref.attachmentId)
          if (!result || result.ok !== true || !result.value || result.value.data === undefined || result.value.data === null) continue
          const raw = result.value.data
          const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw as ArrayLike<number>)
          const meta = result.value.attachment
          const mediaType = meta && typeof meta.mediaType === 'string' && meta.mediaType !== '' ? meta.mediaType : 'application/octet-stream'
          const name = ref.name || (meta && typeof meta.name === 'string' && meta.name !== '' ? meta.name : defaultAttachmentName(mediaType, out.length))
          // 拷贝出独立 ArrayBuffer 再建 File：Uint8Array<ArrayBufferLike> 不满足
          // 新版 TS 的 BlobPart（SharedArrayBuffer 分支），且避免视图共享底层缓冲
          const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
          out.push(new File([buffer], name, { type: mediaType }))
        } catch (e) { /* 单项失败跳过 */ }
      }
      return out
    })()
  }

  // 撤回后清理 fork 子会话里被 seed 重放出来的排队消息：官方 fork 的切点会
  // 把「被撤回消息的 inbox 入队事件」一并复制进子会话（Host 侧
  // scanStaleQueueItemIds 的窗口说明），子会话重建 inbox 后输入框上方就凭空
  // 多出一条排队消息；子会话被驱动时该入队项还会被当作真实一轮消费。
  //
  // 按 item id 直删：Host 下发的 id 就是那条消息的 message id，也正是官方
  // updateQueue 的寻址键（0.1.5-rc.1 实测：直删 accepted，重复删
  // queue-item-not-found），与 QueueDock 的「删除排队消息」同一动词。不读队列
  // 快照、不做 rpcId 匹配——队列快照走 control 帧、到达时机不定，命中式等待会
  // 整段落空（2.3.19 真机实证：30 秒窗口内卡片始终在，清理从未触发）。只在会话
  // 面尚未就绪时做短窗口重试（5 秒），拿到 face 即发出删除。
  function removeStaleQueueItems(targetSessionId: string, itemIds: unknown): void {
    if (!Array.isArray(itemIds) || itemIds.length === 0) return
    const deadline = Date.now() + 5000
    const attempt = () => {
      try {
        const binding = sessionsSvc && typeof sessionsSvc.binding === 'function' ? sessionsSvc.binding(targetSessionId) : null
        const face = binding && binding.session
        if (face && typeof face.updateQueue === 'function') {
          // 逐项失败只影响该项（与官方 QueueDock 的行级操作同语义）：入队项
          // 已被消费时返回 queue-item-not-found，此时已无残留可清。
          for (const itemId of itemIds) {
            if (typeof itemId !== 'string' || itemId === '') continue
            face.updateQueue(itemId, { kind: 'remove' }).catch(() => {})
          }
          return
        }
      } catch (error) { /* 服务面未就绪：继续等待 */ }
      if (Date.now() >= deadline) {
        console.warn('[dsh-recall-lite] 残留排队消息未能自动清理（会话面未就绪）：', itemIds)
        showThrottledToast('撤回前的一条排队消息未被自动清理，可点击该卡片右上角的删除按钮手动移除')
        return
      }
      setTimeout(attempt, 250)
    }
    attempt()
  }

  function UserRecallNode(props: ChatNodeProps) {
    const node = props && props.node
    // 图片渲染入口：官方 ChatNodeSeat 传给本 slot 的 props 契约只有
    // renderMessageImages（内部经 conversation.message.images slot 渲染
    // 官方 MessageImages，自带鉴权、缓存、失败重试与灯箱预览）。
    // 契约里从不存在 loadImage（issue #9）：读该不存在的字段导致自研加载链
    // 从未执行、用户消息图片永久无声空白。
    const renderMessageImages = props && props.renderMessageImages
    const sessionId = props && props.sessionId
    const data = (node && node.data ? node.data : {}) as { content?: unknown; time?: unknown }
    // node.id 是会话事件匹配时写入的真实消息 ID；node.key 是位置键，不能用于快照查询
    const messageId = node ? String(node.id || node.key || '') : ''
    const blocks: ChatBlock[] = Array.isArray(data.content) ? data.content as ChatBlock[] : []
    const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
    // 官方契约：images 传 image 块数组（{attachment}），官方内部取
    // image.attachment.attachmentId —— 不是裸 attachment 对象
    const imageBlocks: Array<{ attachment: unknown }> = blocks.filter((b) => b && b.type === 'image' && b.attachment).map((b) => ({ attachment: b.attachment }))
    // file 块（文档/表格等非图片附件）：官方 UserStyleBubble 渲染成文件卡片
    // （图标 + 文件名 + 扩展名/大小），插件覆盖了整个用户节点渲染，必须自己
    // 复刻——否则它落进下方 rest 的 JSON 兜底，消息里只剩一坨原文（可见回归）。
    const fileBlocks: ChatBlock[] = blocks.filter((b) => b && b.type === 'file')
    const rest: ChatBlock[] = blocks.filter((b) => !b || !(b.type === 'text' && typeof b.text === 'string') && !(b.type === 'image' && b.attachment) && b.type !== 'file')
    // 回填用附件引用（image/file 块）：撤回后连同文本一起回填到输入框
    const attachmentRefs = attachmentRefsFromBlocks(blocks)

    const [copied, setCopied] = React.useState(false)
    const [hasSnapshot, setHasSnapshot] = React.useState(false)
    const [recall, setRecall] = React.useState<RecallStage>({ stage: 'idle' })
    // 撤回范围（确认面板内临场选择）：默认 both 与现状一致；openPreview/
    // closePanel 时复位——每次面板打开都是确定起点，不残留上一次选择
    const [scope, setScope] = React.useState<RecallScope>('both')

    React.useEffect(() => {
      let alive = true
      let timer: ReturnType<typeof setTimeout> | null = null
      let attempts = 0
      // 快照捕获（Host 侧脚本）是异步的：消息节点挂载时 snapshot-info 可能
      // 先于捕获完成而返回 has:false。改为有界轮询：has:true 或达上限即停
      // （覆盖常规快照耗时，又避免无限请求），捕获完成后按钮自动出现。
      // 只对「近 5 分钟内」的消息轮询：快照只在消息发送当下捕获，老消息若
      // 没有快照就永远不会再有。
      const RETRY_WINDOW_MS = 5 * 60 * 1000
      const MAX_ATTEMPTS = 20
      const RETRY_MS = 1000
      const msgTime = data && typeof data.time === 'number' ? data.time : NaN
      const recent = !isNaN(msgTime) && Date.now() - msgTime <= RETRY_WINDOW_MS
      function schedule() {
        if (!alive || !messageId) return
        attempts++
        api<SnapshotInfoResponse>('snapshot-info', { messageId, sessionId }).then((res) => {
          if (!alive) return
          if (res && res.has) {
            // fail-open 跳过的路径：快照存在但个别目录没进去——仅对正在发生的
            // 消息提示，让用户知道快照少了什么（issue #7 失败可见性）
            if (recent && Array.isArray(res.skipped) && res.skipped.length) {
              const names = res.skipped.slice(0, 5).join('、') + (res.skipped.length > 5 ? ' 等 ' + res.skipped.length + ' 项' : '')
              showThrottledToast('快照已跳过未纳入的路径：' + names + '（撤回不会恢复或删除这些路径）')
            }
            setHasSnapshot(true)
            return
          }
          // 失败/熔断是终止态：快照不会迟到，提示后停止轮询
          if (res && res.failed) {
            if (recent) showThrottledToast('快照失败：' + String(res.error || '未知原因').slice(0, 140))
            return
          }
          if (recent && attempts < MAX_ATTEMPTS) timer = setTimeout(schedule, RETRY_MS)
        }).catch(() => {
          if (alive && recent && attempts < MAX_ATTEMPTS) timer = setTimeout(schedule, RETRY_MS)
        })
      }
      // 先等 init 预热完成再查快照存在性：避免索引未载入时误判 has:false
      ensureInit(sessionId).then(() => {
        if (!messageId || !alive) return
        schedule()
      }).catch(() => {
        if (alive && messageId) timer = setTimeout(schedule, RETRY_MS)
      })
      return () => {
        alive = false
        if (timer !== null) clearTimeout(timer)
      }
    }, [messageId, sessionId])

    const onCopy = () => {
      if (copied) return
      writeClipboard(text).then(() => {
        setCopied(true)
        // timer 同经 inject 声明属性访问；未就绪时降级裸 setTimeout。
        const timer = ctx.timer
        if (timer && typeof timer.timeout === 'function') {
          timer.timeout(() => setCopied(false), 1200)
        } else {
          setTimeout(() => setCopied(false), 1200)
        }
      })
    }

    const openPreview = () => {
      if (recall.stage === 'loading' || recall.stage === 'executing') return
      setScope('both')
      setRecall({ stage: 'loading' })
      api<PreviewResponse>('preview', { messageId, sessionId }).then((res) => {
        if (!res || !res.ok) {
          setRecall({ stage: 'error', message: messageFor(res, '无法获取快照') })
          return
        }
        // PF-1：treeId 是 preview 时的 index 树指纹，确认时透传回 execute——
        // Host 与安全快照指纹比对判 STALE，省一次重复 diff
        setRecall({
          stage: 'confirm',
          changes: res.changes || [],
          total: typeof res.total === 'number' ? res.total : (res.changes || []).length,
          truncated: Boolean(res.truncated),
          treeId: res.treeId || null,
          time: res.time || null,
          cutSeq: typeof res.cutSeq === 'number' ? res.cutSeq : null
        })
      }).catch((error) => {
        setRecall({ stage: 'error', message: String(error) })
      })
    }

    const executeRecall = () => {
      if (recall.stage !== 'confirm') return
      const changes = recall.changes || []
      const previewCut = typeof recall.cutSeq === 'number' ? recall.cutSeq : null
      // P0-3：携带预览摘要（total 是完整计数，与 Host 侧 diffFor 的 total
      // 对齐；changes 截断到 500 条，不能用来比对）。Host 端据此在 execute
      // 时校验「预览后文件集是否变化」，变了则返回 STALE 拒绝执行。
      // PF-1：新版同时透传 previewTreeId（内容级指纹），Host 优先用它比对
      // 且免一次重复 diff；老 Host 忽略未知字段自动退回 total 校验。
      const previewTotal = typeof recall.total === 'number' ? recall.total : changes.length
      // 附件早读：此刻源会话仍在册（归档在 fork 之后才发生）、附件引用可解析；
      // 读成的 File 在 fork 出的子会话里由 fillDraft 注册为草稿附件（见上）。
      const attachmentFiles = pluginConfig.refillDraft && attachmentRefs.length > 0 && sessionId
        ? preloadAttachmentFiles(sessionId as string, attachmentRefs)
        : null
      setRecall({ stage: 'executing', changes })
      // scope 透传：Host 端 session-only 走零 git 短路径；previewTreeId/
      // previewTotal 照常携带（Host 按 scope 忽略 STALE 校验）。cutSeq 为 null
      // 时 scope 恒为 both（radio 未渲染，无 session-only 可选）
      api<ExecuteResponse>('execute', { messageId, sessionId, previewTotal, previewTreeId: recall.treeId || undefined, scope, previewAt: Date.now() }).then(async (res) => {
        if (!res || !res.ok) {
          // STALE：预览后文件变了——自动重新拉一次最新清单回到确认阶段
          if (res && res.code === 'STALE') {
            setRecall({ stage: 'loading' })
            api<PreviewResponse>('preview', { messageId, sessionId }).then((res2) => {
              if (!res2 || !res2.ok) {
                setRecall({ stage: 'error', message: messageFor(res2, '无法获取快照') })
                return
              }
              setRecall({
                stage: 'confirm',
                changes: res2.changes || [],
                total: typeof res2.total === 'number' ? res2.total : (res2.changes || []).length,
                truncated: Boolean(res2.truncated),
                treeId: res2.treeId || null,
                time: res2.time || null,
                cutSeq: typeof res2.cutSeq === 'number' ? res2.cutSeq : null
              })
            }).catch((error) => {
              setRecall({ stage: 'error', message: String(error) })
            })
            return
          }
          setRecall({ stage: 'error', message: messageFor(res, '回退失败') })
          return
        }
        // 文件已回退；对话回退独立进行，失败只降级为“仅文件回退”而不是整体失败
        const cutSeq = typeof res.cutSeq === 'number' ? res.cutSeq : previewCut
        let chatReverted = false
        let chatError = ''
        // 回填目标会话：对话回退成功 → fork 出的新会话（视图已切过去）；
        // 失败/无切点 → 当前会话
        let fillTarget = sessionId
        if (cutSeq !== null && sessionsSvc && typeof sessionsSvc.fork === 'function') {
          try {
            // 撤回语义是「回退」而非「复制」：新会话顶替原会话（原会话已归档），
            // 必须原样继承标题。increaseTitle 是官方侧栏「复制会话」用来区分
            // 新旧会话的，会把标题改成「xxx 2」且多次撤回时数字不断递增，故不传。
            // sessionId 在撤回按钮可见时恒有（快照仅对已知会话生成），断言收口
            const childId = await sessionsSvc.fork({ sessionId: sessionId as string, atSeq: cutSeq })
            if (childId) {
              // 打开子会话：0.1.6-alpha.2 起 ISessions 移除 open（导航归视图所有
              // 者），改走 uiWorkspace 的 openSession；0.1.2〜0.1.6-alpha.1 用
              // sessions.open——按服务能力各吃各的，均缺失则降级为「仅文件回退、
              // 视图不切换」（守卫吞掉，无报错）
              if (uiWorkspaceSvc && typeof uiWorkspaceSvc.openSession === 'function') uiWorkspaceSvc.openSession(childId)
              else if (typeof sessionsSvc.open === 'function') sessionsSvc.open(childId)
              chatReverted = true
              fillTarget = childId
              // 子会话从 seed 继承了一份「被撤回消息的 inbox 入队记录」，不清理
              // 就会在输入框上方显示成一条排队消息（Host 已解析出它对应的
              // item id 集合）
              removeStaleQueueItems(childId, res.staleQueueItemIds)
              // F1：上报撤回链（childId ↔ parentId），Host 持久化供版本家族展示；
              // 上报失败不阻断撤回主流程（家族是纯增量 UI）。
              api<unknown>('lineage-record', { childId, parentId: sessionId }).catch(() => {})
              // 回退前的原会话归档（可关）：只是从列表隐藏、可恢复
              if (pluginConfig.archiveOriginal && workspacesSvc && typeof workspacesSvc.archiveSession === 'function') {
                // 归档失败不阻断撤回主流程（reject 吞掉）；与迁移前一致直接
                // .catch——非 thenable 返回是官方契约漂移，当场暴露而非静默
                workspacesSvc.archiveSession(sessionId as string).catch(() => {})
              }
            } else {
              chatError = '未返回新会话'
            }
          } catch (error) {
            chatError = String(error)
          }
        }
        // 把被撤回的消息文本回填到输入框（可在设置页关闭）
        // fillTarget 只在撤回链路上赋值（fork 出的 childId 或原 sessionId），
        // 断言收口——撤回执行必有会话上下文
        if (pluginConfig.refillDraft) {
          fillDraft(fillTarget as string, text, attachmentFiles)
          // 文件附件（非图片）没有回读通道：官方 session.attachment 只认图片引用
          // （Host 侧 referencedImage + readImage，file 块直接判 ATTACHMENT_NOT_
          // REFERENCED），插件侧读不到字节就必然填不回输入框。文本与图片照常
          // 回填，这里只把「少了什么」讲清楚，免得用户以为回填是完整的。
          if (fileBlocks.length > 0) showThrottledToast('被撤回消息里的文件附件无法自动回填（官方接口只支持图片回读），请重新选择文件')
        }
        setHasSnapshot(false)
        // 注：快照 tag 在 Host 侧有意保留（幂等回退），刷新页面后该消息的
        // 撤回按钮会重新出现——这是「可再次回退到同一点」的特性而非 bug。
        setRecall({ stage: 'done', count: typeof res.count === 'number' ? res.count : changes.length, chatReverted, chatError })
      }).catch((error) => {
        setRecall({ stage: 'error', message: String(error) })
      })
    }

    const closePanel = () => {
      setScope('both')
      setRecall({ stage: 'idle' })
    }

    const bubbleChildren: Array<ReturnType<typeof React.createElement>> = []
    // 图片在上、气泡在下：布局顺序对齐官方 UserStyleBubble
    if (imageBlocks.length && typeof renderMessageImages === 'function') {
      const render = renderMessageImages as (args: { images: Array<{ attachment: unknown }>; align: string }) => import('react').ReactNode
      bubbleChildren.push(React.createElement(React.Fragment, { key: 'images' },
        render({ images: imageBlocks, align: 'end' })
      ))
    }
    // 文件卡片与图片同属「附件在上、文本在下」的官方布局
    for (let i = 0; i < fileBlocks.length; i++) {
      const info = fileCardInfo(fileBlocks[i])
      if (!info) continue
      bubbleChildren.push(React.createElement('div', { className: 'dsh-recall-filecard', key: 'file-' + i },
        React.createElement('span', { className: 'dsh-recall-filecard-icon' }, info.ext),
        React.createElement('span', { className: 'dsh-recall-filecard-body' },
          React.createElement('span', { className: 'dsh-recall-filecard-name', title: info.name }, info.name),
          React.createElement('span', { className: 'dsh-recall-filecard-meta' }, info.size ? info.ext + ' ' + info.size : info.ext)
        )
      ))
    }
    if (text !== '') bubbleChildren.push(React.createElement('div', { className: 'dsh-recall-bubble', key: 'text' }, text))
    for (let i = 0; i < rest.length; i++) {
      bubbleChildren.push(React.createElement('pre', { className: 'dsh-recall-json', key: 'rest-' + i }, JSON.stringify(rest[i], null, 2)))
    }

    const actions = []
    actions.push(React.createElement('span', { className: 'dsh-recall-time', key: 'time' }, clockText(data.time)))
    actions.push(React.createElement('button', {
      key: 'copy',
      type: 'button',
      className: 'dsh-recall-action',
      'aria-label': copied ? '已复制' : '复制',
      title: copied ? '已复制' : '复制',
      onClick: onCopy
    }, copied ? React.createElement(CheckIcon, {}) : React.createElement(CopyIcon, {})))
    if (hasSnapshot) {
      actions.push(React.createElement('button', {
        key: 'recall',
        type: 'button',
        className: 'dsh-recall-action',
        'aria-label': '撤回',
        title: '整段回退：文件与对话一并回到该消息之前',
        onClick: openPreview
      }, React.createElement(UndoIcon, {})))
    }

    return React.createElement('div', { className: 'dsh-recall-row', 'data-time-hover-root': true },
      bubbleChildren.length > 0 ? React.createElement('div', { className: 'dsh-recall-stack', key: 'stack' }, ...bubbleChildren) : null,
      React.createElement('div', { className: 'dsh-recall-actions', key: 'actions' }, ...actions),
      recallPanel(recall, closePanel, executeRecall, scope, setScope)
    )
  }

  return { UserRecallNode }
}
