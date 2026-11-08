import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'

let home, stateFile, downloads, Fanqie, apply, cleanups, fetchStub
const longId = '71234567890123456789'
const record = (book_id = longId, extra = {}) => ({ book_id, title: '测试小说', author: '测试作者', ...extra })
const searchData = (ret_data = [], extra = {}) => ({ code: 0, data: { ret_data, has_more: false, offset: 0, ...extra } })
function writeState(state = {}) {
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify(state))
}
function downloadedState(path, extra = {}) {
  return {
    preferences: { download_preferences: { save_dir: downloads } },
    download_jobs: [{ book_id: longId, book_name: '测试小说', output_path: path, status: 'done' }],
    official_bookshelf: { items: [record()], last_refreshed_at: 1700000000123 },
    ...extra,
  }
}
function writeBook(path) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '测试小说\n第一章 起点\n这是一段用于验证真实章节解析的小说正文。\n第二章 后来\n故事仍在继续。')
  return path
}
function reply(data) { fetchStub.mockResolvedValue(new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })) }

beforeEach(async () => {
  home = mkdtempSync('/tmp/dsh-fanqie-host-')
  downloads = join(home, 'downloads')
  stateFile = join(home, 'Library', 'Application Support', 'com.pofl.fanqienoveldownloader', 'rust_state.json')
  vi.stubEnv('HOME', home)
  vi.stubEnv('DSH_HOME', join(home, '.dsh'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  fetchStub = vi.fn().mockRejectedValue(new Error('禁止真实网络请求'))
  vi.stubGlobal('fetch', fetchStub)
  cleanups = []
  // 必须先隔离 HOME，再加载整个宿主依赖图；不读取本机账号或下载器状态。
  vi.resetModules()
  Fanqie = await import('../lib/fanqie.js')
  ;({ apply } = await import('../lib/index.js'))
})
afterEach(async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  for (const dispose of cleanups.reverse()) dispose()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

async function boot() {
  let handler
  const fs = {
    resolve: vi.fn(async p => resolve(p)),
    stat: vi.fn(async p => { try { const s = statSync(p); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size } } catch { return undefined } }),
    processPath: p => resolve(p),
  }
  apply({
    fs,
    shell: { resolve: o => o, run: async () => ({ stdout: { text: home } }) },
    webServer: { register: row => { handler = row.handler } },
    tools: { register() {} }, systemPrompt: { section() {} },
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose) },
    get: () => undefined,
  })
  async function request(url, method = 'GET') {
    const req = { url, method, headers: {}, async *[Symbol.asyncIterator]() {} }
    const res = { status: 200, body: null, writeHead(status) { this.status = status }, end(body) { this.body = body == null ? null : JSON.parse(body) } }
    await handler(req, res)
    return res
  }
  // 真实 book 路由等待 startup；不调用 manifest，避免触碰账号读取/探测分支。
  await request('/dsh-music/book/not-present/meta')
  return { request, fs }
}

