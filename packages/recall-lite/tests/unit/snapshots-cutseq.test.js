/**
 * snapshots.js 工厂级测试（I33）：resolveCutSeq 读取面降级
 *
 * readSession 对 seeded 会话（本插件每次撤回 fork 出的子会话）在 0.1.5-rc.2
 * 恒抛——官方内部用 Session.create 校验，快照模式要求 seed 恰等于 fork 继承
 * 前缀，读取侧给全量日志必然不等。此前异常被静默折成 null，与“真首条”不可分，
 * 子会话里点任何消息都误报“该消息是本会话中第一条用户消息”。
 *
 * 本档用假 ctx/sessionQuery 钉住新降级链：抛错或缺消息 → observeSession 取
 * 全量事件；只有「消息在、其前无 turn/end」不降级；两跳都失败保底 null；
 * 租约显式释放、结果进缓存。
 */

import { describe, it, expect } from 'vitest'
import { createSnapshots, scanCutSeqDetail } from '../../src/host/snapshots.js'

const EVENTS = [
  { seq: 10, type: 'turn/end' },
  { seq: 11, type: 'user/message', data: { id: 'm-inherited' } },
  { seq: 12, type: 'turn/end' },
  { seq: 13, type: 'user/message', data: { id: 'm-own' } },
]

function makeSnaps(query) {
  const state = { cutSeqCache: new Map() }
  const ctx = {
    sessions: { get: () => null },
    get: (name) => (name === 'sessionQuery' ? query : undefined),
  }
  const snaps = createSnapshots(ctx, { state, scripts: {} }, { baseExcludes: [] })
  return { snaps, state }
}

describe('scanCutSeqDetail（found 语义）', () => {
  it('区分「消息不存在」与「消息在、其前无 turn/end」', () => {
    expect(scanCutSeqDetail(EVENTS, 'nope')).toEqual({ cut: null, found: false })
    expect(scanCutSeqDetail([{ seq: 1, type: 'user/message', data: { id: 'x' } }], 'x')).toEqual({ cut: null, found: true })
  })
})

describe('resolveCutSeq 读取面降级（I33）', () => {
  it('readSession 抛错（seeded 子会话）→ observeSession 全量事件按原 seq 空间算切点，租约释放且结果进缓存', async () => {
    let disposed = 0
    const query = {
      readSession: async () => { throw new Error('seeded session constructor seed must equal its inherited prefix') },
      observeSession: async () => ({ events: EVENTS, [Symbol.dispose]() { disposed++ } }),
    }
    const { snaps } = makeSnaps(query)
    expect(await snaps.resolveCutSeq('s1', 'm-inherited')).toBe(10)
    expect(disposed).toBe(1)
    // 同 key 二次调用命中缓存，不再读、不再释放
    expect(await snaps.resolveCutSeq('s1', 'm-inherited')).toBe(10)
    expect(disposed).toBe(1)
    // 自身区间的消息同样可见
    expect(await snaps.resolveCutSeq('s1', 'm-own')).toBe(12)
  })

  it('readSession 成功但事件里缺该消息（读取面缺继承前缀）→ observeSession 兜底命中', async () => {
    let observed = 0
    const query = {
      readSession: async () => ({ events: EVENTS.filter((e) => e.seq >= 12) }),
      observeSession: async () => { observed++; return { events: EVENTS } },
    }
    const { snaps } = makeSnaps(query)
    expect(await snaps.resolveCutSeq('s1', 'm-inherited')).toBe(10)
    expect(observed).toBe(1)
  })

  it('消息在、其前无 turn/end（真首条）→ 不降级，结论可信', async () => {
    let observed = 0
    const firstEvents = [
      { seq: 1, type: 'user/message', data: { id: 'first' } },
      { seq: 2, type: 'turn/end' },
      { seq: 3, type: 'user/message', data: { id: 'second' } },
    ]
    const query = {
      readSession: async () => ({ events: firstEvents }),
      observeSession: async () => { observed++; return { events: firstEvents } },
    }
    const { snaps } = makeSnaps(query)
    expect(await snaps.resolveCutSeq('s1', 'first')).toBe(null)
    expect(await snaps.resolveCutSeq('s1', 'second')).toBe(2)
    expect(observed).toBe(0)
  })

  it('两跳都失败 → null（不抛）', async () => {
    const query = {
      readSession: async () => { throw new Error('read boom') },
      observeSession: async () => { throw new Error('observe boom') },
    }
    const { snaps } = makeSnaps(query)
    expect(await snaps.resolveCutSeq('s1', 'm-inherited')).toBe(null)
  })

  it('旧版无 observeSession → 维持原行为：readSession 抛错即 null', async () => {
    const query = { readSession: async () => { throw new Error('read boom') } }
    const { snaps } = makeSnaps(query)
    expect(await snaps.resolveCutSeq('s1', 'm-inherited')).toBe(null)
  })
})
