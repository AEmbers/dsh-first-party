/**
 * PF-2 运行时探针（tests/probe/，仅本地跑：npm run test:probe）
 *
 * 背景（plan-performance.md PF-2）：writeTextViaShell 的 win32 分支按 base64
 * 20000 字符分块，每块一个 PowerShell 进程——本探针把「stdin 传全文 + 单进程」
 * 的编码前提钉成回归测试。argv 形态与 dsh-pwsh-local 完全一致
 * （-NoLogo -NoProfile -NonInteractive -Command "<preamble>"，stdin 经
 * child.stdin.end(text) 以 UTF-8 字节写入管道，见 dsh-subprocess-local）。
 *
 * 2026-08-29 探针实测结论（plan-performance.md 实施记录同步）：
 * - 形态 A（[Console]::In.ReadToEnd()，原计划字面形态）：PS 5.1 下 Console.In
 *   按输入代码页（中文系统 GBK 936）解码 UTF-8 字节 → 乱码 + 字节数漂移，
 *   探针红；官方 ENCODING_PREAMBLE 与插件 UTF8_PRELUDE 都只设 OutputEncoding，
 *   救不了输入侧。且本机 dsh 的 pwshPath 解析实际落到 powershell.exe 5.1
 *   （WindowsApps 的 pwsh 别名是 appexeclink reparse point，lstatSync 报
 *   ENOENT，candidateExists 判否）——形态 A 在生产口径上必挂，废弃。
 * - 形态 B（[Console]::OpenStandardInput() 循环读原始字节 + UTF8Encoding($false)
 *   解码）：绕开 Console 文本解码层，与代码页无关；PS 5.1 / pwsh 7 双解释器
 *   实测逐字节保真（无 BOM、CRLF 保持、长度一致）→ PF-2 采用形态 B。
 * 验证点（plan-performance.md PF-2 前置探针节）全部归结为「落盘字节 ==
 * 发送字节」的逐字节比对。本文件保留形态 B 作为回归钉；形态 A 不再跑
 * （已知红，跑它只会让套件常红）。
 */

import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 与 dsh-pwsh-local lib/index.js 的 ENCODING_PREAMBLE 逐字一致
const ENC_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

// 与 store.js runShellMeta 的拼接一致：官方 preamble 之后再前置插件侧 UTF8_PRELUDE
const PLUGIN_PRELUDE = '$OutputEncoding = [Text.UTF8Encoding]::new($false)\ntry { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}'

// pwsh 路径解析与 dsh-pwsh-local resolvePwshPath 同序（PS7 优先、5.1 兜底）。
// candidateExists 用 lstatSync+isFile/isSymbolicLink（appexeclink 别名报
// ENOENT 判否）——本机无真身 pwsh.exe 时自然只剩 5.1，与生产口径一致。
function candidateExecutables() {
  const list = [
    { exe: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'), label: 'pwsh7' },
  ]
  for (const dir of (process.env.PATH || '').split(';')) {
    const p = path.join(dir.trim().replace(/^"|"$/g, ''), 'pwsh.exe')
    if (p && !list.some((c) => c.exe === p)) list.push({ exe: p, label: 'pwsh7' })
  }
  list.push({ exe: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), label: 'ps51' })
  return list.filter((c) => fs.existsSync(c.exe))
}

// 测试载荷：覆盖中文（GBK 双字节域）、emoji（4 字节 surrogate）、单引号
// （PS 字面量转义域）、CRLF（行尾篡改检测）、长文（8KB 循环读取多块触发）。
const PAYLOAD = [
  '# dsh-recall PF-2 stdin 探针',
  '中文路径 C:\\用户\\测试\\项目',
  "single 'quoted' string",
  'emoji 🚀🔥✅ 四字节序列',
  'line ending check\r\nnext line',
  'unicode é à ü 中文混排 ｶﾀｶﾅ',
  'tail without newline',
].join('\r\n') + '\r\n' + 'x'.repeat(20000)

function runPwshStdin(exe, script, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ENC_PREAMBLE + PLUGIN_PRELUDE + '\n' + script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    // 与 dsh-subprocess-local 的 child.stdin.end(data) 同构：string 按 UTF-8 编码
    child.stdin.end(stdinText)
    setTimeout(() => { try { child.kill() } catch {} reject(new Error('pwsh stdin probe timeout (120s)')) }, 120000)
  })
}

// 落盘脚本模板（PF-2 采用的形态 B）：OpenStandardInput 读原始字节（与代码页
// 无关）→ UTF8Encoding($false).GetString 解码 → .NET 无 BOM WriteAllText 落盘
// （PS 5.1 的 Set-Content -Encoding utf8 必带 BOM，禁用）。
function writeScript(tmp) {
  const q = "'" + String(tmp).replace(/'/g, "''") + "'"
  return [
    "$ErrorActionPreference = 'Stop'",
    '$tmp = ' + q,
    '$stream = [Console]::OpenStandardInput()',
    '$ms = New-Object System.IO.MemoryStream',
    '$buf = New-Object byte[] 8192',
    'while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) }',
    '$text = [Text.UTF8Encoding]::new($false).GetString($ms.ToArray())',
    "[IO.File]::WriteAllText($tmp, $text, [Text.UTF8Encoding]::new($false))",
    "Write-Output 'STDIN_WRITE_OK'",
  ].join('\n')
}

const isWin = process.platform === 'win32'
const execs = isWin ? candidateExecutables() : []

describe('PF-2 stdin 单进程写盘探针（win32 专属，无 pwsh 环境 skip）', () => {
  for (const { exe, label } of execs) {
    it(`${label}：stdin 全文单进程落盘逐字节保真（无 BOM/无转码/CRLF 保持）`, { timeout: 150000 }, async () => {
      // mkdtemp 生成受控临时目录（路径前缀固定），落盘文件用固定名——
      // 无动态路径片段进入 join，杜绝路径穿越面
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recall-pf2-'))
      const tmp = path.join(dir, 'payload.txt')
      try {
        const { code, stdout, stderr } = await runPwshStdin(exe, writeScript(tmp), PAYLOAD)
        expect(code, 'stderr: ' + stderr.slice(0, 500)).toBe(0)
        expect(stdout).toContain('STDIN_WRITE_OK')
        const written = fs.readFileSync(tmp)
        const sent = Buffer.from(PAYLOAD, 'utf8')
        // BOM 检测（EF BB BF）：Set-Content utf8 的老坑，WriteAllText 无 BOM 重载必须没有
        expect(written[0]).not.toBe(0xef)
        // 全文长度一致 + 逐字节一致（涵盖 GBK 转码与 \r\n 篡改两族失败）
        expect(written.length, `sent ${sent.length}B, got ${written.length}B; head=${written.slice(0, 60).toString('utf8')}`).toBe(sent.length)
        expect(written.equals(sent)).toBe(true)
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
      }
    })
  }

  if (!execs.length) {
    it('非 win32 / 无 PowerShell 环境：整体 skip', () => {
      expect(isWin).toBe(false)
    })
  }
})