describe('番茄搜索边界与上游协议', () => {
  it.each([
    ['', 0], ['   ', 0], ['书'.repeat(201), 0], ['小说', -1], ['小说', 1.2],
    ['小说', 100001], ['小说', Infinity], ['小说', NaN], ['小说', 'nope'],
    ['小说', ''], ['小说', ' '], ['小说', null], ['小说', true], ['小说', []],
  ])('非法 query/offset 不触网：%j / %j', async (q, offset) => {
    expect(await Fanqie.fanqieSearch(q, offset)).toMatchObject({ ok: false, status: 400, hasMore: false })
    expect(fetchStub).not.toHaveBeenCalled()
  })
  it('允许 200 字与 offset=100000，编码关键词并保持合法空结果', async () => {
    reply(searchData())
    expect(await Fanqie.fanqieSearch('书'.repeat(200), '100000')).toMatchObject({ ok: true, results: [], hasMore: false })
    const url = new URL(fetchStub.mock.calls[0][0])
    expect(url.searchParams.get('q')).toBe('书'.repeat(200))
    expect(url.searchParams.get('offset')).toBe('100000')
  })
  it.each([
    ['HTTP 503', () => new Response('故障', { status: 503 })],
    ['HTTP 204', () => new Response(null, { status: 204 })],
    ['空内容', () => new Response('')],
    ['非法 JSON', () => new Response('<html>错误</html>')],
    ['缺失 ret_data', () => new Response(JSON.stringify({ code: 0, data: {} }))],
    ['错误 ret_data', () => new Response(JSON.stringify({ code: 0, data: { ret_data: {} } }))],
    ['业务失败', () => new Response(JSON.stringify({ code: 1, message: '上游失败' }))],
  ])('%s 不得被当作空结果', async (_label, response) => {
    fetchStub.mockResolvedValue(response())
    const r = await Fanqie.fanqieSearch('小说')
    expect(r).toMatchObject({ ok: false, hasMore: false })
    expect(r.error).toBeTruthy()
  })
  it('网络异常/超时返回错误', async () => {
    fetchStub.mockRejectedValueOnce(new Error('断网')).mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    expect(await Fanqie.fanqieSearch('小说')).toMatchObject({ ok: false, error: expect.stringContaining('断网') })
    expect(await Fanqie.fanqieSearch('小说')).toMatchObject({ ok: false, error: '搜索超时' })
  })
  it('只接受数字字符串 ID，过滤坏记录和重复，长 ID 保真', async () => {
    reply(searchData([null, [], 'bad', record(''), record('abc'), record('1e20'), record(12), record(Number(longId)), record('88', { title: '' }), record('89', { title: null }), record(longId), record(longId), record('000123')]))
    const r = await Fanqie.fanqieSearch('小说')
    expect(r.ok).toBe(true)
    expect(r.results.map(b => b.bookId)).toEqual([longId, '000123'])
    expect(r.results[0].pageUrl).toBe('https://fanqienovel.com/page/' + longId)
  })
  it.each(['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///tmp/a.png', '//example.test/a.png', 'not a url'])('过滤非 HTTP(S) 封面 %s', async thumb_url => {
    reply(searchData([record(longId, { thumb_url })]))
    expect((await Fanqie.fanqieSearch('小说')).results[0].coverUrl).toBe('')
  })
  it('全站搜索封面使用可用的番茄图源，保留路径与参数', async () => {
    reply(searchData([record(longId, { thumb_url: 'https://p6-tt.bytecdn.cn/novel-pic/cover~tplv-shrink:640:0.image?v=1' })]))
    expect((await Fanqie.fanqieSearch('小说')).results[0].coverUrl).toBe('https://p6-novel.byteimg.com/novel-pic/cover~tplv-shrink:640:0.image?v=1')
  })
  it.each(['http://example.test/a.png', 'https://example.test/a.png'])('保留合法封面 %s', async thumb_url => {
    reply(searchData([record(longId, { thumb_url })]))
    expect((await Fanqie.fanqieSearch('小说')).results[0].coverUrl).toBe(thumb_url)
  })
  it.each([[0, '已完结'], [1, '连载中'], ['0', '已完结'], ['1', '连载中'], ['已完结', '已完结'], ['连载中', '连载中'], [4, '状态未知'], [99, '状态未知'], [null, '状态未知']])('搜索与书架状态 %j → %s', async (status, expected) => {
    reply(searchData([record(longId, { creation_status: status })]))
    writeState({ official_bookshelf: { items: [record(longId, { status, update_status: 1 })] } })
    expect((await Fanqie.fanqieSearch('小说')).results[0].status).toBe(expected)
    expect(Fanqie.fanqieShelf().books[0].status).toBe(expected)
  })
  it.each([undefined, null, 0, 10, 9, -1, 10.5, 'Infinity', 'bad', true])('不递增/非法游标 %j 不伪造翻页', async offset => {
    reply(searchData([record(), record()], { has_more: true, offset }))
    expect(await Fanqie.fanqieSearch('小说', 10)).toMatchObject({ ok: true, hasMore: false, offset: 10 })
  })
  it('只用服务端递增整数游标；重复页不按结果数伪造下一页', async () => {
    reply(searchData([record(), record()], { has_more: true, offset: '23' }))
    expect(await Fanqie.fanqieSearch('小说', 10)).toMatchObject({ hasMore: true, offset: 23 })
    expect(await Fanqie.fanqieSearch('小说', 23)).toMatchObject({ hasMore: false, offset: 23 })
  })
})

