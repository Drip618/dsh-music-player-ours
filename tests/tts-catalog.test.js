import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let home, LocalTts, Download

function fakeModel(name, meta, files = ['model.int8.onnx', 'tokens.txt', 'lexicon.txt']) {
  const dir = join(home, '.dsh', 'music-tts-models', name)
  mkdirSync(dir, { recursive: true })
  for (const f of files) writeFileSync(join(dir, f), '')
  if (meta) writeFileSync(join(dir, '.dsh-tts-model.json'), JSON.stringify(meta))
  return dir
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-tts-catalog-'))
  vi.stubEnv('HOME', home)
  vi.resetModules()
  LocalTts = await import('../lib/local-tts.js')
  Download = await import('../lib/tts-download.js')
  LocalTts.setModelRoots([])
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('本地 TTS 模型目录', () => {
  it('列出多档模型并标注体积/音色/引擎', () => {
    const ids = LocalTts.MODEL_CATALOG.map((m) => m.id)
    expect(ids).toEqual([
      'vits-zh-aishell3', 'kokoro-int8-multi-lang-v1_1', 'vits-melo-tts-zh_en-int8',
      'vits-melo-tts-zh_en-fp32', 'vits-zh-hf-fanchen-C', 'kokoro-multi-lang-v1_1',
    ])
    expect(LocalTts.catalogModel('vits-zh-aishell3').speakers).toBe(174)
    expect(LocalTts.catalogModel('vits-melo-tts-zh_en-int8').speakers).toBe(1)
    expect(LocalTts.formatModelSize(42300000)).toBe('42 MB（0.04 GB）')
    expect(LocalTts.formatModelSize(394000000)).toBe('394 MB（0.39 GB）')
    expect(LocalTts.formatModelSize(1200000000)).toBe('1.20 GB')
  })

  it('单音色模型只出一个音色，多音色模型按目录元信息出对应数量', () => {
    fakeModel('vits-melo-tts-zh_en-int8', { engine: 'vits', speakers: 1, language: '中英', gender: '女', name: 'MeloTTS' })
    fakeModel('vits-zh-hf-fanchen-C', { engine: 'vits', speakers: 187, language: '中文', name: '多音色库' }, ['model.onnx', 'tokens.txt', 'lexicon.txt'])
    const voices = LocalTts.listLocalVoices()
    expect(voices.filter((v) => v.model === 'vits-melo-tts-zh_en-int8')).toHaveLength(1)
    expect(voices.find((v) => v.model === 'vits-melo-tts-zh_en-int8').label).toBe('默认女声')
    expect(voices.filter((v) => v.model === 'vits-zh-hf-fanchen-C')).toHaveLength(187)
    expect(LocalTts.defaultLocalVoice()).toMatch(/^local:(vits-melo-tts-zh_en-int8|vits-zh-hf-fanchen-C):0$/)
  })

  it('目录状态把已下载模型标成 installed，未下载的保持可下载', () => {
    fakeModel('vits-melo-tts-zh_en-int8', { engine: 'vits', speakers: 1, language: '中英', gender: '女' })
    const state = Download.catalogWithState()
    const melo = state.models.find((m) => m.id === 'vits-melo-tts-zh_en-int8')
    const aishell = state.models.find((m) => m.id === 'vits-zh-aishell3')
    expect(melo.installed).toBe(true)
    expect(aishell.installed).toBe(false)
    expect(state.models).toHaveLength(6)
  })

  it('Matcha 声学模型 + 独立声码器能被识别为单音色模型', () => {
    fakeModel('matcha-icefall-zh-baker', { engine: 'matcha', speakers: 1, language: '中文', gender: '女' },
      ['model.onnx', 'vocoder.onnx', 'tokens.txt', 'lexicon.txt'])
    const m = LocalTts.installedModels().find((x) => x.key === 'matcha-icefall-zh-baker')
    expect(m.type).toBe('matcha')
    const voices = LocalTts.listLocalVoices().filter((v) => v.model === 'matcha-icefall-zh-baker')
    expect(voices).toHaveLength(1)
    expect(voices[0].label).toBe('默认女声')
  })

  it('未知模型/无任务不会误报成功', () => {
    expect(Download.startDownload('no-such-model').ok).toBe(false)
    expect(Download.cancelDownload().ok).toBe(false)
    expect(Download.deleteModel('no-such-model').ok).toBe(false)
  })
})
