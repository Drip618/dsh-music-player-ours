// 番茄网页版发现页 / 榜单 / 榜单分类：全部使用 stub fetch，绝不发真实请求。
// 上游协议（2026-11 实测）：
//   A 首页 window.__INITIAL_STATE__ 的 .home 下五个书单；
//   B /api/rank/category/list 返回字体混淆书名的榜单，干净书名从 /page/<bookId> SSR 取；
//   C /rank SSR 的 .rank.rankCategoryTypeList。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PUA = /[\uE000-\uF8FF]/
const HOME_URL = 'https://fanqienovel.com/'
const RANK_API = 'https://fanqienovel.com/api/rank/category/list'
const PAGE_PREFIX = 'https://fanqienovel.com/page/'

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const html = (text, status = 200) => new Response(text, { status, headers: { 'Content-Type': 'text/html' } })
const stateHtml = (state) => '<html><body><script>window.__INITIAL_STATE__=' + JSON.stringify(state) + ';</script></body></html>'
// 真实详情页结构：干净书名/简介在 __INITIAL_STATE__.page 里，HTML 没有 class="bookName"。
const pageHtml = (name, abstract = '') => stateHtml({ page: { bookName: name, abstract } })
const legacyPageHtml = (name, abstract = '') => '<html><body><div class="page"><h1 class="bookName">' + name + '</h1><div class="abstract">' + abstract + '</div></div></body></html>'
const homeBook = (id, name, extra = {}) => ({
  bookId: id, bookName: name, author: '作者' + id,
  thumbUri: 'https://p6-tt.bytecdn.cn/novel-pic/' + id + '.image',
  abstract: '简介' + id, category: '都市', ...extra,
})
const updateBook = (id, name, chapterTitle, extra = {}) => homeBook(id, name, { title: chapterTitle, updateTime: '2026-11-01 10:00', itemId: 'item-' + id, ...extra })
const homeState = (over = {}) => ({
  home: {
    editorList: [homeBook('1001', '编辑推荐书')],
    weekList: [homeBook('1002', '本周强推书')],
    boyList: [homeBook('1003', '男频书')],
    girlList: [homeBook('1004', '女频书')],
    updateList: [updateBook('1005', '更新书', '第12章 风起')],
    ...over,
  },
})
// 榜单 API 的 bookName/abstract 带私有区字符，author/category 等干净。
const rankBook = (id, extra = {}) => ({
  bookId: id, bookName: '\uE111\uE112', abstract: '\uE113',
  author: '作者' + id, category: '都市', wordNumber: 123456, read_count: 98765,
  lastChapterTitle: '第 3 章', creationStatus: 1,
  thumbUri: 'https://p6-novel.byteimg.com/novel-pic/' + id + '.image', ...extra,
})
const rankPayload = (ids, total = 25) => ({ code: 0, data: { book_list: ids.map((id) => (typeof id === 'string' ? rankBook(id) : id)), total_num: total } })

let home, Fanqie, apply, fetchStub, cleanups

function stubHome(state = homeState()) {
  fetchStub.mockImplementation(async (url) => {
    const u = String(url)
    if (u === HOME_URL) return html(stateHtml(state))
    throw new Error('unexpected fetch: ' + u)
  })
}
function stubRank(ids, { total = 25, detail = (id) => pageHtml('干净书名' + id, '干净简介' + id), extra } = {}) {
  fetchStub.mockImplementation(async (url) => {
    const u = String(url)
    if (u.startsWith(RANK_API)) return json(rankPayload(ids, total))
    const m = u.match(/^https:\/\/fanqienovel\.com\/page\/(\d+)$/)
    if (m) {
      const r = detail(m[1])
      if (r instanceof Response) return r
      if (extra) return extra(m[1], r)
      return html(r)
    }
    throw new Error('unexpected fetch: ' + u)
  })
}
const pageCalls = () => fetchStub.mock.calls.filter((c) => String(c[0]).startsWith(PAGE_PREFIX)).length