describe('番茄本地状态', () => {
  it('同一模块按当前 HOME 读取，未安装是正常空状态', () => {
    writeState({ official_bookshelf: { items: [record()] } })
    vi.stubEnv('HOME', join(home, 'another-home'))
    expect(Fanqie.fanqieAvailable()).toBe(false)
    expect(Fanqie.fanqieLibrary()).toMatchObject({ available: false, books: [] })
    expect(Fanqie.fanqieShelf()).toMatchObject({ available: false, books: [] })
    expect(Fanqie.fanqieShelf().error).toBeUndefined()
  })
  it.each(['{broken', 'null', '[]', '42'])('损坏/非法 state %s 返回错误而非未安装', text => {
    writeState()
    writeFileSync(stateFile, text)
    for (const r of [Fanqie.fanqieLibrary(), Fanqie.fanqieShelf()]) {
      expect(r.available).toBe(true)
      expect(r.error).toBeTruthy()
    }
    expect(readFileSync(stateFile, 'utf8')).toBe(text)
  })
  it('读取失败返回错误', () => {
    mkdirSync(stateFile, { recursive: true })
    expect(Fanqie.fanqieLibrary().error).toBeTruthy()
    expect(Fanqie.fanqieShelf().error).toBeTruthy()
  })
  it('保留 lastRefreshedAt 并过滤本地封面协议，不改写状态', () => {
    const path = writeBook(join(downloads, 'book.txt'))
    writeState(downloadedState(path, { official_bookshelf: { last_refreshed_at: 1700000000123, items: [record(longId, { cover_url: 'file:///private/image.png' })] } }))
    const before = readFileSync(stateFile, 'utf8')
    expect(Fanqie.fanqieShelf()).toMatchObject({ lastRefreshedAt: 1700000000123, books: [expect.objectContaining({ coverUrl: '' })] })
    expect(Fanqie.fanqieLibrary().books[0].coverUrl).toBe('')
    expect(readFileSync(stateFile, 'utf8')).toBe(before)
  })
})

