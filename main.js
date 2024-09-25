import fs from 'fs'
import commandLineArgs from 'command-line-args'

import { Node } from './src/index.js'

// Command line arguments
const args = commandLineArgs([
  { name: 'port', alias: 'p', type: Number },
  { name: 'join', type: String },
  { name: 'seed', type: String },
  { name: 'full', type: Boolean }
])

// Environment variables
const envs = {
  port: process.env.PORT,
  join: process.env.JOIN,
  seed: process.env.SEED,
  full: process.env.FULL === 'true'
}

const port = args.port ?? envs.port
const join = args.join ?? envs.join
const seed = args.seed ?? envs.seed
const full = args.full ?? envs.full

if (!join && !seed) {
  console.error('You must specify either a join key or a seed path')
  process.exit(1)
}

if (join && seed) {
  console.error('You cannot specify both a join key and a seed path')
  process.exit(1)
}

if (join && !/^[0-9a-f]{64}$/.test(join)) {
  console.error('Invalid key, must be 64 hex characters')
  process.exit(1)
}

if (seed && !fs.existsSync(seed)) {
  console.error(`Seed path "${seed}" does not exist`)
  process.exit(1)
}

if (seed && !fs.statSync(seed).isDirectory()) {
  console.error(`Seed path "${seed}" is not a directory`)
  process.exit(1)
}

const node = new Node(seed, join, port, full)

node.start().catch((err) => {
  console.error('Failed to start node:', err)
  process.exit(1)
})

// Teardown - Handle shutdown
let stopping = false
// Notice: running with npm will emit twice - TODO: mitigate
process.on('SIGINT', teardown)
process.on('SIGTERM', teardown)
async function teardown() {
  if (!stopping) {
    console.log('\rGracefully shutting down, press Ctrl+C again to force')
    stopping = true
    node.destroy()
  } else {
    console.log('\rForcing shutdown')
    process.exit(1)
  }
}
