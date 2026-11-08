/**
 * lib/local-tts.js — 本地快速 TTS（sherpa-onnx 引擎，进程内异步合成，无需常驻服务）。
 *
 * 这是我们 fork 的新增模块（上游没有）。设计目标：听小说即点即听、CPU 快于实时、
 * 不阻塞宿主事件循环（generateAsync）、不依赖任何外部 App/端口。
 *
 * 模型目录：~/.dsh/music-tts-models/<模型名>/（插件专属缓存，不动用户现有 AI-Models）。
 * 音色包导入：把一个 sherpa-onnx TTS 模型目录（含 model.onnx/voices.bin/tokens.txt 等）
 * 整个放进 ~/.dsh/music-tts-models/ 下即被自动识别——与 MultiTTS 导入神经音源包同理。
 *
 * 已支持：kokoro（v1.1-zh，103 音色，中文质量最佳）。
 * 预留：vits（如 aishell3，174 音色，极快）、zipvoice（零样本克隆，参考音频自定义音色）。
 *
 * 音色 id 编码：`local:<模型key>:<sid>`，例如 local:kokoro:3 = 中文女声 zf_001。
 * 与上游 MiMo 云端音色（白桦/茉莉…）共存：synthesize 见 local: 前缀走本地，否则走 MiMo。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// 模型目录按调用时解析：DSH/测试可能在模块加载后才设置 HOME，固定成常量会读到
// 开发者本机的模型（测试因此误判「已配置」，便携包也会指错目录）。
export function modelsRoot() {
  return join(os.homedir(), '.dsh', 'music-tts-models')
}
// 额外模型目录（用户在设置里填的其它磁盘路径）；默认目录永远排在第一位。
let modelRoots = []
export function setModelRoots(roots) {
  const extra = (Array.isArray(roots) ? roots : []).filter((p) => typeof p === 'string' && p.trim() !== '')
  modelRoots = [...new Set([modelsRoot(), ...extra])]
}
function activeRoots() {
  return modelRoots.length ? modelRoots : [modelsRoot()]
}

// ---- 可选模型目录（按需下载）---------------------------------------------
// 只列 sherpa-onnx 进程内能直接跑、且当前 local-tts 已有引擎配置的模型。
// sizeBytes 是必需文件的近似总量（不含 README/dict/espeak 等可选文件）。
// 下载器只取 files 里的文件；模型主文件用 as 归一化成 model.onnx / model.int8.onnx。
const FSTS = [
  { path: 'date.fst' }, { path: 'number.fst' }, { path: 'phone.fst' }, { path: 'new_heteronym.fst' },
]
const KOKORO_COMMON = [
  { path: 'tokens.txt' },
  { path: 'lexicon-gb-en.txt' }, { path: 'lexicon-us-en.txt' }, { path: 'lexicon-zh.txt' },
  { path: 'date-zh.fst' }, { path: 'number-zh.fst' }, { path: 'phone-zh.fst' },
]
export const MODEL_CATALOG = [
  {
    id: 'vits-zh-aishell3',
    name: 'VITS aishell3',
    repo: 'csukuangfj/vits-zh-aishell3',
    engine: 'vits',
    speakers: 174,
    language: '中文',
    gender: '',
    group: 'quick',
    quality: 2,
    speed: 5,
    sizeBytes: 42300000,
    note: '体积最小、速度最快；174 音色，机器感偏强。',
    files: [
      { path: 'vits-aishell3.int8.onnx', as: 'model.int8.onnx' },
      { path: 'tokens.txt' }, { path: 'lexicon.txt' }, ...FSTS,
    ],
  },
  {
    id: 'kokoro-int8-multi-lang-v1_1',
    name: 'Kokoro v1.1（默认）',
    repo: 'csukuangfj/kokoro-int8-multi-lang-v1_1',
    engine: 'kokoro',
    speakers: 103,
    language: '中英',
    gender: '',
    group: 'balanced',
    quality: 4,
    speed: 3,
    sizeBytes: 183000000,
    note: '当前默认；103 音色，中文自然，CPU 速度均衡。',
    files: [
      { path: 'model.int8.onnx' }, { path: 'voices.bin' }, ...KOKORO_COMMON,
    ],
  },
  {
    id: 'vits-melo-tts-zh_en-int8',
    name: 'MeloTTS 中英（轻量）',
    repo: 'csukuangfj/vits-melo-tts-zh_en',
    engine: 'vits',
    speakers: 1,
    language: '中英',
    gender: '女',
    group: 'quality',
    quality: 5,
    speed: 4,
    sizeBytes: 61000000,
    note: '单个女声；中英混读自然，体积小，性价比高。',
    files: [
      { path: 'model.int8.onnx' }, { path: 'tokens.txt' }, { path: 'lexicon.txt' }, ...FSTS,
    ],
  },
  {
    id: 'vits-melo-tts-zh_en-fp32',
    name: 'MeloTTS 中英（高精度）',
    repo: 'csukuangfj/vits-melo-tts-zh_en',
    engine: 'vits',
    speakers: 1,
    language: '中英',
    gender: '女',
    group: 'quality',
    quality: 5,
    speed: 3,
    sizeBytes: 178000000,
    note: '同一女声的 fp32 精度版；比 int8 慢，音质略有提升。',
    files: [
      { path: 'model.onnx' }, { path: 'tokens.txt' }, { path: 'lexicon.txt' }, ...FSTS,
    ],
  },
  {
    id: 'vits-zh-hf-fanchen-C',
    name: 'VITS 多音色库',
    repo: 'csukuangfj/vits-zh-hf-fanchen-C',
    engine: 'vits',
    speakers: 187,
    language: '中文',
    gender: '',
    group: 'quality',
    quality: 3,
    speed: 3,
    sizeBytes: 124000000,
    note: '187 个音色可挑；适合想换不同声线的人。',
    files: [
      { path: 'vits-zh-hf-fanchen-C.onnx', as: 'model.onnx' },
      { path: 'tokens.txt' }, { path: 'lexicon.txt' }, ...FSTS,
    ],
  },
  {
    id: 'kokoro-multi-lang-v1_1',
    name: 'Kokoro v1.1（fp32 大包）',
    repo: 'csukuangfj/kokoro-multi-lang-v1_1',
    engine: 'kokoro',
    speakers: 103,
    language: '中英',
    gender: '',
    group: 'large',
    quality: 4,
    speed: 2,
    sizeBytes: 394000000,
    note: '与默认版同一批 103 音色，fp32 精度；体积/内存更大，提升有限。',
    files: [
      { path: 'model.onnx' }, { path: 'voices.bin' }, ...KOKORO_COMMON,
    ],
  },
]

export function catalogModel(id) {
  return MODEL_CATALOG.find((m) => m.id === id) || null
}
export function formatModelSize(bytes) {
  const n = Number(bytes) || 0
  const gb = n / 1e9
  if (gb >= 1) return gb.toFixed(2) + ' GB'
  return Math.round(n / 1e6) + ' MB（' + gb.toFixed(2) + ' GB）'
}

// 下载完成后写进模型目录的元信息，供 installedModels/音色表读取。
export const MODEL_META_FILE = '.dsh-tts-model.json'
export function readModelMeta(dir) {
  try {
    const v = JSON.parse(readFileSync(join(dir, MODEL_META_FILE), 'utf8'))
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}


// ---- 模型探测 -------------------------------------------------------------
// 返回已安装且文件齐全的模型。type 决定用哪套 sherpa 配置。
function detectModel(dir) {
  const has = (f) => existsSync(join(dir, f))
  let files = []
  try { files = readdirSync(dir) } catch { return null }
  const anyOnnx = files.find((f) => /\.int8\.onnx$/i.test(f))
    || files.find((f) => /\.onnx$/i.test(f) && f[0] !== '.')
    || null
  const onnx = has('model.int8.onnx') ? 'model.int8.onnx' : has('model.onnx') ? 'model.onnx' : anyOnnx
  if (!onnx) return null
  const meta = readModelMeta(dir)
  // 下载器写入的元信息优先，避免把单音色 VITS 误判成 174 音色。
  if (meta && meta.engine === 'kokoro' && has('voices.bin') && has('tokens.txt')) {
    return { type: 'kokoro', onnx }
  }
  if (meta && meta.engine === 'matcha' && has('vocoder.onnx') && has('tokens.txt') && has('lexicon.txt')) {
    return { type: 'matcha', onnx }
  }
  if (meta && meta.engine === 'vits' && has('tokens.txt') && has('lexicon.txt')) {
    return { type: 'vits', onnx }
  }
  // matcha：声学模型 + 独立声码器 + tokens/lexicon
  if (has('vocoder.onnx') && has('tokens.txt') && has('lexicon.txt')) {
    return { type: 'matcha', onnx }
  }
  // kokoro：voices.bin + tokens.txt + lexicon-zh.txt
  if (has('voices.bin') && has('tokens.txt') && (has('lexicon-zh.txt') || has('lexicon-us-en.txt'))) {
    return { type: 'kokoro', onnx }
  }
  // vits：tokens.txt + lexicon.txt（aishell3/MeloTTS 等）
  if (has('tokens.txt') && has('lexicon.txt')) {
    return { type: 'vits', onnx }
  }
  return null
}

export function installedModels() {
  const out = []
  const seen = new Set()
  for (const root of activeRoots()) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      if (seen.has(name)) continue
      const det = detectModel(dir)
      if (det) {
        seen.add(name)
        const cat = catalogModel(name)
        const meta = readModelMeta(dir)
        out.push({
          key: name, dir, ...det,
          ...(cat ? {
            name: cat.name, speakers: cat.speakers, language: cat.language,
            gender: cat.gender, group: cat.group, quality: cat.quality,
            speed: cat.speed, sizeBytes: cat.sizeBytes, note: cat.note,
          } : {}),
          ...(meta || {}),
          catalog: !!cat,
        })
      }
    }
  }
  return out
}

// ---- 音色表 ---------------------------------------------------------------
// Kokoro v1.1-zh 权威映射（sherpa-onnx PR #1942）：
//   sid 0-2 英文女声；3-57 中文女声 zf_001..zf_055；58-102 中文男声 zm_001..zm_045。
const KOKORO_EN = ['af_maple', 'af_sol', 'bf_vale']
function kokoroVoices(modelKey, speakers) {
  const voices = []
  const n = Math.max(1, Math.min(103, Number(speakers) || 103))
  for (let sid = 0; sid < n; sid++) {
    let label, gender, lang
    if (sid <= 2) { label = KOKORO_EN[sid]; gender = '女'; lang = '英文' }
    else if (sid <= 57) { label = 'zf_' + String(sid - 2).padStart(3, '0'); gender = '女'; lang = '中文' }
    else { label = 'zm_' + String(sid - 57).padStart(3, '0'); gender = '男'; lang = '中文' }
    voices.push({ id: `local:${modelKey}:${sid}`, label, gender, lang, engine: 'local', model: modelKey, sid })
  }
  return voices
}

// vits：多音色（aishell3 174 / fanchen-C 187）按编号标；单音色（MeloTTS）给一个明确标签。
function vitsVoices(modelKey, numSpeakers, model = {}) {
  const n = Math.max(1, Number(numSpeakers) || 174)
  if (n === 1) {
    const gender = model.gender || ''
    return [{
      id: `local:${modelKey}:0`,
      label: gender ? ('默认' + gender + '声') : '默认音色',
      gender, lang: model.language || '中文', engine: 'local', model: modelKey, sid: 0,
    }]
  }
  const voices = []
  for (let sid = 0; sid < n; sid++) {
    voices.push({ id: `local:${modelKey}:${sid}`, label: `音色 ${sid}`, gender: model.gender || '', lang: model.language || '中文', engine: 'local', model: modelKey, sid })
  }
  return voices
}

export function isLocalVoice(id) { return typeof id === 'string' && id.startsWith('local:') }

export function parseLocalVoice(id) {
  const m = /^local:([^:]+):(\d+)$/.exec(String(id || ''))
  return m ? { model: m[1], sid: Number(m[2]) } : null
}

// ---- sherpa 实例缓存（懒加载，首次用才加载模型）---------------------------
let sherpa = null
function loadSherpa() {
  if (sherpa) return sherpa
  sherpa = require('sherpa-onnx-node')
  return sherpa
}
const ttsInstances = new Map() // modelKey -> Promise<OfflineTts>

function buildConfig(model) {
  const s = loadSherpa()
  const lex = []
  if (existsSync(join(model.dir, 'lexicon-us-en.txt'))) lex.push(join(model.dir, 'lexicon-us-en.txt'))
  if (existsSync(join(model.dir, 'lexicon-zh.txt'))) lex.push(join(model.dir, 'lexicon-zh.txt'))
  if (model.type === 'kokoro') {
    return {
      model: {
        kokoro: {
          model: join(model.dir, model.onnx),
          voices: join(model.dir, 'voices.bin'),
          tokens: join(model.dir, 'tokens.txt'),
          lexicon: lex.join(','),
        },
        debug: false,
        numThreads: 4,
        provider: 'cpu',
      },
      maxNumSentences: 1,
      silenceScale: 0.2,
    }
  }
  if (model.type === 'matcha') {
    return {
      model: {
        matcha: {
          acousticModel: join(model.dir, model.onnx),
          vocoder: join(model.dir, 'vocoder.onnx'),
          tokens: join(model.dir, 'tokens.txt'),
          lexicon: join(model.dir, 'lexicon.txt'),
        },
        debug: false,
        numThreads: 4,
        provider: 'cpu',
      },
      maxNumSentences: 1,
      silenceScale: 0.2,
    }
  }
  // vits
  return {
    model: {
      vits: {
        model: join(model.dir, model.onnx),
        tokens: join(model.dir, 'tokens.txt'),
        lexicon: join(model.dir, 'lexicon.txt'),
      },
      debug: false,
      numThreads: 4,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  }
}

async function getInstance(model) {
  let p = ttsInstances.get(model.key)
  if (!p) {
    const s = loadSherpa()
    p = s.OfflineTts.createAsync(buildConfig(model)).catch((err) => {
      ttsInstances.delete(model.key) // 失败可重试
      throw err
    })
    ttsInstances.set(model.key, p)
  }
  return p
}

// ---- 状态与音色清单 -------------------------------------------------------
export function localTtsState() {
  const models = installedModels()
  if (models.length === 0) {
    return { configured: false, reason: '未安装本地 TTS 模型。把 sherpa-onnx 模型目录放进 ~/.dsh/music-tts-models/ 即可（如 kokoro-int8-multi-lang-v1_1）。', models: [] }
  }
  return { configured: true, reason: '', models: models.map((m) => ({ key: m.key, type: m.type, name: m.name || m.key, speakers: m.speakers || 0 })) }
}

export function listLocalVoices() {
  const out = []
  for (const m of installedModels()) {
    if (m.type === 'kokoro') out.push(...kokoroVoices(m.key, m.speakers))
    else if (m.type === 'matcha') out.push(...vitsVoices(m.key, 1, m))
    else if (m.type === 'vits') out.push(...vitsVoices(m.key, m.speakers, m))
  }
  return out
}

export function forgetModel(key) {
  ttsInstances.delete(key)
}

// ---- WAV 编码（16-bit PCM 单声道）-----------------------------------------
function encodeWav(samples, sampleRate) {
  const numSamples = samples.length
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < numSamples; i++) {
    let v = samples[i]
    if (v > 1) v = 1; else if (v < -1) v = -1
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  return buf
}

// ---- 合成 -----------------------------------------------------------------
// 返回 wav Buffer。voiceId 形如 local:kokoro:3。speed 默认 1.0。
export async function synthesizeLocal(text, voiceId, opts = {}) {
  const parsed = parseLocalVoice(voiceId)
  if (!parsed) throw new Error('无效的本地音色 id：' + voiceId)
  const model = installedModels().find((m) => m.key === parsed.model)
  if (!model) throw new Error('本地模型未安装：' + parsed.model)
  const tts = await getInstance(model)
  const s = loadSherpa()
  const generationConfig = new s.GenerationConfig({
    sid: parsed.sid,
    speed: typeof opts.speed === 'number' ? opts.speed : 1.0,
    silenceScale: 0.2,
  })
  // Electron 的 V8 沙箱禁止 native addon 返回 external ArrayBuffer（宿主运行时
  // 会报 "TTS settlement failed"）。sherpa 支持关掉它改用普通 ArrayBuffer。
  const audio = await tts.generateAsync({ text, generationConfig, enableExternalBuffer: false })
  if (!audio || !audio.samples || audio.samples.length === 0) {
    throw new Error('本地 TTS 未产出音频')
  }
  return encodeWav(audio.samples, audio.sampleRate)
}

// 默认本地音色（首个中文女声）；无模型时返回 null。
export function defaultLocalVoice() {
  const models = installedModels()
  const kokoro = models.find((m) => m.type === 'kokoro')
  if (kokoro) return `local:${kokoro.key}:3` // zf_001
  const matcha = models.find((m) => m.type === 'matcha')
  if (matcha) return `local:${matcha.key}:0`
  const vits = models.find((m) => m.type === 'vits')
  if (vits) return `local:${vits.key}:0`
  return null
}