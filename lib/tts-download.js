/**
 * lib/tts-download.js — 本地 TTS 模型按需下载（目录里只放“用户点过的模型”）。
 *
 * 只用系统 curl：它在 macOS/Windows 10+ 自带，天然支持断点续传、重定向和
 * HTTP(S) 代理；我们不把几百 MB 的模型塞进插件包，也不要求用户装 Python。
 *
 * 下载源：有 7897/7890 代理时直连 huggingface.co；否则走 hf-mirror.com。
 * 每个文件先写 <name>.part，下载完成后原子改名；取消后 .part 保留，
 * 下次点下载会从断点继续。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import net from 'node:net'
import {
  MODEL_CATALOG, MODEL_META_FILE, catalogModel, formatModelSize,
  forgetModel, installedModels, modelsRoot,
} from './local-tts.js'

const PROXY_PORTS = [7897, 7890]
const DOWNLOAD_HEADERS = ['-H', 'User-Agent: dsh-music-player/1.0']

let job = null
let activeChild = null
let cancelled = false
let proxyPromise = null

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => { try { socket.destroy() } catch { /* ignore */ } resolve(ok) }
    socket.setTimeout(700)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function detectProxy() {
  if (proxyPromise !== null) return proxyPromise
  proxyPromise = (async () => {
    for (const port of PROXY_PORTS) {
      if (await canConnect(port)) return `http://127.0.0.1:${port}`
    }
    return ''
  })()
  return proxyPromise
}

function publicJob() {
  if (job === null) return null
  return { ...job }
}

export function downloadState() { return publicJob() }
export function isDownloading() { return job !== null && job.state === 'downloading' }

function sizeOf(path) {
  try { return statSync(path).size } catch { return 0 }
}

function baseUrlFor(proxy) {
  return proxy === '' ? 'https://hf-mirror.com' : 'https://huggingface.co'
}

function fileUrl(base, repo, path) {
  return base + '/' + repo + '/resolve/main/' + path.split('/').map(encodeURIComponent).join('/')
}

function runCurl(args) {
  return new Promise((resolve) => {
    let stderr = ''
    let child
    try { child = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] }) } catch (err) { resolve({ code: -1, stderr: String(err) }); return }
    activeChild = child
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000) })
    child.on('error', (err) => { activeChild = null; resolve({ code: -1, stderr: String(err) }) })
    child.on('close', (code) => { activeChild = null; resolve({ code, stderr }) })
  })
}

function updateProgress(received, total, file, index) {
  if (job === null) return
  job.received = Math.max(0, received)
  job.total = Math.max(job.received, total || 0)
  job.percent = job.total > 0 ? Math.min(99, Math.round((job.received / job.total) * 100)) : 0
  if (file !== undefined) job.file = file
  if (index !== undefined) job.fileIndex = index
}

function writeMeta(dir, model) {
  const meta = {
    id: model.id, name: model.name, engine: model.engine, speakers: model.speakers,
    language: model.language, gender: model.gender, repo: model.repo,
    downloadedAt: new Date().toISOString(),
  }
  writeFileSync(join(dir, MODEL_META_FILE), JSON.stringify(meta, null, 2) + '\n')
}

async function downloadOne(model, dir, item, proxy, base, progressBase, totalBytes, index) {
  const finalPath = join(dir, item.as || item.path)
  const partPath = finalPath + '.part'
  mkdirSync(dirname(finalPath), { recursive: true })

  // 完整文件直接跳过；有 .part 才走续传。下载器先写 .part 再原子改名，
  // 所以“只有最终文件”就意味着上次已经下完。
  if (existsSync(finalPath) && !existsSync(partPath)) {
    const n = sizeOf(finalPath)
    updateProgress(progressBase + n, totalBytes, item.path, index)
    return n
  }

  const url = item.url || fileUrl(base, model.repo, item.path)
  const args = ['-L', '--fail', '--silent', '--show-error', '--connect-timeout', '20',
    '--retry', '2', '--retry-delay', '2', '-C', '-', '-o', partPath, ...DOWNLOAD_HEADERS]
  if (proxy !== '') args.push('-x', proxy)
  args.push(url)

  const resultPromise = runCurl(args)
  // 不先做 HEAD（一串 HEAD 会让用户点下载后十几秒都停在 0%）；直接下，
  // 进度按模型标称体积估算，完成后统一置 100%。
  const poll = setInterval(() => {
    updateProgress(progressBase + sizeOf(partPath), totalBytes, item.path, index)
  }, 500)
  const result = await resultPromise
  clearInterval(poll)
  if (cancelled) throw new Error('已取消')
  if (result.code !== 0) {
    throw new Error((result.stderr || ('curl exit ' + result.code)).trim().slice(0, 300))
  }
  const got = sizeOf(partPath)
  if (got === 0) throw new Error(item.path + ' 下载为空')
  renameSync(partPath, finalPath)
  updateProgress(progressBase + got, totalBytes, item.path, index)
  return got
}

