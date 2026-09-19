/**
 * 仅撤回对话模式（execute scope）单测（工厂级，注入假 deps 不跑 git）
 *
 * session-only 短路径：不进串行队列（队列只为 git 锁互斥而设）、零 git 写
 * 操作（无 STALE 校验/安全快照/rollback/rescue），保留 NO_SNAPSHOT +
 * AGENT_BUSY 两道护栏后直接 resolveCutSeq + resolveStaleQueueItemIds，
 * count 恒 0。scope 缺省/非法一律回落 both（现状链路回归钉）。
 */

import { describe, it, expect } from 'vitest'
import { createRoutesCore } from '../../src/host/routes-core.js'
import * as E from '../../src/host/errors.js'

const ROOT = 'D:/ws'
const ID = 'm1'

function makeDeps(opts = {}) {
  const state = {
    snapshots: new Map([[ID, { root: ROOT, time: 1, sessionId: 's1' }]]),
    stores: new Map([[ROOT, { dir: '/store', git: '/store/git/.git' }]]),
    gitExe: 'git-exe',
    errors: [],
  }
  // runShell/diffFor/rollbackFor 计数不分类：session-only 的验收是「任何
  // git/shell 副作用零发生」，总数为 0 即零写操作（含安全快照与救援）
  const calls = { enqueue: 0, runShell: 0, diffFor: 0, rollback: 0 }
  const deps = {
    rt: {
      state,
      recordError: (m) => state.errors.push(String(m)),
      runShell: async () => {
        calls.runShell++
        return 'SNAP_OK'
      },
      scripts: { snapshotScript: () => 'SNAP_SCRIPT' },
    },
    snaps: {
      diffFor: async () => {
        calls.diffFor++
        return { changes: [], total: 7, truncated: false, treeId: null }
      },
      rollbackFor: async () => {
        calls.rollback++
        return { ok: true, count: 3 }
      },
      resolveCutSeq: async () => opts.cutSeq ?? 5,
      resolveStaleQueueItemIds: async () => opts.staleQueueItemIds ?? [],
    },
    state,
    cfg: { baseExcludes: [] },
    supported: true,
    enqueue: (task) => {
      calls.enqueue++
      return task()
    },
    agentBusy: () => Boolean(opts.agentBusy),
    rescueRollback: async () => ({ ok: false, code: E.RECALL_ROLLBACK_FAILED, message: 'rescue' }),
    E,
  }
  return { deps, calls }
}

describe('execute scope：session-only 短路径与回落', () => {
  it('session-only：不进队列、零 git 调用，cutSeq/staleQueueItemIds 透传，count 恒 0', async () => {
    const { deps, calls } = makeDeps({ staleQueueItemIds: ['m-stale'] })
    const routes = createRoutesCore(deps)
    const res = await routes.execute({ messageId: ID, scope: 'session-only' })
    expect(res.ok).toBe(true)
    expect(res.count).toBe(0)                          // count 语义 = 回退文件数
    expect(res.cutSeq).toBe(5)
    expect(res.staleQueueItemIds).toEqual(['m-stale']) // 清理链与模式无关，照常透传
    expect(calls.enqueue).toBe(0)                      // 串行队列零占用
    expect(calls.runShell).toBe(0)                     // 零 shell：无安全快照/回退/救援
    expect(calls.diffFor).toBe(0)                      // 无重复 diff（STALE 校验整链跳过）
    expect(calls.rollback).toBe(0)
  })

  it('session-only + agent 运行中 → AGENT_BUSY（队列外护栏）', async () => {
    const { deps, calls } = makeDeps({ agentBusy: true })
    const routes = createRoutesCore(deps)
    const res = await routes.execute({ messageId: ID, scope: 'session-only' })
    expect(res.ok).toBe(false)
    expect(res.code).toBe(E.RECALL_AGENT_BUSY)
    expect(calls.enqueue).toBe(0)
    expect(calls.runShell).toBe(0)
  })

  it('session-only + 未知 messageId → NO_SNAPSHOT（消息归属判定 + 防御直调 API）', async () => {
    const { deps, calls } = makeDeps()
    const routes = createRoutesCore(deps)
    const res = await routes.execute({ messageId: 'unknown', scope: 'session-only' })
    expect(res.ok).toBe(false)
    expect(res.code).toBe(E.RECALL_NO_SNAPSHOT)
    expect(calls.runShell).toBe(0)
  })

  it('scope 非法值（files-only / 数字 / 对象）→ 落回 both，git 链全跑', async () => {
    for (const bad of ['files-only', 7, {}]) {
      const { deps, calls } = makeDeps()
      const routes = createRoutesCore(deps)
      const res = await routes.execute({ messageId: ID, scope: bad })
      expect(res.ok).toBe(true)
      expect(res.count).toBe(3)        // rollbackFor 的回退文件数，非 session-only 的 0
      expect(calls.enqueue).toBe(1)    // 进串行队列（现状链路）
      expect(calls.runShell).toBe(1)   // 安全快照照打（现状语义）
      expect(calls.rollback).toBe(1)
    }
  })

  it('不传 scope → both（现状回归钉：老 Client 行为不漂移）', async () => {
    const { deps, calls } = makeDeps()
    const routes = createRoutesCore(deps)
    const res = await routes.execute({ messageId: ID })
    expect(res.ok).toBe(true)
    expect(res.count).toBe(3)
    expect(calls.enqueue).toBe(1)
    expect(calls.rollback).toBe(1)
  })
})
