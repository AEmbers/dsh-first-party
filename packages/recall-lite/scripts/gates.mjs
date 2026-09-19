/**
 * gates.mjs — 不依赖 DSH 运行时的合同一致性门禁
 *
 * 为什么需要它：`verify:host` 会真正 import lib/index.js，而本包的
 * @deepseek-ai/* 全部是 peerDependencies（由 DSH 宿主在运行时提供），
 * 脱离宿主环境必然 ERR_MODULE_NOT_FOUND。那些检查留给宿主内冒烟，
 * 这里只钉**纯静态、可在任何环境复现**的合同项——它们恰是「插件装上却
 * 不加载 / UI 不出现 / 配置卡片关联不上」的常见根因。
 *
 * 用法：node scripts/gates.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

const results = []
function check(name, fn) {
  try {
    const detail = fn()
    results.push({ ok: true, name, detail: detail || '' })
  } catch (error) {
    results.push({ ok: false, name, detail: String(error && error.message ? error.message : error) })
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

const pkg = JSON.parse(read('package.json'))
const pkgName = pkg.name

// ---- 1. 包名四处一致（DSH 合同：patch / client 注册 id 都必须等于包名）----
check('patch 的 insert.name 等于包名', () => {
  const yml = read('cordis.patch.yml')
  const m = yml.match(/name:\s*'([^']+)'/) || yml.match(/name:\s*"([^"]+)"/)
  assert(m, 'patch 中未找到 name 字段')
  assert(m[1] === pkgName, `patch name="${m[1]}" ≠ 包名 "${pkgName}"`)
  return m[1]
})

check('client ModuleLoader id 等于包名', () => {
  const entry = read('src/client/entry.ts')
  assert(entry.includes(`id: '${pkgName}'`), `src/client/entry.ts 的 id 不等于 "${pkgName}"`)
  assert(entry.includes(`name: '${pkgName}'`), `src/client/entry.ts 的 name 不等于 "${pkgName}"`)
  return pkgName
})

check('插件管理页配置卡 key 等于包名', () => {
  const app = read('src/client/app.ts')
  assert(
    app.includes(`key: '${pkgName}'`),
    `src/client/app.ts 的 plugins.bundle.config key 不等于 "${pkgName}"（配置卡片会关联不上）`
  )
  return pkgName
})

// ---- 2. exports / files 指向真实存在 ----
check('exports 指向的产物都存在', () => {
  const seen = []
  for (const [k, v] of Object.entries(pkg.exports || {})) {
    const rel = typeof v === 'string' ? v : v && v.default
    if (!rel) continue
    assert(exists(rel), `exports["${k}"] → ${rel} 不存在`)
    seen.push(k)
  }
  return seen.join(' ')
})

check('dsh.bundle.patch 指向的文件存在', () => {
  const p = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  assert(p, 'dsh.bundle.patch 未声明')
  assert(exists(p), `${p} 不存在`)
  return p
})

// ---- 3. host 产物导出面 ----
check('lib/index.js 导出 name/inject/apply/Config', () => {
  const js = read('lib/index.js')
  for (const sym of ['name', 'inject', 'apply', 'Config']) {
    assert(new RegExp(`\\b${sym}\\b`).test(js), `lib/index.js 缺少 ${sym}`)
  }
  const m = js.match(/const name = "([^"]+)"/)
  assert(m && m[1] === pkgName, `lib/index.js 的 name 常量 ≠ "${pkgName}"`)
  return m[1]
})

// ---- 4. client 产物是 loader 注册格式，且不含被打进来的 react ----
check('lib/client.js 是 __ModuleLoader__ 注册格式', () => {
  const js = read('lib/client.js')
  assert(js.includes('__ModuleLoader__'), 'lib/client.js 未注册到 __ModuleLoader__')
  assert(js.includes(`"${pkgName}"`), `lib/client.js 未包含包名字面量 "${pkgName}"`)
  return `${(js.length / 1024).toFixed(1)}kb`
})

check('client 产物未把 react 打进来（必须 external）', () => {
  const js = read('lib/client.js')
  // 打包进 react 的典型特征：react 的 internals 标记串
  const leaked = ['react-dom.production.min.js', '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED', 'ReactCurrentDispatcher']
    .filter((k) => js.includes(k))
  assert(leaked.length === 0, `疑似 react 被打进产物：${leaked.join(', ')}`)
  return 'external ok'
})

// ---- 5. 本 fork 的核心改动确实在产物里 ----
check('产物含 warmup 分派且默认 lazy', () => {
  const js = read('lib/index.js')
  assert(js.includes('cfg.warmup === "startup"'), 'lib/index.js 缺少 warmup 分派（改造未进产物？）')
  const cfg = read('lib/config.js')
  assert(cfg.includes('warmup: "lazy"'), 'lib/config.js 的 DEFAULTS 默认值不是 "lazy"')
  return "default='lazy'"
})

// ---- 6. 无残留上游包名（改名漏改会让宿主认不出插件）----
check('全仓无残留上游包名', () => {
  const OLD = 'dsh-recall-' + 'plugin' // 拼接，避免本文件自身触发
  const hits = []
  // 只扫参与运行时行为的目录。文档（README / patch 注释 / package.json 描述）
  // 里出现上游包名是**合法且必要**的——那里在说明「本包替代谁」与「怎么回退」，
  // 抹掉反而让用户失去参照。真正致命的是代码里的漏改：宿主据此认插件。
  const DIRS = ['src', 'scripts', 'tests']
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'lib') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx|js|mjs|json|yml|md)$/.test(e.name)) continue
      if (fs.readFileSync(p, 'utf8').includes(OLD)) hits.push(path.relative(ROOT, p))
    }
  }
  for (const d of DIRS) if (exists(d)) walk(path.join(ROOT, d))
  assert(hits.length === 0, `残留于：${hits.join(', ')}`)
  return 'clean'
})

// ---- 输出 ----
const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log('\nrecall-lite 合同门禁\n' + '─'.repeat(64))
for (const r of results) {
  console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? '   → ' + r.detail : ''}`)
}
console.log('─'.repeat(64))
console.log(`${pass} 项通过${fail ? `，${fail} 项失败` : ''}\n`)
process.exit(fail ? 1 : 0)
