import { describe, expect, it } from 'vitest'
import { pickBestSource, refererFor } from '../lib/unblock.js'

describe('解灰源择优', () => {
  it('多源结果取体积最大的完整曲，而不是先到的酷我试听', () => {
    const best = pickBestSource([
      { url: 'https://kw-er.kuwo.cn/a.mp3', source: 'kuwo', br: 128000, size: 185336 },
      { url: 'https://bd-er.kuwo.cn/b.mp3', source: 'bodian', br: 320000, size: 9147234 },
      { url: 'https://m801.music.126.net/c.mp3', source: 'pyncmd', br: 320000, size: 9147080 },
    ])
    expect(best.source).toBe('bodian')
    expect(best.preview).toBe(false)
    expect(best.referer).toBeUndefined()
  })
  it('只有小体积时如实标试听', () => {
    const best = pickBestSource([{ url: 'https://kw-er.kuwo.cn/a.mp3', source: 'kuwo', br: 128000, size: 185336 }])
    expect(best).toMatchObject({ source: 'kuwo', size: 185336, preview: true })
  })
  it('体积未知（0）排在已知体积之后；并列取码率高者', () => {
    expect(pickBestSource([
      { url: 'https://x/a', source: 'a', br: 999000, size: 0 },
      { url: 'https://x/b', source: 'b', br: 128000, size: 185336 },
    ]).source).toBe('b')
    expect(pickBestSource([
      { url: 'https://x/a', source: 'a', br: 128000, size: 500000 },
      { url: 'https://x/b', source: 'b', br: 320000, size: 500000 },
    ]).source).toBe('b')
  })
  it('过滤空 URL / 非法项；全空返回 null', () => {
    expect(pickBestSource([null, {}, { url: '' }, 'x'])).toBeNull()
    expect(pickBestSource([{ url: 'https://x/a', source: 'a', size: 10 }])).toMatchObject({ source: 'a', preview: true })
  })
  it('按直链主机名给 Referer（bodian 常回酷我 CDN）', () => {
    expect(refererFor('https://kw-er.kuwo.cn/a.mp3')).toBe('http://www.kuwo.cn/')
    expect(refererFor('https://bd-er.kuwo.cn/a.mp3')).toBe('http://www.kuwo.cn/')
    expect(refererFor('https://m801.music.126.net/a.mp3')).toBe('http://music.163.com/')
    expect(refererFor('https://webfs.tx.kugou.com/a.mp3')).toBe('https://www.kugou.com/')
    expect(refererFor('https://example.com/a.mp3')).toBe('')
    expect(refererFor('not a url')).toBe('')
  })
})
