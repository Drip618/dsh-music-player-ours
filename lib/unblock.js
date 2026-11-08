// [OURS] 网易云「解灰」兜底：灰歌（版权/VIP 受限、官方取链为空）时，从社区项目
// @unblockneteasemusic/server 的其它平台源找同一首歌的可播直链。仅供个人学习/备用，
// 默认关闭，由用户在设置里显式开启。
// 该包是 CommonJS、main 直接导出 match(id, source[], data?)，require 它不会起代理服务器。
//
// 关键：不能「第一个源成功就用」——酷我对 VIP 曲常只给约 12 秒的试听（185KB），而
// bodian/pyncmd 往往能拿到完整曲（9MB+）。这里并发查询全部源，按字节数取最大者，
// 并在结果上标 preview，让上层如实显示「试听」而不是假装完整。
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// 只用国内可直连、无需外部二进制的源；避开 ytdlp/youtube（要梯子+yt-dlp）与 joox（要登录）。
// 顺序只影响「所有源 size 都是 0」时的兜底优先级：完整率高的排前面。
const SOURCES = ['bodian', 'pyncmd', 'kuwo', 'migu', 'kugou', 'qq', 'bilibili']
const PER_SOURCE_TIMEOUT_MS = 12000
// 低于该体积基本是试听片段（128kbps 约 75 秒）；仅用于打「试听」标记，不做过滤。
const PREVIEW_MAX_BYTES = 1200 * 1000

let matchFn = null
let loadFailed = false
function loadMatch() {
  if (matchFn) return matchFn
  if (loadFailed) return null
  try {
    if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'silent' // 压低 pino 噪音（须在 require 前）
    matchFn = require('@unblockneteasemusic/server')
    return matchFn
  } catch {
    loadFailed = true
    return null
  }
}

export function unblockAvailable() { return loadMatch() !== null }

// 直链的 CDN 可能属于与 source 不同的平台（bodian 常回 kuwo CDN），按主机名给 Referer。
export function refererFor(url) {
  try {
    const host = new URL(url).hostname
    if (host.includes('kuwo')) return 'http://www.kuwo.cn/'
    if (host.includes('126.net') || host.includes('music.163')) return 'http://music.163.com/'
    if (host.includes('kugou')) return 'https://www.kugou.com/'
    if (host.includes('migu')) return 'https://music.migu.cn/'
    if (host.includes('bilibili')) return 'https://www.bilibili.com/'
  } catch { /* ignore */ }
  return ''
}

// 从多个源的结果里挑体积最大的（同体积取码率高者）。size 为 0 视为未知，排在有体积之后。
export function pickBestSource(candidates) {
  const ok = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && typeof c.url === 'string' && c.url !== '')
  if (ok.length === 0) return null
  const sorted = ok.slice().sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0) || (Number(b.br) || 0) - (Number(a.br) || 0))
  const best = sorted[0]
  const size = Number(best.size) || 0
  return { ...best, size, preview: size > 0 && size < PREVIEW_MAX_BYTES }
}

function trySource(match, sid, source, meta) {
  return Promise.race([
    match(sid, [source], meta || undefined),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PER_SOURCE_TIMEOUT_MS)),
  ]).then((r) => (r && typeof r.url === 'string' && r.url !== ''
    ? { url: r.url, source: r.source || source, br: Number(r.br) || 0, size: Number(r.size) || 0 }
    : null)).catch(() => null)
}

// 返回 { url, source, br, size, preview, referer } 或 null（所有源都失败）。
// meta 可选：传入网易云歌曲详情可省一次 detail 往返。
export async function unblockNetease(id, meta = null) {
  const match = loadMatch()
  if (!match) return null
  const sid = String(id).trim()
  if (!/^[0-9]+$/.test(sid)) return null
  const candidates = await Promise.all(SOURCES.map((source) => trySource(match, sid, source, meta)))
  const best = pickBestSource(candidates)
  if (!best) return null
  return { ...best, referer: refererFor(best.url) }
}
