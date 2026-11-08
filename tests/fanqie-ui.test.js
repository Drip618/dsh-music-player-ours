// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'

const source = readFileSync('lib/client.js', 'utf8')
const start = source.indexOf('    function FanqieShelfPanel(')
const end = source.indexOf('    function DirectorySetting(', start)
const text = source.slice(start, end)
const book = (id, title) => ({ bookId: id, title, author: '测试作者', description: '简介正文', status: '连载中', chapterCount: 10, bookProgress: 0.2, group: '', lastReadAt: 0, addShelfTime: 0, lastOperateTime: 0 })
const result = (results, offset = 10, hasMore = false) => ({ ok: true, results, offset, hasMore })
let root, host, get, store, play, playBook, shelf, search, disc, categories, rank
const tick = async () => { await act(async () => {}) }
const findButton = (name) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === name)
async function click(name) { const b = findButton(name); expect(b, `button: ${name}`).toBeTruthy(); await act(async () => b.click()) }
async function input(value) {
  const el = document.querySelector('input[aria-label="搜索番茄全站"]')
  expect(el).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function submit(value) {
  if (value !== undefined) await input(value)
  const form = document.querySelector('form')
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
const titles = () => [...document.querySelectorAll('.dsh-music-fqcard-title')].map(e => e.textContent)

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  store = { tab: 'fqshelf', books: [], voices: [{ id: 'local:test:0', label: '测试音色', lang: '中文', gender: '女' }] }
  play = vi.fn(); playBook = vi.fn()
  shelf = { ok: true, available: true, total: 1, downloadedCount: 0, groups: ['正在看'], books: [book('1001', '书架小说')], libraryBooks: [] }
  search = vi.fn(async () => result([book('2001', '平台小说')]))
  disc = { ok: true, sections: [
    { key: 'editor', name: '编辑推荐', books: [book('3001', '推荐书甲'), book('3002', '推荐书乙')] },
    { key: 'update', name: '最近更新', books: [{ ...book('3003', '更新书'), chapterTitle: '第 9 章' }] },
  ] }
  categories = { ok: true, male: [{ id: '1141', name: '西方奇幻' }], female: [{ id: '1139', name: '古风世情' }] }
  rank = vi.fn(async url => {
    const u = new URL(url, 'http://localhost')
    const off = Number(u.searchParams.get('offset'))
    return { ok: true, total: 30, offset: off + 10, hasMore: off === 0, missing: 0, books: off === 0
      ? [{ ...book('4001', '榜首书'), rankPos: 1 }, { ...book('4002', '第二名'), rankPos: 2 }]
      : [{ ...book('4002', '第二名'), rankPos: 2 }, { ...book('4003', '第三名'), rankPos: 3 }] }
  })
  get = vi.fn((url, options) => url.startsWith('/dsh-music/book/') && url.endsWith('/meta')
    ? Promise.resolve({ ok: true, total: 3, totalChars: 30, sections: [{ heading: '第 1 章', textStart: 0 }, { heading: '第 2 章', textStart: 10 }], chapters: [{ heading: '第 1 章', fromChunk: 0 }, { heading: '第 2 章', fromChunk: 1 }], charOffsets: [0, 10, 20, 30] })
    : url.startsWith('/dsh-music/book/') && url.includes('/chapter?')
      ? Promise.resolve((() => {
          const idx = Number(new URL(url, 'http://localhost').searchParams.get('idx'))
          return { ok: true, index: idx, total: 2, heading: '第 ' + (idx + 1) + ' 章', from: idx, text: '第 ' + (idx + 1) + ' 章\n正文块' + idx }
        })())
      : url.startsWith('/dsh-music/book/') && url.includes('/text?from=')
      ? Promise.resolve({ ok: true, text: '正文块' + new URL(url, 'http://localhost').searchParams.get('from') })
      : url.startsWith('/dsh-music/fanqie/search') ? search(new URL(url, 'http://localhost'), options)
    : url.startsWith('/dsh-music/fanqie/discover') ? Promise.resolve(disc)
      : url.startsWith('/dsh-music/fanqie/rank/categories') ? Promise.resolve(categories)
        : url.startsWith('/dsh-music/fanqie/rank') ? rank(url, options)
          : Promise.resolve(shelf))
  const Panel = new Function('React', 'useState', 'useEffect', 'useRef', 'useStore', 'jsonGet', 'jsonPost', 'resumeOrPlayBook', 'playBook', 'portalToBody', 'set', 'loadPref', 'savePref', 'PREF_READER_POS', 'PREF_READER_THEME', text + '\nreturn FanqieShelfPanel;')(
    React, React.useState, React.useEffect, React.useRef, () => store, get, () => Promise.resolve({ ok: true }), play, playBook, node => createPortal(node, document.body), patch => Object.assign(store, patch), () => null, () => {}, 'dsh-music-reader-pos', 'dsh-music-reader-theme')
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(React.createElement(Panel, { panelRef: { current: host } })))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('番茄全站搜索界面', () => {
  it('区分书架过滤和全站搜索，空词不请求，输入后只在提交时搜索', async () => {
    expect(titles()).toEqual(['书架小说'])
    await click('搜全站')
    await submit('  ')
    expect(search).not.toHaveBeenCalled()
    await input('都市')
    expect(search).not.toHaveBeenCalled()
    await submit()
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0][0].searchParams.get('q')).toBe('都市')
    expect(titles()).toEqual(['平台小说'])
    await click('我的书架')
    expect(titles()).toEqual(['书架小说'])
    await click('搜全站')
    expect(titles()).toEqual(['平台小说'])
  })
  it('未安装下载器也能搜全站', async () => {
    shelf = { ok: true, available: false, books: [], total: 0, groups: [], libraryBooks: [] }
    await click('刷新书架')
    await click('搜全站'); await submit('都市')
    expect(titles()).toEqual(['平台小说'])
  })
  it('翻页使用已提交的词与服务端游标，并按书籍ID去重', async () => {
    search.mockImplementation(async u => Number(u.searchParams.get('offset')) === 0
      ? result([book('2001', '甲')], 17, true) : result([book('2001', '甲'), book('2002', '乙')], 27, false))
    await click('搜全站'); await submit('都市'); await input('仙侠'); await click('加载更多')
    expect(search.mock.calls[1][0].searchParams.get('q')).toBe('都市')
    expect(search.mock.calls[1][0].searchParams.get('offset')).toBe('17')
    expect(titles()).toEqual(['甲', '乙'])
    expect(findButton('加载更多')).toBeUndefined()
  })
  it('旧请求晚到不覆盖新词结果', async () => {
    let resolveOld
    search.mockImplementationOnce(() => new Promise(r => { resolveOld = r })).mockResolvedValueOnce(result([book('2002', '新结果')]))
    await click('搜全站'); await submit('旧词'); await submit('新词')
    expect(titles()).toEqual(['新结果'])
    await act(async () => resolveOld(result([book('2001', '旧结果')])))
    expect(titles()).toEqual(['新结果'])
  })
  it('分页失败保留结果，重试使用相同游标', async () => {
    search.mockResolvedValueOnce(result([book('2001', '甲')], 17, true))
      .mockResolvedValueOnce({ ok: false, error: '搜索超时' })
      .mockResolvedValueOnce(result([book('2002', '乙')], 27, false))
    await click('搜全站'); await submit('都市'); await click('加载更多')
    expect(titles()).toEqual(['甲'])
    expect(document.querySelector('[role="alert"]').textContent).toContain('搜索超时')
    await click('重试')
    expect(search.mock.calls[2][0].searchParams.get('offset')).toBe('17')
    expect(titles()).toEqual(['甲', '乙'])
  })
  it('空结果与请求失败是不同状态', async () => {
    search.mockResolvedValueOnce(result([], 0, false)).mockRejectedValueOnce(new Error('断网'))
    await click('搜全站'); await submit('空书')
    expect(document.body.textContent).toContain('没有找到')
    await submit('断网')
    expect(document.querySelector('[role="alert"]')).toBeTruthy()
    expect(document.body.textContent).not.toContain('没有找到')
  })
  it('断网提示中文且不把未完成搜索显示成零本', async () => {
    search.mockRejectedValue(new TypeError('Failed to fetch'))
    await click('搜全站'); await submit('都市')
    expect(document.querySelector('[role="alert"]').textContent).toContain('网络连接失败')
    expect(document.body.textContent).not.toContain('已显示 0 本')
  })
  it('复制完整书籍 ID，失败时保留可手选文本', async () => {
    const writeText = vi.fn().mockResolvedValueOnce().mockRejectedValueOnce(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await click('搜全站'); await submit('都市')
    await act(async () => document.querySelector('.dsh-music-fqcard').click())
    await click('复制书籍 ID')
    expect(writeText).toHaveBeenCalledWith('2001')
    expect(document.body.textContent).toContain('书籍 ID 已复制')
    await click('复制书籍 ID')
    expect(document.body.textContent).toContain('手动复制')
    expect(document.querySelector('.dsh-music-fqbook-id').textContent).toContain('2001')
    delete navigator.clipboard
  })
  it('对话框 Tab 不越出弹层', async () => {
    await act(async () => document.querySelector('.dsh-music-fqcard').click())
    const buttons = [...document.querySelectorAll('[role="dialog"] button')]
    buttons.at(-1).focus()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(buttons[0])
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(buttons.at(-1))
  })
  it('重复页不增长会停止翻页并说明原因', async () => {
    search.mockResolvedValue(result([book('2001', '甲')], 10, true))
    await click('搜全站'); await submit('都市'); await click('加载更多')
    expect(titles()).toEqual(['甲'])
    expect(findButton('加载更多')).toBeUndefined()
    expect(document.body.textContent).toContain('没有新书')
  })
  it('详情不虚构章节数，Esc关闭并归还焦点', async () => {
    search.mockResolvedValue(result([{ bookId: '2001', title: '无章数', author: '作者', description: '<script>不执行</script>', category: '都市', score: '8.5', status: '连载中' }]))
    await click('搜全站'); await submit('都市')
    const card = document.querySelector('.dsh-music-fqcard'); card.focus()
    await act(async () => card.click())
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy(); expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.textContent).toContain('8.5')
    expect(dialog.textContent).not.toMatch(/undefined|NaN|共 0 章/)
    expect(dialog.querySelector('script')).toBeNull()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(card)
  })
  it('下载书点卡片直接进阅读器，点听书才播放，并用刷新后的曲库', async () => {
    shelf.books = [{ ...book('1001', '书架小说'), downloaded: true, playId: 'fq:1001' }]
    shelf.libraryBooks = [{ id: 'fq:1001', name: '书架小说', url: '/dsh-music/book/fq:1001' }]
    await click('刷新书架')
    expect(store.books).toEqual(shelf.libraryBooks)
    search.mockResolvedValue(result([book('1001', '书架小说')]))
    await click('搜全站'); await submit('书架')
    await act(async () => document.querySelector('.dsh-music-fqcard').click())
    expect(play).not.toHaveBeenCalled()
    expect(document.querySelector('.dsh-music-fqreader-float')).toBeTruthy()
    await click('▶ 听书')
    expect(playBook).toHaveBeenCalledWith('fq:1001', 0)
  })
  it('刷新失败时保留旧书架但显示错误', async () => {
    shelf = { ok: false, error: '读取失败' }; await click('刷新书架')
    expect(titles()).toEqual(['书架小说'])
    expect(document.querySelector('[role="alert"]').textContent).toContain('读取失败')
  })
  it('已下载的书可阅读：章节正文、下一章、听书从当前块开始', async () => {
    shelf = { ...shelf, downloadedCount: 1, books: [{ ...book('1001', '书架小说'), downloaded: true, playId: 'fq:1001' }] }
    await click('刷新书架'); await tick()
    await act(async () => document.querySelector('.dsh-music-fqcard').click())
    await tick(); await tick()
    expect(document.querySelector('.dsh-music-fqreader-article').textContent).toContain('正文块0')
    const firstChapter = document.querySelector('.dsh-music-fqreader-section')
    expect(firstChapter.querySelector('.dsh-music-fqreader-ch').textContent).toBe('第 1 章')
    expect(firstChapter.querySelector('.dsh-music-fqreader-p').textContent).toBe('正文块0')
    expect(document.body.textContent).toContain('第 1 / 2 章')
    await click('下一章'); await tick(); await tick()
    expect(document.querySelector('.dsh-music-fqreader-article').textContent).toContain('正文块1')
    expect(document.body.textContent).toContain('第 2 / 2 章')
    await click('▶ 听书')
    expect(playBook).toHaveBeenCalledWith('fq:1001', 1)
    await act(async () => document.querySelector('button[aria-label="关闭阅读器"]').click())
    expect(document.querySelector('.dsh-music-fqreader-float')).toBeNull()
  })
  it('章节目录可跳转到指定章，且只列真正章节', async () => {
    shelf = { ...shelf, downloadedCount: 1, books: [{ ...book('1001', '书架小说'), downloaded: true, playId: 'fq:1001' }] }
    await click('刷新书架'); await tick()
    await act(async () => document.querySelector('.dsh-music-fqcard').click())
    await tick(); await tick()
    await click('目录')
    const items = [...document.querySelectorAll('.dsh-music-fqreader-toc-item')]
    expect(items.map(e => e.textContent)).toEqual(['1. 第 1 章', '2. 第 2 章'])
    await act(async () => items[1].click())
    await tick(); await tick()
    expect(document.querySelector('.dsh-music-fqreader-toc')).toBeNull()
    expect(document.querySelector('.dsh-music-fqreader-article').textContent).toContain('正文块1')
    expect(document.body.textContent).toContain('第 2 / 2 章')
  })
  it('自动续章按顺序追加，章节标题独立成行且不重复', async () => {
    const chapters = [
      { heading: '第 1 章', fromChunk: 0 },
      { heading: '第 2 章', fromChunk: 3 },
      { heading: '第 3 章', fromChunk: 6 },
    ];
    get.mockImplementation((url) => {
      if (url.endsWith('/meta')) return Promise.resolve({ ok: true, total: 9, totalChars: 90, sections: [], chapters, charOffsets: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90] });
      if (url.includes('/chapter?')) {
        const idx = Number(new URL(url, 'http://localhost').searchParams.get('idx'));
        return Promise.resolve({ ok: true, index: idx, total: 3, heading: chapters[idx].heading, from: idx * 3, text: chapters[idx].heading + '\n正文块' + idx });
      }
      return Promise.resolve(shelf);
    });
    shelf = { ...shelf, downloadedCount: 1, books: [{ ...book('1001', '书架小说'), downloaded: true, playId: 'fq:1001' }] };
    await click('刷新书架'); await tick();
    await act(async () => document.querySelector('.dsh-music-fqcard').click());
    for (let i = 0; i < 12; i++) await tick();
    const secs = [...document.querySelectorAll('.dsh-music-fqreader-section')];
    expect(secs.map((s) => s.dataset.index)).toEqual(['0', '1', '2']);
    expect(secs.map((s) => s.querySelector('.dsh-music-fqreader-ch').textContent)).toEqual(['第 1 章', '第 2 章', '第 3 章']);
    expect(secs[0].querySelector('.dsh-music-fqreader-p').textContent).toBe('正文块0');
    expect(document.body.textContent).toContain('第 1 / 3 章');
  })
  it('从番茄下载器回来（窗口重新获得焦点）自动刷新书架并匹配新书', async () => {
    await tick()
    const before = get.mock.calls.filter(([u]) => u === '/dsh-music/fanqie/shelf').length
    shelf = { ...shelf, downloadedCount: 1, books: [{ ...book('1002', '下载完成的书'), downloaded: true, playId: 'fq:1002' }] }
    await act(async () => window.dispatchEvent(new Event('focus')))
    await tick(); await tick()
    expect(get.mock.calls.filter(([u]) => u === '/dsh-music/fanqie/shelf').length).toBe(before + 1)
    expect(titles()).toEqual(['下载完成的书'])
  })
  it('发现页懒加载官方推荐，切走再回来不重复请求', async () => {
    expect(document.body.textContent).not.toContain('编辑推荐')
    await click('发现')
    expect(document.body.textContent).toContain('编辑推荐')
    expect(document.body.textContent).toContain('最近更新')
    expect(titles()).toEqual(['推荐书甲', '推荐书乙', '更新书'])
    const calls = get.mock.calls.filter(([u]) => u === '/dsh-music/fanqie/discover').length
    expect(calls).toBe(1)
    await click('我的书架'); await click('发现')
    expect(get.mock.calls.filter(([u]) => u === '/dsh-music/fanqie/discover').length).toBe(1)
  })
  it('推荐请求未返回就切到排行榜，回来不会卡在加载中', async () => {
    let resolveDisc
    get.mockImplementation((url, options) => url.startsWith('/dsh-music/fanqie/discover')
      ? new Promise(r => { resolveDisc = r })
      : url.startsWith('/dsh-music/fanqie/rank/categories') ? Promise.resolve(categories)
        : url.startsWith('/dsh-music/fanqie/rank') ? rank(url, options) : Promise.resolve(shelf))
    await click('发现'); await click('排行榜'); await tick(); await tick()
    expect(titles()).toEqual(['榜首书', '第二名'])
    await act(async () => resolveDisc(disc))
    await click('推荐')
    expect(titles()).toEqual(['推荐书甲', '推荐书乙', '更新书'])
    expect(document.body.textContent).not.toContain('正在读取番茄官方推荐')
  })
  it('排行榜默认女频阅读榜，显示名次，切换男频/新书榜/分类各自重载', async () => {
    await click('发现'); await click('排行榜')
    await tick(); await tick()
    expect(rank).toHaveBeenCalledTimes(1)
    let u = new URL(rank.mock.calls[0][0], 'http://localhost')
    expect([u.searchParams.get('gender'), u.searchParams.get('mold'), u.searchParams.get('category')]).toEqual(['0', '2', '1139'])
    expect(document.body.textContent).toContain('第 1 名')
    await click('男频'); await tick()
    u = new URL(rank.mock.calls.at(-1)[0], 'http://localhost')
    expect([u.searchParams.get('gender'), u.searchParams.get('category')]).toEqual(['1', '1141'])
    await click('新书榜'); await tick()
    u = new URL(rank.mock.calls.at(-1)[0], 'http://localhost')
    expect([u.searchParams.get('mold'), u.searchParams.get('category')]).toEqual(['1', '1141'])
    await act(async () => {
      const select = document.querySelector('select[aria-label="榜单分类"]')
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '1141')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await tick()
    expect(rank.mock.calls.at(-1)[0]).toContain('category=1141')
  })
  it('榜单滚动到底自动续页并按名次去重', async () => {
    await click('发现'); await click('排行榜'); await tick(); await tick()
    expect(titles()).toEqual(['榜首书', '第二名'])
    expect(findButton('加载更多')).toBeUndefined()
    const scroller = [...document.querySelectorAll('.dsh-music-fqscroll')].find((el) => el.textContent.includes('共 30 名'))
    expect(scroller).toBeTruthy()
    Object.defineProperty(scroller, 'scrollTop', { value: 900, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true })
    await act(async () => scroller.dispatchEvent(new Event('scroll', { bubbles: true })))
    await tick()
    expect(titles()).toEqual(['榜首书', '第二名', '第三名'])
    expect(document.body.textContent).toContain('已显示全部上榜书籍')
  })
  it('榜单分类读取失败可重试，成功后自动加载榜单', async () => {
    let calls = 0
    get.mockImplementation((url, options) => {
      if (url === '/dsh-music/fanqie/rank/categories') return Promise.resolve(calls++ === 0 ? { ok: false, error: '分类失败' } : categories)
      if (url.startsWith('/dsh-music/fanqie/rank')) return rank(url, options)
      if (url.startsWith('/dsh-music/fanqie/discover')) return Promise.resolve(disc)
      return Promise.resolve(shelf)
    })
    await click('发现'); await click('排行榜'); await tick(); await tick()
    expect(document.querySelector('[role="alert"]').textContent).toContain('分类失败')
    await click('重试'); await tick(); await tick()
    expect(titles()).toEqual(['榜首书', '第二名'])
  })
  it('榜单读取失败显示错误并可重试', async () => {
    rank.mockResolvedValueOnce({ ok: false, error: '上游限流' })
    await click('发现'); await click('排行榜'); await tick(); await tick()
    expect(document.querySelector('[role="alert"]').textContent).toContain('上游限流')
    await click('重试'); await tick()
    expect(titles()).toEqual(['榜首书', '第二名'])
  })
})
