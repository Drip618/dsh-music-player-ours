// 本地 TTS 冒烟测试（可重复跑的回归资产）：验证 sherpa-onnx + Kokoro 真能出声、且快于实时。
// 跑法：node tests/tts-smoke.mjs   （模型未下完时自动 SKIP，不报错）
// 产物 WAV 落 /tmp（一次性试听），测试脚本本身留在 tests/。
import { installedModels, listLocalVoices, defaultLocalVoice, synthesizeLocal, localTtsState } from '../lib/local-tts.js'
import { writeFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg) } else { fail++; console.log('  FAIL', msg) } }

const models = installedModels()
if (models.length === 0) {
  console.log('SKIP: 未检测到已安装的本地 TTS 模型（先跑 download-model.py 把模型下完）')
  console.log('状态:', localTtsState().reason)
  process.exit(0)
}

console.log('已安装模型:', models.map((m) => `${m.key} (${m.type})`).join(', '))
const kokoro = models.find((m) => m.type === 'kokoro')

if (kokoro) {
  const voices = listLocalVoices().filter((v) => v.model === kokoro.key)
  ok(voices.length === 103, `Kokoro 音色数 = ${voices.length}（期望 103）`)
  ok(voices.some((v) => v.sid === 3 && v.label === 'zf_001'), 'sid 3 = zf_001（中文女声）')
  ok(voices.some((v) => v.sid === 58 && v.label === 'zm_001'), 'sid 58 = zm_001（中文男声）')
  ok(defaultLocalVoice() === `local:${kokoro.key}:3`, `默认音色 = ${defaultLocalVoice()}`)
}

const voice = defaultLocalVoice()
const text = '你好，这是一段本地语音合成测试。今天我们来讲一个关于勇气与成长的故事。'
console.log(`合成测试：voice=${voice}，文本 ${text.length} 字`)
const t0 = Date.now()
let wav
try {
  wav = await synthesizeLocal(text, voice)
} catch (e) {
  console.log('  FAIL 合成抛错:', String(e && e.message || e))
  process.exit(1)
}
const wallMs = Date.now() - t0

ok(Buffer.isBuffer(wav) && wav.length > 44, `产出 WAV ${wav.length} 字节`)
ok(wav.slice(0, 4).toString() === 'RIFF' && wav.slice(8, 12).toString() === 'WAVE', 'WAV 头 RIFF/WAVE 正确')
const sampleRate = wav.readUInt32LE(24)
const channels = wav.readUInt16LE(22)
const bits = wav.readUInt16LE(34)
ok(channels === 1 && bits === 16, `单声道 16-bit（channels=${channels}, bits=${bits}）`)
ok(sampleRate >= 4000 && sampleRate <= 192000, `采样率 ${sampleRate} 在合法区间`)
const dataSize = wav.readUInt32LE(40)
const audioSec = dataSize / 2 / sampleRate
const rtf = audioSec / (wallMs / 1000)
console.log(`  音频时长 ${audioSec.toFixed(2)}s，合成耗时 ${wallMs}ms，RTF=${rtf.toFixed(2)}（>1 即快于实时）`)
ok(audioSec > 1, `音频时长 ${audioSec.toFixed(2)}s > 1s（确实出了声）`)
ok(rtf > 1, `RTF ${rtf.toFixed(2)} > 1（快于实时，M5 预期远高于 1）`)

const out = '/tmp/dsh-tts-smoke.wav'
writeFileSync(out, wav)
console.log('试听文件:', out)
console.log(`\n结果: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)