beforeEach(async () => {
  home = mkdtempSync('/tmp/dsh-fanqie-discover-')
  vi.stubEnv('HOME', home)
  vi.stubEnv('DSH_HOME', join(home, '.dsh'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  fetchStub = vi.fn().mockRejectedValue(new Error('禁止真实网络请求'))
  vi.stubGlobal('fetch', fetchStub)
  cleanups = []
  // 隔离 HOME 后再加载宿主依赖图；不读取本机账号/cookie/书库。
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
    resolve: vi.fn(async (p) => resolve(p)),
    stat: vi.fn(async () => undefined),
    processPath: (p) => resolve(p),
  }
  apply({
    fs,
    shell: { resolve: (o) => o, run: async () => ({ stdout: { text: home } }) },
    webServer: { register: (row) => { handler = row.handler } },
    tools: { register() {} }, systemPrompt: { section() {} },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose) },
    get: () => undefined,
  })
  async function request(url, method = 'GET') {
    const req = { url, method, headers: {}, async *[Symbol.asyncIterator]() {} }
    const res = { status: 200, body: null, writeHead(status) { this.status = status }, end(body) { this.body = body == null ? null : JSON.parse(body) } }
    await handler(req, res)
    return { status: res.status, body: res.body }
  }
  return { request }
}

