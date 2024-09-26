import express from 'express'
import DHT from 'hyperdht' // https://docs.pears.com/building-blocks/hyperdht
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Localdrive from 'localdrive'
import Corestore from 'corestore'
import cors from 'cors'
import mime from 'mime'
import debounceify from 'debounceify'
import { watch } from 'fs'
import { now } from './util.js'

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

  console.info(now(), 'GET', req.path)

  drive
    .entry(req.path)
    .then((entry) => {
      if (!entry) {
        res.setHeader('Content-Type', 'text/plain')
        return res.status(404).send('Not found')
      }

      const etag = `W/"${entry.seq}"`

      if (req.headers['if-none-match'] === etag) {
        res.status(304).end()
        return
      }

      const stream = drive.createReadStream(req.path)
      res.setHeader('Content-Length', entry.value.blob.byteLength)
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600')
      res.setHeader('ETag', etag)
      res.setHeader('Content-Type', mime.getType(req.path))
      stream.on('error', (err) => console.error(now(), 'Stream error:', err))
      stream.pipe(res)
    })
    .catch((err) => {
      console.error(now(), 'Failed to serve', req.path, err)
      res.setHeader('Content-Type', 'text/plain')
      res.status(500).send('Internal server error')
    })
}

/**
 *
 * @param {PeerDiscovery} discovery
 * @param {AbortSignal} signal
 */
const startPeerRefresh = (discovery, signal) => {
  let t = null
  let p = discovery.swarm.connections.size // Previous connections count

  const refresh = debounceify(async () => {
    if (signal.aborted) {
      return
    }

    await discovery.refresh()

    const c = discovery.swarm.connections.size // Current connections count
    if (!!c ^ !!p) {
      console.info(now(), 'Discovery refreshed and found', c ? c : 'no', 'peers')
    }

    t = setTimeout(refresh, c ? 60_000 : 5_000)

    p = c
  })

  t = setTimeout(refresh, 60_000)

  signal.addEventListener('abort', () => clearTimeout(t))

  return refresh
}

export class Node {
  get isSeed() {
    return !!this._seed
  }

  get isReplica() {
    return !!this._join
  }

  get isFullReplica() {
    return !!this._join && this._full
  }

  /**
   * @param {String | null} seed - Path to seed directory
   * @param {String | null} join - Join key
   * @param {Number | null} port
   * @param {Boolean | null} full - Full replication - replica node will pull all data
   * @param {String | String[] | null} origin - Allowed origin for CORS
   */
  constructor(seed, join, port, full = false, origin = null) {
    this._seed = seed
    this._join = join
    this._port = port
    this._full = full

    const app = express()

    app.set('x-powered-by', false)

    if (origin) {
      app.use(cors({ origin, methods: 'GET' }))
    }

    /** @type {express.Application} */
    this._app = app
    /** @type {AbortController} */
    this._ac = new AbortController()

    /** @type {DHT | null} */
    this._dht = null
    /** @type {Hyperswarm | null} */
    this._swarm = null
    /** @type {import('http').Server | null} */
    this._server = null
  }

  async start() {
    const dht = new DHT()
    const swarm = new Hyperswarm({ dht })

    await dht.ready()

    this._dht = dht
    this._swarm = swarm

    const app = this._app
    const port = this._port || 8080
    const signal = this._ac.signal

    // Seed
    if (this._seed) {
      const store = new Corestore(CORESTORE_SEED_PATH)
      await store.ready()

      const drive = new Hyperdrive(store)
      await drive.ready()
      console.info(now(), 'Drive key', drive.key.toString('hex'))

      const mirror = debounceify(async () => {
        const src = new Localdrive(this._seed)
        await src.ready()

        const mirror = src.mirror(drive)
        await mirror.done()

        console.info(now(), 'Mirror', mirror.count)
      })

      await mirror()

      swarm.on('error', (err) => console.error(now(), 'Swarm error:', err))
      swarm.on('connection', (conn) => drive.replicate(conn))
      const discovery = swarm.join(drive.discoveryKey, { client: false, server: true })
      await discovery.flushed()

      // Watch for changes
      watch(this._seed, { signal, recursive: true }, mirror)

      app.use(serveDrive(drive))
    }

    // Replica
    else if (this._join) {
      const key = Buffer.from(this._join, 'hex')

      const store = new Corestore(CORESTORE_JOIN_PATH)
      await store.ready()
      const foundPeers = store.findingPeers()

      const drive = new Hyperdrive(store, key)

      await drive.ready()
      console.info(now(), 'Joining', drive.key.toString('hex'))

      swarm.on('error', (err) => console.error(now(), 'Swarm error:', err))
      swarm.on('connection', (conn) => drive.replicate(conn))
      const discovery = swarm.join(drive.discoveryKey, { client: true, server: true })
      swarm.flush().then(() => foundPeers())

      // https://docs.pears.com/building-blocks/hypercore#core.update
      // This won't resolve until either
      // - The first peer is found
      // - No peers could be found
      const updated = await drive.core.update({ wait: true })
      console.info(now(), 'Core length is', drive.core.length)
      if (!drive.core.peers.length && !drive.core.length) {
        console.warn(now(), 'No peers found to initialize drive')
        console.warn(now(), 'This program will now stop')
        return await this.destroy().then(() => process.exit(1))
      }

      console.info(now(), 'Core', updated ? 'updated' : 'was up to date')

      if (this._full) {
        console.info(now(), 'Full replication enabled, pulling all data, this may take a while...')

        await drive.download()

        console.info(now(), 'Download complete')
      }

      // Watch for new peers
      const refresh = startPeerRefresh(discovery, signal)
      drive.core.on('peer-remove', () => {
        // If no peers are left, refresh immediately
        if (!discovery.swarm.connections.size && !signal.aborted) {
          console.warn(now(), 'No peers left, refreshing discovery')
          refresh()
        }
      })

      app.use(serveDrive(drive))
    }

    const url = PROXY_URL || `http://localhost:${port}`
    this._server = app.listen(port, () => console.log(now(), `Listening on ${url}`))
  }

  async destroy() {
    this._ac.abort()

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
