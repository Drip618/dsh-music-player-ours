// [OURS] 番茄小说下载器（Fanqie Novel Downloader.app）本地书库接入。
// 只读该 App 的 rust_state.json 与下载目录，把已下载的 TXT/EPUB 喂进插件既有的
// AI 讲书管线（章节解析/分块/TTS/播放全部复用），不另起播放逻辑、不写该 App 任何文件。
// 数据真源：~/Library/Application Support/com.pofl.fanqienoveldownloader/rust_state.json
//   - preferences.download_preferences.save_dir：下载目录（用户在 App 里可改）
//   - download_jobs[]：已下载任务，含精确 output_path / book_name / author / book_id
//   - official_bookshelf.items[]：云端书架（封面/简介，按 book_id 关联）
//   - reading_progress{book_id}：读到哪章（chapter_title / read_progress）
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import os from 'node:os'

const stateFile = () => join(os.homedir(), 'Library', 'Application Support', 'com.pofl.fanqienoveldownloader', 'rust_state.json')
const BOOK_EXTS = new Set(['.txt', '.epub'])

export function fanqieAvailable() { return existsSync(stateFile()) }

function readState() {
  let text
  try { text = readFileSync(stateFile(), 'utf8') } catch (err) {
    if (err.code === 'ENOENT') return { available: false, state: null }
    return { available: true, state: null, error: '读取番茄书库状态失败：' + (err.code || '未知错误'), status: 500 }
  }
  try {
    const state = JSON.parse(text)
    if (state && typeof state === 'object' && !Array.isArray(state)) return { available: true, state }
  } catch { /* 不回传原文片段，状态文件可能含账号信息。 */ }
  return { available: true, state: null, error: '番茄书库状态格式损坏', status: 500 }
}
function fileSize(p) { try { return statSync(p).size } catch { return 0 } }
function coverUrl(value) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    // 搜索返回的旧 CDN 对匿名请求报 403，同路径在番茄图源可公开读取。
    if (url.hostname === 'p6-tt.bytecdn.cn' && url.pathname.startsWith('/novel-pic/')) {
      url.hostname = 'p6-novel.byteimg.com'
      return url.href
    }
    return value
  } catch { return '' }
}

// 返回 { available, saveDir, books[] }。books 每项含 title/author/path/size/format/
// bookId/coverUrl/description/lastChapter/readProgress/source:'fanqie'。
// 只收「文件确实在盘上」的书：下载任务 done 的精确路径 + 下载目录里额外的 TXT/EPUB。
export function fanqieLibrary() {
  const { state, ...status } = readState()
  if (!state) return { ...status, saveDir: '', books: [] }
  const prefs = (state.preferences && state.preferences.download_preferences) || {}
  const saveDir = typeof prefs.save_dir === 'string' ? prefs.save_dir : ''
  const progress = state.reading_progress || {}
  const shelf = (state.official_bookshelf && Array.isArray(state.official_bookshelf.items)) ? state.official_bookshelf.items : []
  const shelfById = new Map(shelf.map((it) => [String(it.book_id), it]))
  const byPath = new Map()

  for (const job of (Array.isArray(state.download_jobs) ? state.download_jobs : [])) {
    const p = job.output_path || (job.result && job.result.output_path) || ''
    if (!p || !BOOK_EXTS.has(extname(p).toLowerCase()) || !existsSync(p)) continue
    const bookId = String(job.book_id || '')
    const meta = shelfById.get(bookId) || {}
    const prog = progress[bookId] || null
    byPath.set(p, {
      title: job.book_name || meta.title || basename(p, extname(p)),
      author: job.author || meta.author || '',
      path: p, size: fileSize(p), format: extname(p).slice(1).toLowerCase(),
      bookId, coverUrl: coverUrl(meta.cover_url), description: meta.description || '',
      lastChapter: prog ? (prog.chapter_title || '') : '',
      readProgress: prog ? (Number(prog.read_progress) || 0) : 0,
      source: 'fanqie',
    })
  }

  if (saveDir && existsSync(saveDir)) {
    let entries = []
    try { entries = readdirSync(saveDir) } catch { /* ignore */ }
    for (const name of entries) {
      const ext = extname(name).toLowerCase()
      if (!BOOK_EXTS.has(ext)) continue
      const p = join(saveDir, name)
      if (byPath.has(p)) continue
      let st
      try { st = statSync(p) } catch { continue }
      if (!st.isFile()) continue
      const stem = basename(name, extname(name))
      const m = stem.match(/^(.*?)\s+-\s+(.*)$/) // 文件名模板 "{title} - {author}"
      byPath.set(p, {
        title: m ? m[1] : stem, author: m ? m[2] : '',
        path: p, size: st.size, format: ext.slice(1),
        bookId: '', coverUrl: '', description: '', lastChapter: '', readProgress: 0,
        source: 'fanqie',
      })
    }
  }

  const books = [...byPath.values()].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
  return { available: true, saveDir, books }
}

