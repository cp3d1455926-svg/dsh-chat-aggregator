# @dsh-community/dsh-chat-aggregator

> 多平台聊天聚合器插件 for DeepSeek Harness — 统一接入微信、钉钉、Telegram、Discord、Slack 到一个 DSH agent 会话

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    DSH Agent Session                         │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Telegram    │  │   DingTalk   │  │   Discord    │ ...  │
│  │   Adapter     │  │   Adapter    │  │   Adapter    │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                  │                  │               │
│         └──────────┬───────┴──────────┬──────┘               │
│                    │                  │                       │
│         ┌──────────▼──────────────────▼──────┐               │
│         │         Message Router              │               │
│         │   (dedup, session mgmt, routing)    │               │
│         └──────────────────┬─────────────────┘               │
│                            │                                 │
│         ┌──────────────────▼─────────────────┐               │
│         │       DSH apiProxy Transport        │               │
│         │   (session.prompt, events.mux)      │               │
│         └────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────┘
```

## 支持的平台

| 平台 | 类型 | 特殊能力 | SDK 依赖 |
|------|------|----------|----------|
| **Telegram** | `telegram` | Markdown, 编辑, 表情 | 无 (原生 API) |
| **钉钉** | `dingtalk` | Markdown, AI Card 流式 | `dingtalk-stream` |
| **Discord** | `discord` | 编辑, 表情, 嵌入 | `discord.js` |
| **Slack** | `slack` | Block Kit, 表情, 线程 | `@slack/bolt` |
| **微信** | `wechat` | 图片/文件收发 | `@ccchase/dsh-plugin-wechat` |
| **自定义** | `custom` | Webhook 接入 | 无 |

## 安装

### 步骤 1: 安装包

```bash
# 通过 dsh plugin 命令安装（推荐）
dsh plugin --profile web add @dsh-community/dsh-chat-aggregator

# 或通过 pnpm 安装
cd ~/.dsh/profiles/web
pnpm add @dsh-community/dsh-chat-aggregator
```

### 步骤 2: 挂载插件行

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，添加插件行：

```yaml
- insert:
    - id: chat-aggregator
      name: '@dsh-community/dsh-chat-aggregator'
      config:
        autoStart: true
        channels: []
```

## 快速开始

### 1. 运行配置向导

```bash
npx @dsh-community/dsh-chat-aggregator setup
```

### 2. 或手动配置

在你的 DSH profile cordis.yml 中添加：

```yaml
- id: chat-aggregator
  name: "@dsh-community/dsh-chat-aggregator"
  config:
    autoStart: true
    mediaEnabled: true
    channels:
      - id: main-telegram
        type: telegram
        enabled: true
        config:
          botToken: "${TELEGRAM_BOT_TOKEN}"
        requireMention: false
        allowedUsers: ["*"]

      - id: main-dingtalk
        type: dingtalk
        enabled: true
        config:
          clientId: "${DINGTALK_CLIENT_ID}"
          clientSecret: "${DINGTALK_CLIENT_SECRET}"
        requireMention: true
        mentionPatterns:
          - "^小助"
          - "@小助手"

      - id: main-discord
        type: discord
        enabled: true
        config:
          botToken: "${DISCORD_BOT_TOKEN}"
        requireMention: true
```

### 3. 设置环境变量

```bash
# Telegram
export TELEGRAM_BOT_TOKEN="your-token"

# 钉钉
export DINGTALK_CLIENT_ID="your-client-id"
export DINGTALK_CLIENT_SECRET="your-client-secret"

# Discord
export DISCORD_BOT_TOKEN="your-bot-token"

# Slack
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
```

## 配置参考

### 全局配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `autoStart` | boolean | `true` | 启动时自动运行所有已启用渠道 |
| `mediaEnabled` | boolean | `true` | 媒体收发总开关 |
| `mediaInboxDir` | string | `<cwd>/.chat-aggregator-inbox` | 媒体接收目录 |
| `maxMediaBytes` | number | `50MB` | 单条媒体大小上限 |
| `dedupWindowMs` | number | `30000` | 消息去重窗口 |
| `dshBaseUrl` | string | `http://127.0.0.1:3080` | DSH API 地址 |
| `defaultCwd` | string | - | 默认会话工作目录 |
| `defaultAgentPreset` | string | `standard` | 默认 agent preset |

