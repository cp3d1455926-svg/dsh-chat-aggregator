# Chat Aggregator Setup

Setup and configure the multi-platform chat aggregator plugin for DeepSeek Harness.

## When to Use

Use this skill when the user wants to:
- Set up the chat aggregator plugin
- Configure messaging platform connections (WeChat, DingTalk, Telegram, Discord, Slack)
- Add a new chat channel to their DSH agent
- Troubleshoot channel connectivity
- Modify channel routing or mention gating rules

## Quick Setup

### 1. Install the plugin

```bash
dsh plugin --profile web add @dsh-community/dsh-chat-aggregator
```

### 2. Run the interactive setup

```bash
npx @dsh-community/dsh-chat-aggregator setup
```

This will walk through adding each channel with its credentials.

### 3. Or configure manually

Create/edit `~/.dsh/chat-aggregator.json`:

```json
{
  "autoStart": true,
  "mediaEnabled": true,
  "channels": [
    {
      "id": "my-telegram",
      "type": "telegram",
      "enabled": true,
      "config": {
        "botToken": "your-token-here"
      },
      "requireMention": false,
      "allowedUsers": ["*"]
    }
  ]
}
```

### 4. Or configure in cordis.yml

```yaml
- id: chat-aggregator
  name: "@dsh-community/dsh-chat-aggregator"
  config:
    autoStart: true
    channels:
      - id: main-telegram
        type: telegram
        enabled: true
        config:
          botToken: "${TELEGRAM_BOT_TOKEN}"
        requireMention: false
      - id: main-dingtalk
        type: dingtalk
        enabled: true
        config:
          clientId: "${DINGTALK_CLIENT_ID}"
          clientSecret: "${DINGTALK_CLIENT_SECRET}"
        requireMention: true
```

## Channel Configuration Reference

### Telegram

| Field | Required | Description |
|-------|----------|-------------|
| botToken | ✅ | Bot token from @BotFather |
| baseUrl | ❌ | API base URL (default: https://api.telegram.org) |

### DingTalk

| Field | Required | Description |
|-------|----------|-------------|
| clientId | ✅ | App key from open-dev.dingtalk.com |
| clientSecret | ✅ | App secret |
| robotCode | ❌ | Robot code (default: same as clientId) |
| cardTemplateId | ❌ | AI Card template for streaming replies |

### Discord

| Field | Required | Description |
|-------|----------|-------------|
| botToken | ✅ | Bot token from Discord Developer Portal |

### Slack

| Field | Required | Description |
|-------|----------|-------------|
| botToken | ✅ | Bot token (xoxb-...) |
| appToken | ✅ | App token (xapp-...) for Socket Mode |

### WeChat

Requires `@ccchase/dsh-plugin-wechat` to be installed first for the WeChat vendor library.

| Field | Required | Description |
|-------|----------|-------------|
| accountId | ❌ | WeChat account ID (auto-discovered if omitted) |

## Features

- **Multi-platform**: WeChat, DingTalk, Telegram, Discord, Slack, Custom
- **Unified session**: All channels share one DSH agent session (or per-channel sessions)
- **Media support**: Send/receive images, files, video across platforms
- **Mention gating**: Only respond in groups when @mentioned
- **User allowlists**: Restrict who can talk to the bot
- **Message deduplication**: Prevent duplicate processing
- **Streaming replies**: Edit messages for real-time updates (platforms that support it)

## Troubleshooting

- **Channel not starting**: Check credentials and ensure platform SDK is installed
- **No replies**: Verify DSH is running and the session is accessible
- **Media not working**: Ensure `mediaEnabled: true` and the platform supports media
- **Group messages ignored**: Check `requireMention` and `mentionPatterns` config