// 番茄全站搜书（公开 web 搜索接口，无需登录/签名，仅要浏览器 UA）。返回书籍元数据
// （book_id/书名/作者/封面/分类/评分/连载状态/简介），不含加密正文——正文仍走番茄 App
// 下载。offset 翻页：首页 0，下一页用上一次返回的 offset；hasMore 控制「加载更多」。
const FQ_SEARCH_URL = 'https://novel.snssdk.com/api/novel/channel/homepage/search/search/v1/'
const FQ_SEARCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
export async function fanqieSearch(query, offset = 0) {
  const q = typeof query === 'string' ? query.trim() : ''
  const fail = (error, status = 502, off = 0) => ({ ok: false, status, error, results: [], hasMore: false, offset: off })
  if (!q) return fail('关键词不能为空', 400)
  if (q.length > 200) return fail('关键词不能超过 200 字', 400)
  const off = integerOffset(offset)
  if (off === null || off < 0 || off > 100000) return fail('offset 必须是 0..100000 的整数', 400)
  const url = FQ_SEARCH_URL + '?aid=1967&q=' + encodeURIComponent(q) + '&offset=' + off + '&count=20'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  let raw
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': FQ_SEARCH_UA, 'Accept': 'application/json' }, signal: ctrl.signal })
    if (!resp.ok) return fail('搜索接口 HTTP ' + resp.status, 502, off)
    raw = await resp.json()
  } catch (err) {
    return fail((err && err.name === 'AbortError') ? '搜索超时' : '搜索请求失败：' + String((err && err.message) || err), 502, off)
  } finally { clearTimeout(timer) }
  if (!raw || raw.code !== 0 || !raw.data || !Array.isArray(raw.data.ret_data)) {
    return fail('搜索失败' + (raw && raw.message ? '：' + raw.message : '：上游响应格式错误'), 502, off)
  }
  const data = raw.data
  const results = []
  const seen = new Set()
  for (const r of data.ret_data) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    // 不把 number 转回字符串：长 ID 在 JSON.parse 时可能已经丢失精度。
    const bookId = r.book_id
    if (typeof bookId !== 'string' || !/^\d+$/.test(bookId) || seen.has(bookId)) continue
    if (typeof r.title !== 'string' || !r.title.trim()) continue
    seen.add(bookId)
    results.push({
      bookId,
      title: r.title,
      author: typeof r.author === 'string' ? r.author : '',
      coverUrl: coverUrl(r.thumb_url),
      description: typeof r.abstract === 'string' ? r.abstract : '',
      category: typeof r.category === 'string' ? r.category : '',
      score: typeof r.score === 'string' ? r.score : (typeof r.score === 'number' && Number.isFinite(r.score) ? String(r.score) : ''),
      status: bookStatus(r.creation_status),
      addCount: typeof r.add_bookshelf_count === 'string' ? r.add_bookshelf_count : '',
      pageUrl: 'https://fanqienovel.com/page/' + bookId,
    })
  }
  const next = integerOffset(data.offset)
  const advances = next !== null && next > 0 && next > off
  return { ok: true, results, hasMore: !!data.has_more && advances, offset: advances ? next : off, searchId: data.search_id || '' }
}

