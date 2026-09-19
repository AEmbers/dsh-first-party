/**
 * win32 shell 方言探针与直连通道单测（issue #15）
 *
 * 背景：官方 shell 是提供方注册制，宿主可把 win32 上的 ctx.shell 配成 bash，
 * 此时 pwsh 模板第一行编码前导即语法错误（功能面全死）。修法是行为探针判方言
 * + 判成 bash 时 Node spawn 直连 powershell.exe。本文件覆盖三段：
 * 1) 判定/收集/env 清洗三个模块级纯函数——平台无关，ubuntu CI 也能全跑；
 * 2) runViaSpawn 经假 child 覆盖 stdin 字节透传、截断、超时 kill、spawn error；
 * 3) createRuntime 的分流接线：bash 方言走直连（官方通道只跑探针那一次）、
 *    pwsh 方言零触达 spawn（默认路径零回归）、探针 in-flight 去重只跑一次。
 *
 * 直连通道只在 win32 生效，故第 3 段临时改写 process.platform（结束即还原）；
 * 前两段不依赖平台。
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  SHELL_PROBE_COMMAND,
  SHELL_PROBE_SENTINEL,
  judgeShellDialect,
  collectStdout,
  scrubChildEnv,
  directPwshPath,
  runViaSpawn,
  createRuntime,
} from '../../src/host/store.js'

// 假 child：只实现 runViaSpawn 用到的面（stdout/stderr 的 data 事件、stdin.end、
// error/close、kill）。用普通 EventEmitter 而非 Readable——事件同步派发，测试
// 不需要等流的下一个 tick，断言更稳。
function makeFakeChild() {
  const child = new EventEmitter()
  const written = []
  let onKill = null
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { on() {}, end(payload) { written.push(payload) } }
  child.written = written
  child.killed = false
  child.kill = () => { child.killed = true; if (onKill) onKill() }
  child.whenKilled = (fn) => { onKill = fn }
  return child
}

const BASE_REQ = { command: 'Write-Output hi', timeoutMs: 5000, stdoutMaxBytes: 1024, cwd: 'D:\\ws' }

describe('judgeShellDialect（探针输出 → 方言判定）', () => {
  it('exit 0 且回显哨兵 → pwsh', () => {
    expect(judgeShellDialect({ exitCode: 0, stdout: { text: SHELL_PROBE_SENTINEL + '\n' } })).toBe('pwsh')
  })

  it('哨兵混在多余输出中（宿主 profile 噪声）仍判 pwsh', () => {
    expect(judgeShellDialect({ exitCode: 0, stdout: { text: 'warn: profile noise\n' + SHELL_PROBE_SENTINEL } })).toBe('pwsh')
  })

  it('非零退出（bash command-not-found 即 127）→ bash', () => {
    expect(judgeShellDialect({ exitCode: 127, stdout: { text: '' } })).toBe('bash')
  })

  it('exit 0 但输出为空/无哨兵 → bash（拿不到证据不认 pwsh）', () => {
    expect(judgeShellDialect({ exitCode: 0, stdout: { text: '' } })).toBe('bash')
    expect(judgeShellDialect({ exitCode: 0, stdout: { text: 'some other output' } })).toBe('bash')
    expect(judgeShellDialect({ exitCode: 0 })).toBe('bash')
  })

  it('探测 reject 折成的 null/undefined → bash', () => {
    expect(judgeShellDialect(null)).toBe('bash')
    expect(judgeShellDialect(undefined)).toBe('bash')
  })

  it('探针命令是 pwsh 语法（Write-Output + 哨兵，bash 下必 127）', () => {
    expect(SHELL_PROBE_COMMAND).toBe('Write-Output ' + SHELL_PROBE_SENTINEL)
    expect(SHELL_PROBE_SENTINEL).toMatch(/^[A-Za-z0-9_]+$/)
  })
})

describe('collectStdout（截断收集）', () => {
  it('单块未超预算 → 全文、truncated false', () => {
    expect(collectStdout([Buffer.from('abc')], 10)).toEqual({ text: 'abc', truncated: false })
  })

  it('多块拼接（含多字节 UTF-8）', () => {
    const chunks = [Buffer.from('中'), Buffer.from('文\n')]
    expect(collectStdout(chunks, 100)).toEqual({ text: '中文\n', truncated: false })
  })

  it('恰等阈值不算截断（边界）', () => {
    expect(collectStdout([Buffer.from('12345')], 5)).toEqual({ text: '12345', truncated: false })
  })

  it('超阈值 → 保留尾部并置 truncated', () => {
    expect(collectStdout([Buffer.from('12345678')], 5)).toEqual({ text: '45678', truncated: true })
  })

  it('跨块的尾部保留（头部整块被丢掉）', () => {
    expect(collectStdout([Buffer.from('aaaa'), Buffer.from('bbbb'), Buffer.from('cc')], 6)).toEqual({ text: 'bbbbcc', truncated: true })
  })

  it('空输入 → 空文本、未截断', () => {
    expect(collectStdout([], 5)).toEqual({ text: '', truncated: false })
  })
})

describe('scrubChildEnv（官方 env 清洗 + overrides 复刻）', () => {
  it('剥凭证形状名与 DSH_*（大小写均不敏感），保留 PATH', () => {
    const env = scrubChildEnv({
      PATH: 'C:\\bin',
      DEEPSEEK_API_KEY: 'sk-x',
      my_password: 'p',
      SessionToken: 't',
      dsh_home: 'C:\\Users\\u\\.dsh',
      DSH_SESSION_ID: 's1',
      SystemRoot: 'C:\\Windows',
    })
    expect(env.PATH).toBe('C:\\bin')
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.my_password).toBeUndefined()
    expect(env.SessionToken).toBeUndefined()
    expect(env.dsh_home).toBeUndefined()
    expect(env.DSH_SESSION_ID).toBeUndefined()
  })

  it('叠加 NO_COLOR/PAGER/GIT_PAGER（与官方 ENV_OVERRIDES 同值）', () => {
    const env = scrubChildEnv({})
    expect(env.NO_COLOR).toBe('1')
    expect(env.PAGER).toBe('cat')
    expect(env.GIT_PAGER).toBe('cat')
  })

  it('undefined 值不落进子进程 env（Node env 允许存在但值为 undefined 的键）', () => {
    expect(scrubChildEnv({ FOO: undefined }).FOO).toBeUndefined()
  })
})

describe('directPwshPath（PS 5.1 内置路径）', () => {
  it('随 SystemRoot 解析（不赌 PS7 存在）', () => {
    expect(directPwshPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('SystemRoot 缺失时回退 windir / C:\\Windows', () => {
    expect(directPwshPath({ windir: 'E:\\W' })).toBe('E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(directPwshPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })
})

describe('runViaSpawn（直连通道：假 child 覆盖四项语义）', () => {
  it('argv/cwd/env 形态：单 argv 命令 + windowsHide + 清洗后的 env', async () => {
    const calls = []
    let child = null
    const spawn = (exe, argv, options) => { calls.push({ exe, argv, options }); child = makeFakeChild(); return child }
    const p = runViaSpawn(spawn, BASE_REQ)
    child.stdout.emit('data', Buffer.from('done\n'))
    child.emit('close', 0)
    const res = await p

    expect(res).toEqual({ text: 'done\n', truncated: false, exitCode: 0, stderr: '', timedOut: false })
    expect(calls.length).toBe(1)
    expect(calls[0].exe).toBe(directPwshPath(process.env))
    expect(calls[0].argv).toEqual(['-NoProfile', '-NonInteractive', '-Command', BASE_REQ.command])
    expect(calls[0].options.cwd).toBe('D:\\ws')
    expect(calls[0].options.windowsHide).toBe(true)
    expect(calls[0].options.env.NO_COLOR).toBe('1')
  })

  it('stdin 字节透传：中文与 CRLF 逐字节保真（I27 字节流语义）', async () => {
    let child = null
    const spawn = () => (child = makeFakeChild())
    const body = '{"name":"中文","note":"a\\r\\nb"}\r\n'
    const p = runViaSpawn(spawn, { ...BASE_REQ, stdin: body })
    child.emit('close', 0)
    await p

    expect(child.written.length).toBe(1)
    expect(Buffer.isBuffer(child.written[0])).toBe(true)
    expect(child.written[0].equals(Buffer.from(body, 'utf8'))).toBe(true)
  })

  it('未给 stdin 也显式关闭（EOF，不让子进程挂在等待输入上）', async () => {
    let child = null
    const spawn = () => (child = makeFakeChild())
    const p = runViaSpawn(spawn, BASE_REQ)
    child.emit('close', 0)
    await p
    expect(child.written[0].length).toBe(0)
  })

  it('stdout 超预算 → 保留尾部并置 truncated', async () => {
    let child = null
    const spawn = () => (child = makeFakeChild())
    const p = runViaSpawn(spawn, { ...BASE_REQ, stdoutMaxBytes: 4 })
    child.stdout.emit('data', Buffer.from('abcdefgh'))
    child.stdout.emit('data', Buffer.from('ij'))
    child.emit('close', 0)
    const res = await p
    expect(res.truncated).toBe(true)
    expect(res.text).toBe('ghij')
  })

  it('stderr 单独收集（错误消息来源），非零退出原样回传', async () => {
    let child = null
    const spawn = () => (child = makeFakeChild())
    const p = runViaSpawn(spawn, BASE_REQ)
    child.stderr.emit('data', Buffer.from('fatal: not a git repository'))
    child.emit('close', 128)
    const res = await p
    expect(res.exitCode).toBe(128)
    expect(res.stderr).toBe('fatal: not a git repository')
  })

  it('超时 → kill 子进程并置 timedOut（close 后才收口）', async () => {
    let child = null
    const spawn = () => { child = makeFakeChild(); child.whenKilled(() => child.emit('close', null)); return child }
    const res = await runViaSpawn(spawn, { ...BASE_REQ, timeoutMs: 10 })
    expect(child.killed).toBe(true)
    expect(res.timedOut).toBe(true)
    expect(res.exitCode).toBe(null)
  })

  it('超时前正常退出 → 不 kill、timedOut false（计时器不误伤已完成命令）', async () => {
    let child = null
    const spawn = () => (child = makeFakeChild())
    const p = runViaSpawn(spawn, { ...BASE_REQ, timeoutMs: 5000 })
    child.emit('close', 0)
    await p
    await new Promise((r) => setTimeout(r, 20))
    expect(child.killed).toBe(false)
  })

  it('spawn error（可执行文件缺失）→ reject', async () => {
    let child = null
    const spawn = () => (child = makeFakeChild())
    const p = runViaSpawn(spawn, BASE_REQ)
    child.emit('error', new Error('spawn ENOENT'))
    await expect(p).rejects.toThrow('ENOENT')
  })
})

// ---- createRuntime 分流接线（win32 语义在 ubuntu CI 上的等价覆盖）----

const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

// 官方通道假实现：run 的返回值按「是不是探针命令」分派——探针给 bash 或 pwsh
// 的方言证据，其余命令给普通成功结果。run 调用次数是分流行为的观测量。
function makeCtx(dialect, { probeDelayMs = 0 } = {}) {
  const runCalls = []
  const shell = {
    resolve: (spec) => spec,
    run: async (spec) => {
      runCalls.push(spec.command)
      if (probeDelayMs) await new Promise((r) => setTimeout(r, probeDelayMs))
      if (spec.command === SHELL_PROBE_COMMAND) {
        return dialect === 'pwsh'
          ? { exitCode: 0, stdout: { text: SHELL_PROBE_SENTINEL + '\n' }, stderr: { text: '' } }
          : { exitCode: 127, stdout: { text: '' }, stderr: { text: 'bash: Write-Output: command not found' } }
      }
      return { exitCode: 0, stdout: { text: 'OFFICIAL' }, stderr: { text: '' } }
    },
  }
  return { ctx: { shell, sessions: { list: () => [] }, get: () => null }, runCalls }
}

// 自驱动的假 spawn：data/close 在 setImmediate 里派发，测试只需 await 结果
function makeSpawnRecorder() {
  const calls = []
  const spawn = (exe, argv, options) => {
    const child = makeFakeChild()
    calls.push({ exe, argv, options })
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('DIRECT'))
      child.emit('close', 0)
    })
    return child
  }
  return { spawn, calls }
}

describe('createRuntime 方言分流（win32；默认路径零触达 spawn）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    if (REAL_PLATFORM) Object.defineProperty(process, 'platform', REAL_PLATFORM)
  })

  it('pwsh 方言：走官方通道，spawn 一次都不被调用', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setPlatform('win32')
    const { ctx, runCalls } = makeCtx('pwsh')
    const { spawn, calls } = makeSpawnRecorder()
    const rt = createRuntime(ctx, { baseExcludes: [] }, { spawn })

    expect(await rt.runShell('echo hi')).toBe('OFFICIAL')
    expect(rt.state.shellDialect).toBe('pwsh')
    expect(calls.length).toBe(0)
    expect(runCalls.length).toBe(2) // 探针 1 次 + 命令 1 次
  })

  it('bash 方言：命令走直连通道，官方通道只跑过探针那一次', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setPlatform('win32')
    const { ctx, runCalls } = makeCtx('bash')
    const { spawn, calls } = makeSpawnRecorder()
    const rt = createRuntime(ctx, { baseExcludes: [] }, { spawn })

    expect(await rt.runShell('echo hi')).toBe('DIRECT')
    expect(rt.state.shellDialect).toBe('bash')
    expect(runCalls.length).toBe(1)
    expect(runCalls[0]).toBe(SHELL_PROBE_COMMAND)
    expect(calls.length).toBe(1)
    // 直连命令仍带 UTF-8 前导（与官方通道一致），且探针不带
    expect(calls[0].argv[3].indexOf('$OutputEncoding')).toBe(0)
  })

  it('探针 in-flight 去重：并发首调只跑一次探针', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setPlatform('win32')
    const { ctx, runCalls } = makeCtx('bash', { probeDelayMs: 20 })
    const { spawn, calls } = makeSpawnRecorder()
    const rt = createRuntime(ctx, { baseExcludes: [] }, { spawn })

    const [a, b] = await Promise.all([rt.runShell('echo a'), rt.runShell('echo b')])
    expect([a, b]).toEqual(['DIRECT', 'DIRECT'])
    expect(runCalls.length).toBe(1) // 只有探针，两条命令都被分流到直连
    expect(calls.length).toBe(2)
  })

  it('POSIX：不探测、不进直连（bash 模板与 bash 执行器天然一致）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setPlatform('linux')
    const { ctx, runCalls } = makeCtx('bash')
    const { spawn, calls } = makeSpawnRecorder()
    const rt = createRuntime(ctx, { baseExcludes: [] }, { spawn })

    expect(await rt.runShell('echo hi')).toBe('OFFICIAL')
    expect(rt.state.shellDialect).toBe(null)
    expect(calls.length).toBe(0)
    expect(runCalls.length).toBe(1) // 无探针，只有命令本身
  })

  it('清扫脚本（RECALL_CLEANUP 哨兵）不触发探针：判定责任留给真实命令', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setPlatform('win32')
    const { ctx, runCalls } = makeCtx('bash')
    const { spawn, calls } = makeSpawnRecorder()
    const rt = createRuntime(ctx, { baseExcludes: [] }, { spawn })

    const out = await rt.runShell("# RECALL_CLEANUP\ng='/store/git/.git'", { timeoutMs: 60000, stdoutMaxBytes: 4096 })
    expect(out).toBe('OFFICIAL')
    expect(runCalls.length).toBe(1) // 只有清扫命令本身，没有探针
    expect(calls.length).toBe(0)
    expect(rt.state.shellDialect).toBe(null) // 未判定：不把善后路径的结论钉成缓存
  })

  it('直连通道失败仍走失败清扫并抛错（错误形态与官方通道一致）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setPlatform('win32')
    const { ctx } = makeCtx('bash')
    const spawn = () => {
      const child = makeFakeChild()
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from('fatal: something broke'))
        child.emit('close', 128)
      })
      return child
    }
    const rt = createRuntime(ctx, { baseExcludes: [] }, { spawn })
    // 带 $g 字面量的命令才会触发清扫（extractGitDir 约定）
    const cmd = "& $git --git-dir=$g status\ng = '/store/git/.git'"
    await expect(rt.runShell(cmd)).rejects.toThrow('fatal: something broke')
  })
})