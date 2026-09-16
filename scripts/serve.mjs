#!/usr/bin/env node
/**
 * 一键启动：`npm run serve`
 *
 * 依次做三件事，最后交付一个地址：
 *   1) 确保 dist/ 存在、且不比源码旧（缺失或过期就先跑一次 vite build）
 *   2) 载入 server/.env（**存在才载入**；不存在不报错，走内置默认值）
 *   3) 起 Express：**同一个端口**同时托管 dist/ 静态页与 /api 数据接口
 *
 * 与 `npm run server` 的区别：server 只起接口，且硬依赖 server/.env；
 * 本命令面向「克隆下来想立刻看到界面」的场景，把构建和配置都兜住。
 *
 * 两个刻意的设计：
 *   · 不用 `node --env-file=server/.env`。该文件在 .gitignore 里，新克隆的仓库没有它，
 *     而 `--env-file` 遇到不存在的文件会**直接报错退出**——可数据库本来就只是可选依赖
 *     （连不上时前端自动回退内置演示数据），不该因为它起不来。
 *   · 构建走 node_modules 里的 vite，不经过 `npm run build`。这样绕开 prebuild 预检，
 *     且跳过 vue-tsc 类型检查——一键启动只要跑得起来，类型门禁交给 `npm run build`。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')

/* npm run server 走的也是本脚本（带 --skip-build）：只起接口、不碰前端构建，
   但同样不再因 server/.env 缺失而硬崩。 */
const SKIP_BUILD = process.argv.includes('--skip-build')

/* 参与「是否过期」比较的源头。加 .env 是因为 Vite 在**构建时**就把 VITE_* 内联进产物，
   换 Key 后不重建的话，dist 里还是旧 Key。 */
const SOURCES = ['src', 'index.html', 'vite.config.js', 'package.json', '.env']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])

/** 递归取目录树里最新的修改时间；读不到就返回 0（当作不存在） */
function newestMtime(target) {
  let newest = 0
  const walk = (p) => {
    let st
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      let entries
      try {
        entries = readdirSync(p)
      } catch {
        return
      }
      for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue
        walk(join(p, name))
      }
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs
    }
  }
  walk(target)
  return newest
}

/** 载入 .env（KEY=VALUE，# 注释）。优先用 Node 内置实现，老版本回退到手写解析。 */
function loadDotEnv(file) {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file) // Node ≥ 20.12 / 21.7
    return
  }
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

/* ---------- 1) 依赖预检：没装依赖时给中文提示，而不是 'vite' 不是内部或外部命令 ---------- */
function requireDep(probe, name) {
  if (existsSync(join(ROOT, 'node_modules', ...probe))) return true
  console.error(
    `\n[serve] 未安装依赖：找不到 ${name}（node_modules 不存在或不完整）。\n` +
      '        仓库刻意不含 node_modules，首次运行请先安装：\n' +
      '            pnpm install      推荐（与提交的 pnpm-lock.yaml 一致）\n' +
      '            npm install       同样可行\n' +
      '        装好后重新执行本命令。\n'
  )
  process.exit(1)
}
if (!SKIP_BUILD) requireDep(['vite', 'bin', 'vite.js'], 'vite')
requireDep(['express'], 'express')

/* ---------- 2) 密钥提醒：不阻断，但白屏是最容易被误会成「程序坏了」的故障 ---------- */
if (!SKIP_BUILD && !existsSync(join(ROOT, '.env'))) {
  console.warn(
    '\n[serve] 提醒：未检测到根目录 .env —— 构建产物里不会有任何 API Key。\n' +
      '        其中 Mapbox 缺失会导致底图白屏（其余服务会自动降级）。\n' +
      '        要正常看图：cp .env.example .env 并填入自己的 Key 后重跑本命令。\n'
  )
}

/* ---------- 3) dist 是否缺失/过期 ---------- */
let staleReason = ''
if (SKIP_BUILD) {
  // npm run server：只起接口，dist 有没有、新不新都不管
} else if (!existsSync(join(DIST, 'index.html'))) {
  staleReason = 'dist/ 尚未构建'
} else {
  const builtAt = statSync(join(DIST, 'index.html')).mtimeMs
  for (const rel of SOURCES) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) continue
    if (newestMtime(abs) > builtAt) {
      staleReason = `${rel} 比 dist/ 新`
      break
    }
  }
}

if (staleReason) {
  console.log(`\n[serve] ${staleReason} → 先构建前端…\n`)
  const r = spawnSync(process.execPath, [VITE, 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(
      '\n[serve] 前端构建失败，已中止（报错见上方）。\n' +
        '        只想起数据接口、不建前端：npm run server\n'
    )
    process.exit(1)
  }
} else if (!SKIP_BUILD) {
  console.log('[serve] dist/ 已是最新，跳过构建（改了 src/ 后重跑本命令会自动重建）')
}

/* ---------- 4) 载入 server/.env（可选），再起服务端 ---------- */
const SERVER_ENV = join(ROOT, 'server', '.env')
if (existsSync(SERVER_ENV)) {
  try {
    loadDotEnv(SERVER_ENV)
  } catch (e) {
    console.warn(`[serve] server/.env 读取失败，改用内置默认值：${e.message}`)
  }
} else {
  console.warn(
    '[serve] 未检测到 server/.env —— 数据服务端仍会启动，但连不上 SQL Server。\n' +
      '        这不影响看界面：「数据管理」面板会提示原因，全站自动回退内置演示数据。\n' +
      '        要启用真库：执行 db/setup.sql + db/seed.sql，再把账号口令写进 server/.env。'
  )
}

// 服务端自己会打印启动横幅与地址（见 server/index.js），此处不再重复。
await import('../server/index.js')