function integerOffset(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

// 只解释已知数字码和中文标签；4 与未知状态不推断为完结。
function bookStatus(value) {
  if (value === '连载中' || value === '1' || value === 1) return '连载中'
  if (value === '已完结' || value === '0' || value === 0) return '已完结'
  return '状态未知'
}

// 返回整份番茄官方书架（不只是已下载的），供插件「番茄书架」页浏览/搜索。
// 数据全在本地 rust_state.json，不联网、不写 App 任何文件。
// { available, loggedIn, saveDir, groups[], total, downloadedCount, books[] }
// books 每项：bookId/title/author/coverUrl/description/group/status/chapterCount/
//   readChapterTitle/bookProgress(0..1)/lastReadAt/addShelfTime/downloaded/localPath。
export function fanqieShelf() {
  const { state, ...status } = readState()
  if (!state) {
    return { ...status, loggedIn: false, saveDir: '', groups: [], total: 0, downloadedCount: 0, lastRefreshedAt: null, books: [] }
  }
  const bs = state.official_bookshelf || {}
  const items = Array.isArray(bs.items) ? bs.items : []
  const groups = Array.isArray(bs.groups) ? bs.groups.filter((g) => typeof g === 'string' && g !== '') : []
  const prefs = (state.preferences && state.preferences.download_preferences) || {}
  const saveDir = typeof prefs.save_dir === 'string' ? prefs.save_dir : ''
  const loggedIn = !!(state.account && state.account.status === 'logged_in')
  const progress = state.reading_progress || {}

  // 已下载：download_jobs done 且文件在盘上，按 book_id 关联到书架条目。
  const dlByBookId = new Map()
  for (const job of (Array.isArray(state.download_jobs) ? state.download_jobs : [])) {
    if (job.status !== 'done') continue
    const p = job.output_path || (job.result && job.result.output_path) || ''
    if (!p || !BOOK_EXTS.has(extname(p).toLowerCase()) || !existsSync(p)) continue
    dlByBookId.set(String(job.book_id || ''), p)
  }

  const books = []
  let downloadedCount = 0
  for (const it of items) {
    const bookId = String(it.book_id || '')
    if (!bookId) continue
    const chapterCount = Number(it.chapter_count) || 0
    const order = Number(it.official_chapter_order) || 0
    const localProg = progress[bookId] || null
    const localPath = dlByBookId.get(bookId) || null
    if (localPath) downloadedCount++
    books.push({
      bookId,
      title: typeof it.title === 'string' ? it.title : '',
      author: typeof it.author === 'string' ? it.author : '',
      coverUrl: coverUrl(it.cover_url),
      description: typeof it.description === 'string' ? it.description : '',
      group: typeof it.group_name === 'string' ? it.group_name : '',
      status: bookStatus(it.status),
      chapterCount,
      readChapterTitle: it.official_chapter_title || (localProg && localProg.chapter_title) || '',
      bookProgress: chapterCount > 0 ? Math.min(1, Math.max(0, order / chapterCount)) : 0,
      lastReadAt: Number(it.official_read_at) || (localProg && Number(localProg.updated_at)) || 0,
      addShelfTime: Number(it.add_shelf_time) || 0,
      lastOperateTime: Number(it.last_operate_time) || 0,
      downloaded: !!localPath,
      localPath,
    })
  }
  return { available: true, loggedIn, saveDir, groups, total: books.length, downloadedCount, lastRefreshedAt: bs.last_refreshed_at ?? null, books }
}

// ---------------------------------------------------------------------------
// 番茄网页版匿名发现（首页书单 / 榜单 / 榜单分类）
// 网页版匿名可读，但榜单 bookName/abstract 带字体混淆的私有区字符（U+E000–U+F8FF），
// 干净书名/简介只能按 bookId 从 /page/<bookId> 的 SSR 取。全部失败都返回 ok:false，
// 绝不把上游故障伪装成空列表。
// ---------------------------------------------------------------------------

const FQ_WEB_BASE = 'https://fanqienovel.com'
const FQ_WEB_UA = FQ_SEARCH_UA
const FQ_DISCOVER_TTL = 10 * 60 * 1000
const FQ_DETAIL_TTL = 6 * 60 * 60 * 1000
const FQ_DETAIL_MAX = 300
const FQ_CATEGORIES_TTL = 60 * 60 * 1000
const FQ_PRIVATE_USE = /[\uE000-\uF8FF]/g

// 去掉字体混淆用的私有区字符；非字符串统一当空串。
function sanitizeText(value) {
  return typeof value === 'string' ? value.replace(FQ_PRIVATE_USE, '') : ''
}

// 通用 GET 文本：AbortController 超时 + 只看 resp.ok。成功 { ok:true, text }；
// 任何网络/HTTP/空响应错误都返回 { ok:false, status:502, error:中文 }。
export async function fetchText(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': FQ_WEB_UA, 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8' },
      signal: ctrl.signal,
    })
    if (!resp.ok) return { ok: false, status: 502, error: '请求失败：HTTP ' + resp.status }
    const text = await resp.text()
    if (!text) return { ok: false, status: 502, error: '请求失败：响应为空' }
    return { ok: true, text }
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, status: 502, error: '请求超时' }
    return { ok: false, status: 502, error: '请求失败：' + String((err && err.message) || err) }
  } finally { clearTimeout(timer) }
}

