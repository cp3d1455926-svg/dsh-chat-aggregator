#!/usr/bin/env node
// @jake26602/dsh-chat-aggregator CLI
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const command = args[0]

const COMMANDS = {
  setup: '配置向导 — 交互式添加聊天渠道',
  help:  '显示帮助信息',
  version: '显示版本号',
}

function showHelp() {
  console.log('')
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║  🤖 @jake26602/dsh-chat-aggregator                     ║')
  console.log('║  DSH 多平台聊天聚合器插件                                ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log('')
  console.log('用法:')
  console.log('  npx @jake26602/dsh-chat-aggregator <command>')
  console.log('')
  console.log('命令:')
  for (const [cmd, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${cmd.padEnd(12)} ${desc}`)
  }
  console.log('')
  console.log('示例:')
  console.log('  npx @jake26602/dsh-chat-aggregator setup')
  console.log('')
  console.log('安装:')
  console.log('  dsh plugin --profile web add @jake26602/dsh-chat-aggregator')
  console.log('')
  console.log('GitHub:')
  console.log('  https://github.com/cp3d1455926-svg/dsh-chat-aggregator')
  console.log('')
}

function showVersion() {
  const pkg = JSON.parse(
    await import('node:fs').then(fs =>
      fs.default.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    )
  )
  console.log(pkg.version)
}

switch (command) {
  case 'setup':
    await import('./setup.mjs')
    break
  case 'version':
  case '-v':
  case '--version':
    showVersion()
    break
  case 'help':
  case undefined:
  case '-h':
  case '--help':
  default:
    showHelp()
    break
}
