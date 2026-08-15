#!/usr/bin/env node
// Chat Aggregator 配置向导
// 交互式引导用户配置各渠道的凭据和参数

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((r) => rl.question(q, r))

const CHANNEL_TYPES = [
  {
    id: 'wechat',
    name: '微信 (WeChat)',
    required: ['accountId'],
    optional: [],
    note: '需要先运行 npx @ccchase/dsh-plugin-wechat login 登录',
  },
  {
    id: 'dingtalk',
    name: '钉钉 (DingTalk)',
    required: ['clientId', 'clientSecret'],
    optional: ['robotCode', 'cardTemplateId'],
    note: '从 https://open-dev.dingtalk.com 获取应用凭据',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    required: ['botToken'],
    optional: ['baseUrl'],
    note: '从 @BotFather 获取 Bot Token',
  },
  {
    id: 'discord',
    name: 'Discord',
    required: ['botToken'],
    optional: [],
    note: '从 https://discord.com/developers 获取 Bot Token',
  },
  {
    id: 'slack',
    name: 'Slack',
    required: ['botToken', 'appToken'],
    optional: ['signingSecret'],
    note: '从 https://api.slack.com/apps 获取 Token',
  },
]

async function main() {
  console.log('')
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║       🤖 Chat Aggregator 配置向导                       ║')
  console.log('║       DeepSeek Harness 聊天聚合器插件                    ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log('')

  const channels = []

  while (true) {
    console.log('可用渠道类型:')
    CHANNEL_TYPES.forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.name}`)
    })
    console.log(`  0. 完成配置`)
    console.log('')

    const choice = await ask('选择要添加的渠道 (0-' + CHANNEL_TYPES.length + '): ')
    const idx = parseInt(choice, 10)

    if (idx === 0 || isNaN(idx)) break
    if (idx < 1 || idx > CHANNEL_TYPES.length) {
      console.log('❌ 无效选择')
      continue
    }

    const type = CHANNEL_TYPES[idx - 1]
    console.log(`\n── 配置 ${type.name} ──`)
    console.log(`   提示: ${type.note}\n`)

    const channel = {
      id: `${type.id}-${Date.now().toString(36)}`,
      type: type.id,
      enabled: true,
      config: {},
    }

    channel.label = (await ask(`   显示名称 [${type.name}]: `)).trim() || type.name

    for (const key of type.required) {
      const val = await ask(`   ${key} *: `)
      channel.config[key] = val.trim()
    }

    for (const key of type.optional) {
      const val = await ask(`   ${key} [可选]: `)
      if (val.trim()) channel.config[key] = val.trim()
    }

    const mention = (await ask('   群聊需要 @mention 才响应? (y/N): ')).trim().toLowerCase()
    channel.requireMention = mention === 'y' || mention === 'yes'

    channels.push(channel)
    console.log(`✅ ${channel.label} 已添加\n`)
  }

  if (channels.length === 0) {
    console.log('未添加任何渠道，退出。')
    rl.close()
    return
  }

  // 生成配置文件
  const config = {
    autoStart: true,
    mediaEnabled: true,
    dedupWindowMs: 30000,
    defaultAgentPreset: 'standard',
    channels,
  }

  const configDir = path.join(os.homedir(), '.dsh')
  const configFile = path.join(configDir, 'chat-aggregator.json')

  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8')

  console.log('')
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║ ✅ 配置已保存!                                           ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log('')
  console.log(`配置文件: ${configFile}`)
  console.log(`共 ${channels.length} 个渠道`)
  console.log('')
  console.log('使用方法:')
  console.log('  1. 在 DSH profile 的 cordis.yml 中添加插件')
  console.log('  2. 或通过 --patch 覆盖配置')
  console.log('')
  console.log('示例 cordis.yml:')
  console.log(`  - id: chat-aggregator
    name: "@dsh-community/dsh-chat-aggregator"
    config:
      channels:
        - id: main-telegram
          type: telegram
          enabled: true
          config:
            botToken: "\${TELEGRAM_BOT_TOKEN}"
          requireMention: false`)

  rl.close()
}

main().catch(console.error)