// 从 SSR HTML 中提取 window.__INITIAL_STATE__ 的 JSON。用花括号配对而不是贪婪正则：
// 字符串里的 { } 与转义引号必须跳过。结构不完整/不是合法 JSON 一律抛错（调用方转 502）。
export function initialState(html) {
  if (typeof html !== 'string' || html === '') throw new Error('页面内容为空')
  const marker = /window\.__INITIAL_STATE__\s*=/
  const m = marker.exec(html)
  if (!m) throw new Error('页面缺少 __INITIAL_STATE__')
  const start = html.indexOf('{', m.index + m[0].length)
  if (start < 0) throw new Error('页面状态格式错误')
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) throw new Error('页面状态不完整')
  let state
  try { state = JSON.parse(html.slice(start, end)) } catch { throw new Error('页面状态不是合法 JSON') }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('页面状态格式错误')
  return state
}

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

// 按 class 名取元素文本（详情页 SSR 的 .page 里 .bookName/.abstract）。
// 同时兼容 class="bookName" 与 class="page-bookName" 两种写法。
function classText(html, classNames) {
  if (typeof html !== 'string') return ''
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g
  let m
  while ((m = tagRe.exec(html))) {
    const attrs = m[2] || ''
    const cm = attrs.match(/\bclass\s*=\s*"([^"]*)"/) || attrs.match(/\bclass\s*=\s*'([^']*)'/)
    if (!cm) continue
    const tokens = cm[1].split(/\s+/)
    if (!tokens.some((t) => classNames.includes(t))) continue
    const tag = m[1]
    const bodyStart = tagRe.lastIndex
    const closeRe = new RegExp('</' + tag + '\\s*>', 'ig')
    closeRe.lastIndex = bodyStart
    const close = closeRe.exec(html)
    const body = html.slice(bodyStart, close ? close.index : html.length).replace(/<[^>]*>/g, '')
    return decodeHtml(body).trim()
  }
  return ''
}

const fanqiePageUrl = (bookId) => FQ_WEB_BASE + '/page/' + bookId
const detailCache = new Map() // bookId -> { at, meta }，TTL 6h、上限 300

function cachedDetail(bookId) {
  const hit = detailCache.get(bookId)
  if (!hit) return null
  if (Date.now() - hit.at > FQ_DETAIL_TTL) { detailCache.delete(bookId); return null }
  return hit.meta
}

function rememberDetail(bookId, meta) {
  detailCache.set(bookId, { at: Date.now(), meta })
  while (detailCache.size > FQ_DETAIL_MAX) detailCache.delete(detailCache.keys().next().value)
}

// 真实详情页把干净书名/简介放在 __INITIAL_STATE__.page 里（HTML 无 class="bookName"）。
function detailMetaFromState(html) {
  let state
  try { state = initialState(html) } catch { return null }
  const page = state && state.page
  if (!page || typeof page !== 'object' || Array.isArray(page)) return null
  const title = sanitizeText(page.bookName).trim()
  if (!title) return null
  return { title, description: sanitizeText(page.abstract).trim() }
}

