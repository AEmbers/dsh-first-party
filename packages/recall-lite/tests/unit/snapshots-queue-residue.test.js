/**
 * fork 残留排队项解析单测
 *
 * 官方 fork 的切点是「boundary 那条 turn/end 之后、下一个 turn/start 之前」的
 * 整段事件。排队投递的用户消息，其 inbox 入队事件（agent/inbox/spliced）必然
 * 落在「上一个 turn/end」与「领取它的 turn/start」之间——正好被复制进子会话
 * seed，子会话重建 inbox 后输入框上方就多出一条本该被撤回掉的排队消息。
 *
 * 本档钉住窗口扫描的边界（窗口在下一个 turn/start 处闭合、非 user 来源忽略、
 * 重复 id 去重、切点非法时整体放弃）与工厂侧的读取顺序（内存 snapshotEvents /
 * 旧版 events → observeSession → readSession；全失败返回空 = 不清理）。
 */

import { describe, it, expect } from 'vitest'
import { createSnapshots, scanStaleQueueItemIds } from '../../src/host/snapshots.js'

// 取自真实会话日志的形状：seq 93 turn/end（切点）→ 94 排队投递 m1 入队 →
// 95 turn/start（窗口闭合）→ 96 入队项被领取后移除 → 100 消息落进日志
const EVENTS = [
  { seq: 93, type: 'turn/end' },
  { seq: 94, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'm1', source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'image' }] }] } },
  { seq: 95, type: 'turn/start' },
  { seq: 96, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  { seq: 100, type: 'user/message', data: { id: 'm1', source: { kind: 'user', rpcId: 'r1' } } },
]

function makeSnaps({ sessions = { get: () => undefined }, query } = {}) {
  const state = { cutSeqCache: new Map() }
  const ctx = { sessions, get: (name) => (name === 'sessionQuery' ? query : undefined) }
  return createSnapshots(ctx, { state, scripts: {} }, { baseExcludes: [] })
}

describe('scanStaleQueueItemIds（fork 切点窗口）', () => {
  it('取窗口内 user 来源入队项的 item id，窗口在下一个 turn/start 处闭合', () => {
    expect(scanStaleQueueItemIds(EVENTS, 93)).toEqual(['m1'])
  })

  it('切点之后没有 turn/start（消息是最后一条）时扫到事件末尾', () => {
    const tail = [
      { seq: 10, type: 'turn/end' },
      { seq: 11, type: 'agent/inbox/spliced', data: { inserted: [{ id: 'm1', source: { kind: 'user', rpcId: 'r1' } }] } },
      { seq: 12, type: 'agent/inbox/spliced', data: { inserted: [{ id: 'm2', source: { kind: 'user', rpcId: 'r2' } }] } },
    ]
    expect(scanStaleQueueItemIds(tail, 10)).toEqual(['m1', 'm2'])
  })

  it('只认 user 来源，去掉重复 id 与缺 id 项，忽略队列移除与其他事件', () => {
    const mixed = [
      { seq: 1, type: 'turn/end' },
      { seq: 2, type: 'agent/inbox/spliced', data: { inserted: [{ id: 'p1', source: { kind: 'plugin', plugin: 'hooks-codex' } }] } },
      { seq: 3, type: 'agent/inbox/spliced', data: { inserted: [
        { id: 'm1', source: { kind: 'user', rpcId: 'r1' } },
        { id: 'm1', source: { kind: 'user', rpcId: 'r1' } },
        { id: '', source: { kind: 'user', rpcId: 'r3' } },
        { source: { kind: 'user', rpcId: 'r4' } },
      ] } },
      { seq: 4, type: 'agent/inbox/spliced', data: { removedCount: 1, inserted: [] } },
      { seq: 5, type: 'turn/start' },
    ]
    expect(scanStaleQueueItemIds(mixed, 1)).toEqual(['m1'])
  })

  it('切点非法/缺失时不清理（返回空数组）', () => {
    expect(scanStaleQueueItemIds(EVENTS, null)).toEqual([])
    expect(scanStaleQueueItemIds(EVENTS, NaN)).toEqual([])
    expect(scanStaleQueueItemIds(null, 93)).toEqual([])
  })
})

describe('resolveStaleQueueItemIds（工厂侧读取顺序）', () => {
  it('live 会话暴露 snapshotEvents() → 用内存事件扫窗口，不碰 sessionQuery', async () => {
    let queried = false
    const snaps = makeSnaps({
      sessions: { get: (id) => (id === 's1' ? { id: 's1', snapshotEvents: () => EVENTS } : undefined) },
      query: {
        readSession: async () => { queried = true; return { events: EVENTS } },
        observeSession: async () => { queried = true; return { events: EVENTS } },
      },
    })
    expect(await snaps.resolveStaleQueueItemIds('s1', 93)).toEqual(['m1'])
    expect(queried).toBe(false)
  })

  it('旧版 events 字段在位时照常可用', async () => {
    const snaps = makeSnaps({ sessions: { get: () => ({ id: 's1', events: EVENTS }) } })
    expect(await snaps.resolveStaleQueueItemIds('s1', 93)).toEqual(['m1'])
  })

  it('会话不在册 → 先走 observeSession（restore 模式覆盖 seeded 父会话）', async () => {
    const order = []
    const snaps = makeSnaps({
      sessions: { get: () => undefined },
      query: {
        observeSession: async () => { order.push('observe'); return { events: EVENTS } },
        readSession: async () => { order.push('read'); return { events: [] } },
      },
    })
    expect(await snaps.resolveStaleQueueItemIds('s1', 93)).toEqual(['m1'])
    expect(order).toEqual(['observe'])
  })

  it('observeSession 缺席（旧版服务）→ 落 readSession', async () => {
    const snaps = makeSnaps({
      sessions: { get: () => undefined },
      query: { readSession: async () => ({ events: EVENTS }) },
    })
    expect(await snaps.resolveStaleQueueItemIds('s1', 93)).toEqual(['m1'])
  })

  it('三跳全失败/入参缺失 → 返回空数组而非抛错', async () => {
    const snaps = makeSnaps({
      sessions: { get: () => undefined },
      query: {
        observeSession: async () => { throw new Error('seeded session') },
        readSession: async () => { throw new Error('not found') },
      },
    })
    expect(await snaps.resolveStaleQueueItemIds('s1', 93)).toEqual([])
    expect(await snaps.resolveStaleQueueItemIds(null, 93)).toEqual([])
    expect(await snaps.resolveStaleQueueItemIds('s1', null)).toEqual([])
  })
})