describe('fetchText / initialState', () => {
  it('超时返回中文 502 错误', async () => {
    fetchStub.mockImplementation((_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const pending = Fanqie.fetchText('https://example.test/slow')
    await vi.advanceTimersByTimeAsync(15000)
    expect(await pending).toEqual({ ok: false, status: 502, error: '请求超时' })
  })
  it('HTTP 非 2xx 不当正常文本', async () => {
    fetchStub.mockResolvedValue(new Response('故障', { status: 503 }))
    expect(await Fanqie.fetchText('https://example.test/x')).toMatchObject({ ok: false, status: 502, error: expect.stringContaining('503') })
  })
  it('花括号配对忽略字符串内的括号与转义；解析失败报错', () => {
    const state = { home: { editorList: [homeBook('1001', '书}名"副标题\\尾')] } }
    expect(Fanqie.initialState(stateHtml(state))).toEqual(state)
    expect(() => Fanqie.initialState('<html>没有状态</html>')).toThrow()
    expect(() => Fanqie.initialState('<script>window.__INITIAL_STATE__={"home":{</script>')).toThrow()
  })
})

describe('fanqieDiscover 首页分区', () => {
  it('五个分区按序、字段规范化并复用封面协议映射', async () => {
    stubHome()
    const r = await Fanqie.fanqieDiscover()
    expect(r.ok).toBe(true)
    expect(r.sections.map((s) => [s.key, s.name])).toEqual([
      ['editor', '编辑推荐'], ['week', '本周强推'], ['boy', '男频精选'], ['girl', '女频精选'], ['update', '最近更新'],
    ])
    expect(r.sections[0].books[0]).toEqual({
      bookId: '1001', title: '编辑推荐书', author: '作者1001',
      coverUrl: 'https://p6-novel.byteimg.com/novel-pic/1001.image',
      description: '简介1001', category: '都市',
    })
  })
  it('最近更新带章节名与更新时间', async () => {
    stubHome()
    const update = (await Fanqie.fanqieDiscover()).sections.find((s) => s.key === 'update')
    expect(update.books[0]).toMatchObject({ bookId: '1005', title: '更新书', chapterTitle: '第12章 风起', updateTime: '2026-11-01 10:00' })
  })
  it('过滤非法/重复 bookId 与空标题；保留前导零字符串', async () => {
    stubHome(homeState({
      editorList: [
        homeBook('1001', '甲'), homeBook('1001', '甲重复'),
        homeBook('abc', '坏ID'), homeBook('', '空ID'), { bookId: 1007, bookName: '数字ID' },
        homeBook('1008', ''), homeBook('1009', '   '), homeBook('0010', '前导零'),
      ],
    }))
    const books = (await Fanqie.fanqieDiscover()).sections[0].books
    expect(books.map((b) => b.bookId)).toEqual(['1001', '0010'])
    expect(books[1].title).toBe('前导零')
  })
  it('缺分区就跳过空分区；私有区字符不进入输出', async () => {
    stubHome({
      home: {
        editorList: [homeBook('1001', '天\uE001下')],
        weekList: [],
        boyList: [homeBook('1003', '男频书')],
        updateList: [updateBook('1005', '更新书', '第\uE002章')],
      },
    })
    const r = await Fanqie.fanqieDiscover()
    expect(r.sections.map((s) => s.key)).toEqual(['editor', 'boy', 'update'])
    expect(r.sections[0].books[0].title).toBe('天下')
    expect(JSON.stringify(r)).not.toMatch(PUA)
  })
  it('首页请求失败或状态损坏返回 502，绝不当空分区', async () => {
    fetchStub.mockResolvedValue(new Response('故障', { status: 500 }))
    expect(await Fanqie.fanqieDiscover()).toMatchObject({ ok: false, status: 502, error: expect.any(String) })
    fetchStub.mockResolvedValue(html('<html>没有状态</html>'))
    expect(await Fanqie.fanqieDiscover()).toMatchObject({ ok: false, status: 502, error: expect.any(String) })
  })
  it('10 分钟缓存命中后零网络', async () => {
    stubHome()
    const first = await Fanqie.fanqieDiscover()
    const second = await Fanqie.fanqieDiscover()
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })
})

describe('fanqieRank 榜单', () => {
  it('请求参数正确，用详情页干净书名替换混淆书名', async () => {
    stubRank(['2001', '2002'])
    const r = await Fanqie.fanqieRank({ gender: 0, mold: 2, categoryId: '1234', offset: 0 })
    expect(r).toMatchObject({ ok: true, total: 25, offset: 2, hasMore: true, missing: 0 })
    expect(r.books.map((b) => b.bookId)).toEqual(['2001', '2002'])
    expect(r.books[0]).toMatchObject({
      title: '干净书名2001', description: '干净简介2001', author: '作者2001', category: '都市',
      coverUrl: 'https://p6-novel.byteimg.com/novel-pic/2001.image',
      status: '连载中', wordNumber: 123456, readCount: 98765, lastChapterTitle: '第 3 章', rankPos: 1,
    })
    const rankUrl = new URL(fetchStub.mock.calls[0][0])
    expect(rankUrl.searchParams.get('app_id')).toBe('2503')
    expect(rankUrl.searchParams.get('rank_list_type')).toBe('3')
    expect(rankUrl.searchParams.get('limit')).toBe('10')
    expect(rankUrl.searchParams.get('category_id')).toBe('1234')
    expect(rankUrl.searchParams.get('gender')).toBe('0')
    expect(rankUrl.searchParams.get('rankMold')).toBe('2')
    expect(rankUrl.searchParams.get('offset')).toBe('0')
    expect(JSON.stringify(r.books)).not.toMatch(PUA)
  })
  it('rankPos 优先 currentPos，缺失用 offset+i+1；状态映射与未知', async () => {
    stubRank([rankBook('2001', { currentPos: 7 }), rankBook('2002', { creationStatus: 0 }), rankBook('2003', { creationStatus: 9 })])
    const r = await Fanqie.fanqieRank({ gender: 1, mold: 1, categoryId: '99', offset: 4 })
    expect(r.books.map((b) => b.rankPos)).toEqual([7, 6, 7])
    expect(r.books.map((b) => b.status)).toEqual(['连载中', '已完结', '状态未知'])
  })
  it('详情页失败/缺书名时跳过该条并计入 missing，不泄露私有区字符', async () => {
    stubRank(['2001', '2002', '2003'], {
      detail: (id) => (id === '2001' ? pageHtml('干净书名2001', '简介') : id === '2002' ? new Response('炸了', { status: 500 }) : '<html><body><div class="page"><h1>无书名</h1></div></body></html>'),
    })
    const r = await Fanqie.fanqieRank({ gender: 0, mold: 2, categoryId: '1', offset: 0 })
    expect(r.ok).toBe(true)
    expect(r.books.map((b) => b.bookId)).toEqual(['2001'])
    expect(r.missing).toBe(2)
    expect(JSON.stringify(r)).not.toMatch(PUA)
  })
  it('同一请求内重复 bookId 去重，且只抓一次详情', async () => {
    stubRank(['3001', '3001', '3002'])
    const r = await Fanqie.fanqieRank({ gender: 0, mold: 2, categoryId: '1' })
    expect(r.books.map((b) => b.bookId)).toEqual(['3001', '3002'])
    expect(fetchStub.mock.calls.filter((c) => String(c[0]) === PAGE_PREFIX + '3001')).toHaveLength(1)
  })
  it('20 本详情解析并发不超过 3', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => String(5000 + i))
    let pending = 0
    let peak = 0
    stubRank(ids, {
      detail: (id) => pageHtml('干净书名' + id, '简介' + id),
      extra: async (id, body) => {
        pending++
        peak = Math.max(peak, pending)
        for (let i = 0; i < 8; i++) await Promise.resolve()
        pending--
        return html(body)
      },
    })
    const r = await Fanqie.fanqieRank({ gender: 0, mold: 2, categoryId: '1' })
    expect(r.books).toHaveLength(20)
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })
  it('详情缓存命中后 fetch 次数不增', async () => {
    stubRank(['4001', '4002'])
    const first = await Fanqie.fanqieRank({ gender: 0, mold: 2, categoryId: '1' })
    const afterFirst = pageCalls()
    expect(afterFirst).toBe(2)
    const second = await Fanqie.fanqieRank({ gender: 0, mold: 2, categoryId: '1' })
    expect(pageCalls()).toBe(afterFirst)
    expect(second.books).toEqual(first.books)
    // 第二次只多一次榜单列表请求，详情页全部命中缓存。
    expect(fetchStub).toHaveBeenCalledTimes(4)
  })
  it.each([
    [2, 2, '1', 0], [0, 3, '1', 0], [0, 2, '', 0], [0, 2, 'abc', 0], [0, 2, 123, 0],
    [0, 2, '1', -1], [0, 2, '1', 1.5], [0, 2, '1', 10001], [0, 2, '1', 'x'], [0, 2, '1', null],
  ])('非法参数不触网并返回 400：gender=%j mold=%j category=%j offset=%j', async (gender, mold, categoryId, offset) => {
    const r = await Fanqie.fanqieRank({ gender, mold, categoryId, offset })
    expect(r).toMatchObject({ ok: false, status: 400, error: expect.any(String) })
    expect(fetchStub).not.toHaveBeenCalled()
  })
  it.each([
    ['HTTP 503', () => new Response('故障', { status: 503 })],
    ['非法 JSON', () => new Response('<html>错误</html>')],
    ['业务失败', () => json({ code: 1, message: '上游失败' })],
    ['缺 book_list', () => json({ code: 0, data: {} })],
    ['book_list 类型错误', () => json({ code: 0, data: { book_list: {} } })],
  ])('%s 返回 502 且不当空榜单', async (_label, response) => {
    fetchStub.mockResolvedValue(response())
    const r = await Fanqie.fanqieRank({ gender: 0, mold: 2, categoryId: '1' })
    expect(r).toMatchObject({ ok: false, status: 502, error: expect.any(String), hasMore: false })
  })
  it('hasMore/offset 按 total 与本页返回条数计算', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => String(6000 + i))
    stubRank(ids, { total: 20 })
    const r = await Fanqie.fanqieRank({ gender: '1', mold: '1', categoryId: '77', offset: '10' })
    expect(r).toMatchObject({ ok: true, offset: 20, hasMore: false, total: 20, missing: 0 })
    expect(r.books[0].rankPos).toBe(11)
  })
})