// 只用详情页的干净书名/简介；解析失败返回 null（由调用方跳过并计入 missing）。
async function detailMeta(bookId) {
  const hit = cachedDetail(bookId)
  if (hit) return hit
  const page = await fetchText(fanqiePageUrl(bookId))
  if (!page.ok) return null
  let meta = detailMetaFromState(page.text)
  if (!meta) {
    // 兼容旧结构：class 挂载的书名/简介。
    const title = sanitizeText(classText(page.text, ['bookName', 'page-bookName'])).trim()
    if (!title) return null
    meta = { title, description: sanitizeText(classText(page.text, ['abstract', 'page-abstract'])).trim() }
  }
  rememberDetail(bookId, meta)
  return meta
}

// 小并发池：同时最多 limit 个任务。
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      results[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return results
}

const FQ_SECTIONS = [
  { key: 'editor', name: '编辑推荐', field: 'editorList' },
  { key: 'week', name: '本周强推', field: 'weekList' },
  { key: 'boy', name: '男频精选', field: 'boyList' },
  { key: 'girl', name: '女频精选', field: 'girlList' },
  { key: 'update', name: '最近更新', field: 'updateList' },
]
let discoverCache = null // { at, result }

function normalizeHomeBook(raw, withUpdate) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.bookId !== 'string' || !/^\d+$/.test(raw.bookId)) return null
  const title = sanitizeText(raw.bookName).trim()
  if (!title) return null
  const book = {
    bookId: raw.bookId,
    title,
    author: sanitizeText(raw.author).trim(),
    coverUrl: coverUrl(raw.thumbUri || raw.thumb_url),
    description: sanitizeText(raw.abstract).trim(),
    category: sanitizeText(raw.category).trim(),
  }
  if (withUpdate) {
    book.chapterTitle = sanitizeText(raw.title).trim()
    book.updateTime = sanitizeText(raw.updateTime).trim()
  }
  return book
}

// 首页五个书单。整份结果缓存 10 分钟（模块级，命中后零网络）。
export async function fanqieDiscover() {
  if (discoverCache && Date.now() - discoverCache.at < FQ_DISCOVER_TTL) return discoverCache.result
  const resp = await fetchText(FQ_WEB_BASE + '/')
  if (!resp.ok) return { ok: false, status: 502, error: resp.error }
  let state
  try { state = initialState(resp.text) } catch (err) {
    return { ok: false, status: 502, error: '首页解析失败：' + String((err && err.message) || err) }
  }
  const home = state.home
  if (!home || typeof home !== 'object' || Array.isArray(home)) {
    return { ok: false, status: 502, error: '首页缺少书籍分区数据' }
  }
  const sections = []
  for (const def of FQ_SECTIONS) {
    const list = home[def.field]
    if (!Array.isArray(list)) continue
    const seen = new Set()
    const books = []
    for (const raw of list) {
      const book = normalizeHomeBook(raw, def.key === 'update')
      if (!book || seen.has(book.bookId)) continue
      seen.add(book.bookId)
      books.push(book)
    }
    if (books.length) sections.push({ key: def.key, name: def.name, books })
  }
  const result = { ok: true, sections }
  discoverCache = { at: Date.now(), result }
  return result
}

const rankFail = (error, status) => ({ ok: false, status, error, total: 0, offset: 0, hasMore: false, books: [], missing: 0 })
const toCount = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

