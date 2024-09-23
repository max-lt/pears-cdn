import express from 'express'
import DHT from 'hyperdht'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Localdrive from 'localdrive'
import MirrorDrive from 'mirror-drive'
import Corestore from 'corestore'
import mime from 'mime'

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
  }

  async start() {
    const app = express()
    const dht = new DHT()
    const swarm = new Hyperswarm({ dht })

    this._app = app
    this._dht = dht
    this._swarm = swarm

    const port = this._port || 8080

    // Seed
    if (this._seed) {
      const store = new Corestore('./.corestore')
      await store.ready()

      const src = new Localdrive(this._seed)
      await src.ready()

      const drive = new Hyperdrive(store)
      await drive.ready()
      console.log('Drive key', drive.key.toString('hex'))

      const mirror = new MirrorDrive(src, drive)
      await mirror.done()

      console.log(mirror.count)

      swarm.on('error', (err) => console.error('Swarm error:', err))
      swarm.on('connection', (conn) => drive.replicate(conn))
      const discovery = swarm.join(drive.discoveryKey)
      await discovery.flushed()

      app.use(serveDrive(drive))
    }

    // Join
    else if (this._join) {
      const key = Buffer.from(this._join, 'hex')

      const store = new Corestore('/tmp/corestore-cli')
      await store.ready()
      const foundPeers = store.findingPeers()

      const drive = new Hyperdrive(store, key)

      await drive.ready()
      console.log('Joining', drive.key.toString('hex'))

      swarm.on('error', (err) => console.error('Swarm error:', err))
      swarm.on('connection', (conn) => drive.replicate(conn))
      swarm.join(drive.discoveryKey)
      swarm.flush().then(() => foundPeers())

      app.use(serveDrive(drive))
    }

    this._server = app.listen(port, () => console.log(`Listening on http://localhost:${port}`))
  }

  async destroy() {
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
