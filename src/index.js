import express from 'express'
import DHT from 'hyperdht' // https://docs.pears.com/building-blocks/hyperdht
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Localdrive from 'localdrive'
import Corestore from 'corestore'
import mime from 'mime'
import { watch } from 'fs'
import debounceify from 'debounceify'

const PROXY_URL = process.env.PROXY_URL
const CORESTORE_SEED_PATH = process.env.CORESTORE_PATH || './.corestore.seed'
const CORESTORE_JOIN_PATH = process.env.CORESTORE_PATH || './.corestore.read'

/**
 * @param {Hyperdrive} drive
 * @returns {express.RequestHandler}
 */
const serveDrive = (drive) => (req, res, next) => {
  if (req.method !== 'GET') {
    return next()
  }

  if (req.path.endsWith('/')) {
    return res.redirect(req.path + 'index.html')
  }

  console.log('GET', req.path)

  drive
    .exists(req.path)
    .then((exists) => {
      if (!exists) {
        res.setHeader('Content-Type', 'text/plain')
        return res.status(404).send('Not found')
      }

      const stream = drive.createReadStream(req.path)
      res.setHeader('Content-Type', mime.getType(req.path))
      stream.pipe(res)
    })
    .catch((err) => {
      console.error(err)
      res.setHeader('Content-Type', 'text/plain')
      res.status(500).send('Internal server error')
    })
}

export class Node {
  get isSeed() {
    return !!this._seed
  }

  get isJoin() {
    return !!this._join
  }

  /**
   * @param {String | null} seed - Path to seed directory
   * @param {String | null} join - Join key
   * @param {Number | null} port
   */
  constructor(seed, join, port) {
    this._seed = seed
    this._join = join
    this._port = port

    /** @type {express.Application | null} */
    this._app = null
    /** @type {DHT | null} */
    this._dht = null
    /** @type {Hyperswarm | null} */
    this._swarm = null
    /** @type {import('http').Server | null} */
    this._server = null
    /** @type {AbortController | null} */
    this._ac = null
  }

  async start() {
    const app = express()
    const dht = new DHT()
    const swarm = new Hyperswarm({ dht })

    await dht.ready()

    this._ac = new AbortController()
    this._app = app
    this._dht = dht
    this._swarm = swarm

    const port = this._port || 8080

    // Seed
    if (this._seed) {
      const store = new Corestore(CORESTORE_SEED_PATH)
      await store.ready()

      const drive = new Hyperdrive(store)
      await drive.ready()
      console.log('Drive key', drive.key.toString('hex'))

      const mirror = debounceify(async () => {
        const src = new Localdrive(this._seed)
        await src.ready()

        const mirror = src.mirror(drive)
        await mirror.done()

        console.log('Mirror', mirror.count)
      })

      await mirror()

      swarm.on('error', (err) => console.error('Swarm error:', err))
      swarm.on('connection', (conn) => drive.replicate(conn))
      const discovery = swarm.join(drive.discoveryKey, { client: false, server: true })
      await discovery.flushed()

      // Watch for changes
      watch(path, { signal: this._ac.signal, recursive: true }, mirror)

      app.use(serveDrive(drive))
    }

    // Join
    else if (this._join) {
      const key = Buffer.from(this._join, 'hex')

      const store = new Corestore(CORESTORE_JOIN_PATH)
      await store.ready()
      const foundPeers = store.findingPeers()

      const drive = new Hyperdrive(store, key)

      await drive.ready()
      console.log('Joining', drive.key.toString('hex'))

      swarm.on('error', (err) => console.error('Swarm error:', err))
      swarm.on('connection', (conn) => drive.replicate(conn))
      swarm.join(drive.discoveryKey, { client: true, server: false })
      swarm.flush().then(() => foundPeers())

      // https://docs.pears.com/building-blocks/hypercore#core.update
      // This won't resolve until either
      // - The first peer is found
      // - No peers could be found
      const updated = await drive.core.update({ wait: true })
      console.info('Core length is', drive.core.length)
      if (!drive.core.peers.length && !drive.core.length) {
        console.warn('No peers found to initialize drive')
        console.warn('This program will now stop')
        return await this.destroy().then(() => process.exit(1))
      }

      console.log('Core', updated ? 'updated' : 'was up to date')

      app.use(serveDrive(drive))
    }

    const url = PROXY_URL || `http://localhost:${port}`
    this._server = app.listen(port, () => console.log(`Listening on ${url}`))
  }

  async destroy() {
    if (this._ac) {
      this._ac.abort()
    }

    if (this._server) {
      await new Promise((resolve) => this._server.close(resolve))
    }

    if (this._dht) {
      await this._dht.destroy()
    }

    if (this._swarm) {
      await this._swarm.destroy()
    }
  }
}