### 渠道配置

每个渠道条目：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 渠道唯一标识 |
| `type` | string | 渠道类型（见支持平台表） |
| `enabled` | boolean | 是否启用 |
| `label` | string | 显示名称 |
| `config` | object | 平台特定配置 |
| `requireMention` | boolean | 群聊需要 @mention |
| `mentionPatterns` | string[] | @mention 正则模式 |
| `allowedUsers` | string[] | 允许的用户 ID（`*` = 所有人） |
| `cwd` | string | 该渠道的会话工作目录 |
| `agentPreset` | string | 该渠道使用的 agent preset |

## 媒体指令

Agent 回复中可以使用 `MEDIA:` 指令发送文件：

```
这是回复文本。

MEDIA:/path/to/image.png
MEDIA:https://example.com/report.pdf
MEDIA:./relative/path/file.docx
```

- `MEDIA:` 必须独占一行
- 支持绝对路径、相对路径、HTTP URL
- 指令行不会显示给用户
- 文本会随第一个成功的媒体一起发送

## 自定义适配器

实现 `ChannelAdapter` 接口即可创建自定义适配器：

```javascript
import { ChannelAdapter } from '@dsh-community/dsh-chat-aggregator/lib/core/channel-adapter.js'

export class MyAdapter extends ChannelAdapter {
  async start({ sessionId, onMessage, signal }) {
    // 连接平台，收到消息时调用 onMessage
    onMessage({
      channelId: this.id,
      channelType: 'my-platform',
      senderId: 'user-123',
      senderName: 'Alice',
      text: 'Hello!',
      chatId: 'chat-456',
      chatName: 'General',
      isGroup: true,
      isMentioned: true,
      media: [],
      timestamp: Date.now(),
    })
  }

  async sendText(chatId, text, opts) {
    // 发送文本到平台
  }

  async sendMedia(chatId, media, opts) {
    // 发送媒体到平台
  }

  get capabilities() {
    return {
      text: true, images: true, files: false,
      audio: false, video: false, markdown: false,
      edit: false, react: false, maxMessageLength: 4096,
    }
  }
}
```

## 项目结构

```
dsh-chat-aggregator/
├── lib/
│   ├── index.js              # 插件入口 (apply, Config schema)
│   ├── core/
│   │   ├── channel-adapter.js # 适配器基类
│   │   ├── channel-registry.js# 适配器注册表
│   │   ├── message-router.js  # 消息路由器
│   │   └── dedup.js          # 消息去重
│   ├── adapters/
│   │   ├── wechat-adapter.js  # 微信适配器
│   │   ├── dingtalk-adapter.js# 钉钉适配器
│   │   ├── telegram-adapter.js# Telegram 适配器
│   │   ├── discord-adapter.js # Discord 适配器
│   │   ├── slack-adapter.js   # Slack 适配器
│   │   └── custom-adapter.js  # 自定义适配器
│   └── media/
│       ├── media-manager.js   # 媒体管理器
│       └── media-handler.js   # MEDIA: 指令解析
├── stubs/                     # DSH 运行时兼容桩
├── scripts/
│   └── setup.mjs              # 配置向导
├── skills/
│   └── chat-aggregator-setup/
│       └── SKILL.md           # Agent skill
├── package.json
└── README.md
```

## 设计参考

本插件的设计参考了：

- **Hermes Agent Platform Plugins** (`D:\hermes\hermes-agent\plugins\platforms`) — Python 平台适配器模式，包括 BasePlatformAdapter、MessageEvent、平台注册表等
- **@ccchase/dsh-plugin-wechat** — DSH 插件架构，包括 cordis apply() 模式、apiProxy transport、Zod 配置 schema

## License

MIT