async function runDownload(model) {
  const dir = join(modelsRoot(), model.id)
  mkdirSync(dir, { recursive: true })
  const proxy = await detectProxy()
  const base = baseUrlFor(proxy)
  const files = Array.isArray(model.files) ? model.files : []
  if (files.length === 0) throw new Error('模型没有下载清单')

  const totalBytes = model.sizeBytes || 0
  updateProgress(0, totalBytes)
  let done = 0
  for (let i = 0; i < files.length; i++) {
    if (cancelled) throw new Error('已取消')
    const item = files[i]
    updateProgress(done, totalBytes, item.path, i)
    const got = await downloadOne(model, dir, item, proxy, base, done, totalBytes, i + 1)
    done += got
  }
  writeMeta(dir, model)
  forgetModel(model.id)
  if (job !== null) {
    job.received = job.total = Math.max(done, totalBytes)
    job.percent = 100
    job.file = ''
    job.state = 'done'
    job.finishedAt = Date.now()
  }
}

export function startDownload(id) {
  const model = catalogModel(id)
  if (!model) return { ok: false, error: '未知模型：' + id }
  if (isDownloading()) return { ok: false, error: '已有模型正在下载，请等它完成' }
  if (installedModels().some((m) => m.key === id)) {
    const installed = installedModels().find((m) => m.key === id)
    return { ok: true, already: true, job: { id, name: model.name, state: 'done', percent: 100, sizeLabel: formatModelSize(installed.sizeBytes || model.sizeBytes) } }
  }
  cancelled = false
  job = {
    id, name: model.name, state: 'downloading', file: '', fileIndex: 0,
    fileCount: model.files.length, received: 0, total: model.sizeBytes || 0, percent: 0,
    sizeLabel: formatModelSize(model.sizeBytes), error: '', startedAt: Date.now(), finishedAt: 0,
  }
  runDownload(model).catch((err) => {
    if (job !== null) {
      job.state = cancelled ? 'cancelled' : 'error'
      job.error = cancelled ? '' : String((err && err.message) || err)
      job.finishedAt = Date.now()
    }
  })
  return { ok: true, job: publicJob() }
}

export function cancelDownload() {
  if (!isDownloading()) return { ok: false, error: '当前没有下载任务' }
  cancelled = true
  if (activeChild !== null) {
    try { activeChild.kill('SIGTERM') } catch { /* ignore */ }
  }
  if (job !== null) {
    job.state = 'cancelled'
    job.finishedAt = Date.now()
  }
  return { ok: true, job: publicJob() }
}

export function deleteModel(id) {
  const hit = installedModels().find((m) => m.key === id)
  if (!hit) return { ok: false, error: '这不是已安装的模型：' + id }
  if (isDownloading() && job.id === id) cancelDownload()
  try {
    rmSync(hit.dir, { recursive: true, force: true })
    forgetModel(id)
    if (job !== null && job.id === id) job = null
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

export function catalogWithState() {
  const installed = installedModels()
  const installedByKey = new Map(installed.map((m) => [m.key, m]))
  const catalogIds = new Set(MODEL_CATALOG.map((m) => m.id))
  const models = MODEL_CATALOG.map((m) => {
    const { files, ...pub } = m
    return {
      ...pub,
      sizeLabel: formatModelSize(m.sizeBytes),
      installed: installedByKey.has(m.id),
      custom: false,
    }
  })
  for (const m of installed) {
    if (catalogIds.has(m.key)) continue
    models.push({
      id: m.key, name: m.name || m.key, engine: m.type, speakers: m.speakers || 0,
      language: m.language || '', gender: m.gender || '', group: 'custom',
      quality: 0, speed: 0, sizeBytes: 0, sizeLabel: '本地导入',
      note: '手动放进模型目录的自定义模型。', installed: true, custom: true,
    })
  }
  return { models, job: publicJob(), root: modelsRoot() }
}
