# DSH 音乐听书播放器（增强 fork）

这是 `dsh-music-player` 的个人增强 fork。仓库包含**完整插件源码、测试和安装脚本**，不是补丁包；克隆后即可安装使用。

## 功能

- 番茄小说：书架、全站搜书、推荐、排行榜、分类、浮窗阅读器、章节目录与自动续章
- 本地 TTS：Kokoro / VITS / MeloTTS 等多档语音模型，按需下载
- 网易云：多源解灰兜底、心动漫游、歌单与播放
- 其他：QQ 音乐、酷狗、网络电台、AI 讲书、新闻播报、睡眠定时

## 安装（macOS）

前置：已安装 DeepSeek Harness 桌面端。脚本优先使用 DSH 自带的 Node；找不到时回退到系统 `node`。

```bash
git clone https://github.com/Drip618/dsh-music-player-ours.git
cd dsh-music-player-ours
```

先完全退出 DeepSeek Harness（Cmd+Q），然后：

```bash
zsh tools/install-local.sh
```

脚本会把本仓库以 `link:` 方式装进 `~/.dsh/profiles/desktop`。如果 profile 不在默认位置，可设置：

```bash
DSH_PROFILE="/path/to/profile" zsh tools/install-local.sh
```

重新打开 DeepSeek Harness，在「插件」里确认 `dsh-music-player` 已启用。

## 可选组件（不随仓库分发）

- **本地语音模型**：打开插件「系统配置 → 本地语音模型」，选择并下载；模型写入 `~/.dsh/music-tts-models/`，不会上传到仓库。
- **番茄小说下载器**：读取番茄书架/全本需要安装 `Fanqie Novel Downloader`；插件在未安装时会给出下载引导。番茄 App、书架数据和账号信息不在本仓库。
- **账号/Cookie/偏好**：只保存在本机，不随仓库分发。

## 更新

```bash
git pull origin ours
```

吸收上游新版：

```bash
tools/sync-upstream.sh
```

不要把提交推到 `upstream`（那是原作者仓库）。

## 隐私

仓库不包含：`node_modules/`、语音模型权重、番茄下载的书籍、Chrome/DSH 的 Cookie 或登录态、任何账号凭据。请不要把本机的 `~/.dsh` 配置或浏览器配置提交进来。