describe('fanqieRankCategories', () => {
  const rankState = { rank: { rankCategoryTypeList: { male: [{ id: '1', name: '都市' }, { id: 2, name: '玄幻' }], female: [{ id: '9', name: '古言' }] } } }
  it('解析 SSR 分类并规范化 id 为字符串', async () => {
    fetchStub.mockResolvedValue(html(stateHtml(rankState)))
    expect(await Fanqie.fanqieRankCategories()).toEqual({
      ok: true, male: [{ id: '1', name: '都市' }, { id: '2', name: '玄幻' }], female: [{ id: '9', name: '古言' }],
    })
  })
  it('1 小时缓存命中后零网络', async () => {
    fetchStub.mockResolvedValue(html(stateHtml(rankState)))
    const first = await Fanqie.fanqieRankCategories()
    expect(await Fanqie.fanqieRankCategories()).toEqual(first)
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })
  it('解析失败返回 502 而非空分类', async () => {
    fetchStub.mockResolvedValue(html('<html>没有状态</html>'))
    expect(await Fanqie.fanqieRankCategories()).toMatchObject({ ok: false, status: 502, error: expect.any(String) })
  })
})

describe('真实 apply 的发现/榜单路由', () => {
  it('GET /dsh-music/fanqie/discover 成功 200', async () => {
    stubHome()
    const { request } = await boot()
    const r = await request('/dsh-music/fanqie/discover')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.sections).toHaveLength(5)
  })
  it('GET /dsh-music/fanqie/rank 读出 query 并成功 200', async () => {
    stubRank(['7001'])
    const { request } = await boot()
    const r = await request('/dsh-music/fanqie/rank?gender=1&mold=1&category=88&offset=0')
    expect(r.status).toBe(200)
    expect(r.body.books[0].bookId).toBe('7001')
    const u = new URL(fetchStub.mock.calls[0][0])
    expect(u.searchParams.get('gender')).toBe('1')
    expect(u.searchParams.get('rankMold')).toBe('1')
    expect(u.searchParams.get('category_id')).toBe('88')
  })
  it('GET /dsh-music/fanqie/rank 非法参数 400 且不触网', async () => {
    const { request } = await boot()
    const r = await request('/dsh-music/fanqie/rank?gender=9&mold=2&category=1')
    expect(r.status).toBe(400)
    expect(r.body.ok).toBe(false)
    expect(fetchStub).not.toHaveBeenCalled()
  })
  it('GET /dsh-music/fanqie/rank 上游失败 502', async () => {
    fetchStub.mockResolvedValue(new Response('炸了', { status: 500 }))
    const { request } = await boot()
    expect((await request('/dsh-music/fanqie/rank?gender=0&mold=2&category=1')).status).toBe(502)
  })
  it('GET /dsh-music/fanqie/rank/categories 成功 200', async () => {
    fetchStub.mockResolvedValue(html(stateHtml({ rank: { rankCategoryTypeList: { male: [{ id: '1', name: '都市' }], female: [] } } })))
    const { request } = await boot()
    const ok = await request('/dsh-music/fanqie/rank/categories')
    expect(ok.status).toBe(200)
    expect(ok.body.male).toEqual([{ id: '1', name: '都市' }])
  })
  it('GET /dsh-music/fanqie/rank/categories 解析失败 502', async () => {
    fetchStub.mockResolvedValue(html('<html>坏页</html>'))
    const { request } = await boot()
    expect((await request('/dsh-music/fanqie/rank/categories')).status).toBe(502)
  })
})
