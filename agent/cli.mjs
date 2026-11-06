#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { CaptureAgent } from './runtime.mjs'

const agent = new CaptureAgent({ onProgress: (event) => process.stderr.write(JSON.stringify(event) + '\n') })
const controller = new AbortController()
process.on('SIGINT', () => controller.abort())
process.on('SIGTERM', () => controller.abort())

async function main() {
  const [command, input, ...args] = process.argv.slice(2)
  let result
  if (command === 'prepare') result = agent.prepare(JSON.parse(readFileSync(input, 'utf8')))
  else if (command === 'run' || command === 'resume') {
    if (args.length && (args.length !== 2 || args[0] !== '--max-shots')) throw new Error('Expected --max-shots <integer>')
    result = await agent.run(input, { maxShots: args.length ? Number(args[1]) : Infinity, signal: controller.signal })
  } else if (command === 'status') result = agent.status(input)
  else if (command === 'pause') result = agent.pause(input)
  else if (command === 'validate') result = await agent.validate(input)
  else throw new Error('Usage: node agent/cli.mjs prepare <task.json> | run/resume <taskId> [--max-shots N] | status/pause/validate <taskId>')
  process.stdout.write(JSON.stringify(result) + '\n')
  if (result.valid === false) process.exitCode = 1
}
main().catch((error) => {
  process.stderr.write(error.message + '\n')
  process.exitCode = 1
})
