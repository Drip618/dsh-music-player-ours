import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRelative = 'Library/Application Support/com.pofl.fanqienoveldownloader'
const originalState = join(homedir(), appRelative, 'rust_state.json')
const home = mkdtempSync(join(tmpdir(), 'dsh-fanqie-preview-'))
mkdirSync(join(home, appRelative), { recursive: true })
if (process.argv.includes('--local-shelf') && existsSync(originalState)) {
  const state = JSON.parse(readFileSync(originalState, 'utf8'))
  writeFileSync(join(home, appRelative, 'rust_state.json'), JSON.stringify({ official_bookshelf: state.official_bookshelf, reading_progress: state.reading_progress, download_jobs: state.download_jobs }))
} else {
  writeFileSync(join(home, appRelative, 'rust_state.json'), JSON.stringify({ official_bookshelf: { items: [], groups: [] } }))
}
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh')
const { apply } = await import('../lib/index.js')
let handler
const disposers = []
const info = p => {
  if (!existsSync(p)) return undefined
  const s = statSync(p)
  return { type: s.isDirectory() ? 'directory' : 'file', size: s.size }
}
apply({
  shell: { resolve: o => o, run: async () => ({ stdout: { text: home } }) },
  fs: {
    resolve: async p => resolve(p), stat: async p => info(p), processPath: p => resolve(p),
    listDir: async p => existsSync(p) ? readdirSync(p).map(name => ({ name, target: join(p, name), ...info(join(p, name)) })) : [],
    readBytes: async p => readFileSync(p),
  },
  webServer: { register: row => { if (row.kind === 'prefix' && row.path === '/dsh-music') handler = row.handler } },
  tools: { register() {} }, systemPrompt: { section() {} },
  effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') disposers.push(cleanup) },
})
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>番茄书架 · 隔离预览</title>
<style>
:root { color-scheme: dark; --dsw-alias-bg-overlay:#202226; --dsw-alias-bg-layer-1:#25272c; --dsw-alias-bg-layer-2:#2e3137; --dsw-alias-label-primary:#ebecef; --dsw-alias-label-secondary:#b3b6be; --dsw-alias-border-l1:#44474f; --dsw-alias-border-l2:#50545d; }
body { margin:0; background:#15171a; color:var(--dsw-alias-label-primary); font:14px -apple-system,BlinkMacSystemFont,sans-serif; }
header { padding:24px; display:flex; align-items:center; gap:18px; } header p { color:var(--dsw-alias-label-secondary); margin:0; } button,input,select { font:inherit; } header button { padding:8px; }
body.light { color-scheme:light; background:#f5f5f7; --dsw-alias-bg-overlay:#fff; --dsw-alias-bg-layer-1:#f7f7f9; --dsw-alias-bg-layer-2:#eeeef2; --dsw-alias-label-primary:#20232a; --dsw-alias-label-secondary:#5a606b; --dsw-alias-border-l1:#d4d7dc; --dsw-alias-border-l2:#c4c7cd; }
</style>
<header><strong>音乐播放器 · 隔离测试</strong><p>真实客户端 / 临时宿主数据</p><button id="theme">切换明暗</button></header><main id="root"></main>
<script>window.__qaErrors=[]; window.addEventListener('error',e=>window.__qaErrors.push(e.message)); window.addEventListener('unhandledrejection',e=>window.__qaErrors.push(String(e.reason))); document.querySelector('#theme').onclick=()=>document.body.classList.toggle('light'); window.__ModuleLoader__={load:d=>window.__pluginFactory=d.factory};</script>
<script>if(new URL(location.href).searchParams.get('auto')){(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));await s(900);const start=[...document.querySelectorAll('button')].find(b=>b.textContent==='开始使用');if(start)start.click();await s(300);const open=[...document.querySelectorAll('button')].find(b=>b.title==='打开播放列表');if(open)open.click();await s(400);const tab=[...document.querySelectorAll('.dsh-music-tab')].find(b=>b.textContent==='番茄书架');if(tab)tab.click();await s(500);const view=new URL(location.href).searchParams.get('view');if(view){const v=[...document.querySelectorAll('.dsh-music-qq-viewtab')].find(b=>b.textContent===view);if(v)v.click();}await s(600);const sub=new URL(location.href).searchParams.get('sub');if(sub){const b=[...document.querySelectorAll('.dsh-music-qq-viewtab')].find(x=>x.textContent===sub);if(b)b.click();}})();}</script>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/client.js"></script>
<script>
const entries=[]; const cleanups=[];
const plugin=window.__pluginFactory(name=>name==='react'?React:name==='react-dom'?ReactDOM:undefined);
plugin.apply({ get:name=>name==='slots'?{ inject:(name,fn)=>fn(), register:(meta,factory)=>{entries.push({id:meta.id,factory}); return ()=>{};}}:undefined, effect:fn=>{const c=fn(); if(typeof c==='function')cleanups.push(c);}});
ReactDOM.createRoot(document.querySelector('#root')).render(React.createElement(React.Fragment,null,...entries.map(e=>React.createElement(React.Fragment,{key:e.id},e.factory()))));
</script></html>`
const assets = {
  '/client.js': join(project, 'lib/client.js'),
  '/react.js': join(project, 'node_modules/react/umd/react.development.js'),
  '/react-dom.js': join(project, 'node_modules/react-dom/umd/react-dom.development.js'),
}
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return }
    if (assets[path]) { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(readFileSync(assets[path])); return }
    if (path.startsWith('/dsh-music')) { await handler(req, res); return }
    res.writeHead(404); res.end()
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })) }
})
server.listen(0, '127.0.0.1', () => console.log('Preview ready: http://127.0.0.1:' + server.address().port))
const close = () => { for (const dispose of disposers) dispose(); server.closeAllConnections(); server.close(); rmSync(home, { recursive: true, force: true }); process.exit(0) }
process.on('SIGTERM', close)
process.on('SIGINT', close)