// 榜单。categoryId 必须是数字串；offset 0..10000；gender 0女/1男；mold 1新书榜/2阅读榜。
// 榜单书名为字体混淆文本，逐本按 bookId 从详情页换干净书名（并发 ≤3、TTL 6h、上限 300）。
export async function fanqieRank(options = {}) {
  const o = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  const rawGender = o.gender === undefined ? 0 : o.gender
  const rawMold = o.mold === undefined ? 2 : o.mold
  const gender = (rawGender === 0 || rawGender === '0') ? 0 : (rawGender === 1 || rawGender === '1') ? 1 : null
  const mold = (rawMold === 1 || rawMold === '1') ? 1 : (rawMold === 2 || rawMold === '2') ? 2 : null
  const offset = integerOffset(o.offset === undefined ? 0 : o.offset)
  const categoryId = (typeof o.categoryId === 'string' && /^\d+$/.test(o.categoryId)) ? o.categoryId : ''
  if (gender === null) return rankFail('gender 只能是 0（女频）或 1（男频）', 400)
  if (mold === null) return rankFail('mold 只能是 1（新书榜）或 2（阅读榜）', 400)
  if (!categoryId) return rankFail('categoryId 必须是数字串', 400)
  if (offset === null || offset < 0 || offset > 10000) return rankFail('offset 必须是 0..10000 的整数', 400)

  const url = FQ_WEB_BASE + '/api/rank/category/list?app_id=2503&rank_list_type=3&offset=' + offset
    + '&limit=10&category_id=' + categoryId + '&rank_version=&gender=' + gender + '&rankMold=' + mold
  const resp = await fetchText(url)
  if (!resp.ok) return rankFail(resp.error, 502)
  let raw
  try { raw = JSON.parse(resp.text) } catch { return rankFail('榜单接口返回的不是合法 JSON', 502) }
  if (!raw || raw.code !== 0 || !raw.data || typeof raw.data !== 'object' || !Array.isArray(raw.data.book_list)) {
    return rankFail('榜单接口返回格式错误', 502)
  }
  const data = raw.data
  const list = data.book_list
  const seen = new Set()
  const picks = []
  list.forEach((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return
    // 不把 number 转回字符串：长 ID 在 JSON.parse 时可能已经丢失精度。
    const bookId = item.bookId ?? item.book_id
    if (typeof bookId !== 'string' || !/^\d+$/.test(bookId) || seen.has(bookId)) return
    seen.add(bookId)
    picks.push({ item, idx })
  })

  const metas = await mapLimit(picks, 3, async ({ item }) => {
    try { return await detailMeta(item.bookId ?? item.book_id) } catch { return null }
  })
  const books = []
  let missing = 0
  picks.forEach(({ item, idx }, i) => {
    const meta = metas[i]
    if (!meta) { missing++; return }
    const currentPos = Number(item.currentPos ?? item.current_pos)
    books.push({
      bookId: item.bookId ?? item.book_id,
      title: meta.title,
      author: sanitizeText(item.author).trim(),
      coverUrl: coverUrl(item.thumbUri || item.thumb_url),
      description: meta.description,
      category: sanitizeText(item.category).trim(),
      status: bookStatus(item.creationStatus ?? item.creation_status),
      wordNumber: toCount(item.wordNumber ?? item.word_number),
      readCount: toCount(item.read_count ?? item.readCount),
      lastChapterTitle: sanitizeText(item.lastChapterTitle ?? item.last_chapter_title).trim(),
      rankPos: Number.isFinite(currentPos) && currentPos > 0 ? currentPos : offset + idx + 1,
    })
  })
  const total = toCount(data.total_num)
  const returned = list.length
  const next = offset + returned
  const hasMore = returned > 0 && (total > 0 ? next < total : returned >= 10)
  return { ok: true, total, offset: next, hasMore, books, missing }
}

let rankCategoriesCache = null // { at, result }

function normalizeCategoryList(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const it of list) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue
    const id = typeof it.id === 'string' ? it.id.trim() : (typeof it.id === 'number' && Number.isSafeInteger(it.id) ? String(it.id) : '')
    const name = sanitizeText(it.name).trim()
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name })
  }
  return out
}

// 榜单分类（男频/女频）。缓存 1 小时；解析失败返回 502 而非空分类。
export async function fanqieRankCategories() {
  if (rankCategoriesCache && Date.now() - rankCategoriesCache.at < FQ_CATEGORIES_TTL) return rankCategoriesCache.result
  const resp = await fetchText(FQ_WEB_BASE + '/rank')
  if (!resp.ok) return { ok: false, status: 502, error: resp.error }
  let state
  try { state = initialState(resp.text) } catch (err) {
    return { ok: false, status: 502, error: '榜单页解析失败：' + String((err && err.message) || err) }
  }
  const src = state.rank && state.rank.rankCategoryTypeList
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    return { ok: false, status: 502, error: '榜单页缺少分类数据' }
  }
  const male = normalizeCategoryList(src.male)
  const female = normalizeCategoryList(src.female)
  if (!male.length && !female.length) return { ok: false, status: 502, error: '榜单分类为空' }
  const result = { ok: true, male, female }
  rankCategoriesCache = { at: Date.now(), result }
  return result
}