describe('真实 apply 与 HTTP handler', () => {
  it('新增下载 → shelf → 精确 book/meta、text 可用；移除同步且不重扫本地目录', async () => {
    const local = writeBook(join(home, 'Music', 'z-local.txt'))
    writeState({ official_bookshelf: { items: [record()] } })
    const { request, fs } = await boot()
    expect((await request('/dsh-music/book/b0/meta')).status).toBe(200)
    const calls = fs.resolve.mock.calls.length
    writeBook(join(home, 'Music', 'a-new-local.txt')) // 若重扫，会抢占 b0
    const path = writeBook(join(downloads, 'new.txt'))
    writeState(downloadedState(path))
    const shelf = await request('/dsh-music/fanqie/shelf')
    expect(shelf.status).toBe(200)
    const id = 'fq-' + createHash('sha256').update(realpathSync(path)).digest('hex').slice(0, 24)
    expect(shelf.body.books[0].playId).toBe(id)
    expect(shelf.body.lastRefreshedAt).toBe(1700000000123)
    expect(shelf.body.libraryBooks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'b0', path: local }), expect.objectContaining({ id, path })]))
    expect(shelf.body.libraryBooks).toHaveLength(2)
    expect(fs.resolve.mock.calls.length).toBe(calls)
    const meta = await request('/dsh-music/book/' + id + '/meta')
    expect(meta.status).toBe(200)
    expect(meta.body.total).toBeGreaterThan(0)
    expect(meta.body.chapters).toHaveLength(2)
    expect(meta.body.chapters[0].heading).toContain('第一章')
    expect(meta.body.chapters[1].heading).toContain('第二章')
    const ch1 = await request('/dsh-music/book/' + id + '/chapter?idx=0')
    expect(ch1.body).toMatchObject({ ok: true, index: 0, total: 2 })
    expect(ch1.body.text).toContain('第一章')
    expect(ch1.body.text).toContain('这是一段')
    expect(ch1.body.text).not.toContain('故事仍在继续')
    const ch2 = await request('/dsh-music/book/' + id + '/chapter?idx=1')
    expect(ch2.body.text).toContain('第二章')
    expect(ch2.body.text).toContain('故事仍在继续')
    expect((await request('/dsh-music/book/' + id + '/chapter?idx=99')).body.index).toBe(1)
    expect((await request('/dsh-music/book/' + id + '/text')).body.ok).toBe(true)
    expect((await request('/dsh-music/book/' + id + '-wrong/meta')).status).toBe(404)
    rmSync(path)
    const removed = await request('/dsh-music/fanqie/shelf')
    expect(removed.body.books[0]).toMatchObject({ downloaded: false, playId: null })
    expect(removed.body.libraryBooks).toEqual([expect.objectContaining({ id: 'b0', path: local })])
    expect((await request('/dsh-music/book/' + id + '/meta')).status).toBe(404)
    expect(fs.resolve.mock.calls.length).toBe(calls)
    expect(fetchStub).not.toHaveBeenCalled()
  })
  it('模型目录路由下发可下载清单与下载状态，不会自己发起下载', async () => {
    const { request } = await boot()
    const cat = await request('/dsh-music/tts/catalog')
    expect(cat.status).toBe(200)
    expect(cat.body.models.map((m) => m.id)).toContain('vits-zh-aishell3')
    expect(cat.body.models.map((m) => m.id)).toContain('vits-melo-tts-zh_en-int8')
    expect(cat.body.models.every((m) => m.installed === false)).toBe(true)
    expect(cat.body.job).toBeNull()
    const st = await request('/dsh-music/tts/catalog/status')
    expect(st.status).toBe(200)
    expect(st.body.job).toBeNull()
  })
  it('已扫描同一规范路径沿用 b0：library/shelf 都关联且可读', async () => {
    const path = writeBook(join(home, 'Music', 'local.txt'))
    writeState(downloadedState(dirname(path) + '/./local.txt'))
    const { request } = await boot()
    const library = await request('/dsh-music/fanqie/library')
    expect(library.body.books).toHaveLength(1)
    expect(library.body.books[0].id).toBe('b0')
    const shelf = await request('/dsh-music/fanqie/shelf')
    expect(shelf.body.books[0].playId).toBe('b0')
    expect(shelf.body.libraryBooks).toHaveLength(1)
    expect(shelf.body.libraryBooks[0]).toMatchObject({ id: 'b0', source: 'local' })
    expect((await request('/dsh-music/book/b0/meta')).status).toBe(200)
  })
  it('refresh 启动合并的 ID 不随文件排序/路径别名变化', async () => {
    const path = writeBook(join(downloads, 'z.txt'))
    writeState(downloadedState(path))
    const first = await boot()
    const id = (await first.request('/dsh-music/fanqie/library')).body.books.find(b => b.bookId === longId).id
    expect(id).toBe('fq-' + createHash('sha256').update(realpathSync(path)).digest('hex').slice(0, 24))
    writeBook(join(downloads, 'a.txt'))
    const alias = join(home, 'alias')
    symlinkSync(downloads, alias, 'dir')
    writeState(downloadedState(join(alias, 'z.txt')))
    const second = await boot()
    const library = (await second.request('/dsh-music/fanqie/library')).body
    expect(library.books.find(b => b.bookId === longId).id).toBe(id)
    expect((await second.request('/dsh-music/book/' + id + '/meta')).status).toBe(200)
  })
  it.each(['library', 'shelf'])('%s 路由展示状态读取错误', async route => {
    writeState()
    const { request } = await boot()
    writeFileSync(stateFile, '{broken')
    const r = await request('/dsh-music/fanqie/' + route)
    expect(r.status).toBe(500)
    expect(r.body).toMatchObject({ ok: false, error: expect.any(String) })
  })
  it('HTTP 参数校验保留非法 offset，返回 400 而非 502 且不触网', async () => {
    const { request } = await boot()
    for (const query of ['q=', 'q=' + '书'.repeat(201), 'q=小说&offset=garbage', 'q=小说&offset=', 'q=小说&offset=-1', 'q=小说&offset=1.5', 'q=小说&offset=100001']) {
      const r = await request('/dsh-music/fanqie/search?' + query)
      expect(r.status).toBe(400)
      expect(r.body.ok).toBe(false)
    }
    expect(fetchStub).not.toHaveBeenCalled()
  })
  it('HTTP 搜索错误返回 502；有效结果长 ID 保真', async () => {
    const { request } = await boot()
    reply({ code: 0, data: {} })
    expect((await request('/dsh-music/fanqie/search?q=小说')).status).toBe(502)
    reply(searchData([record()]))
    const r = await request('/dsh-music/fanqie/search?q=小说')
    expect(r.status).toBe(200)
    expect(r.body.results[0].bookId).toBe(longId)
  })
})
