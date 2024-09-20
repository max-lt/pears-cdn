import express from 'express'
import DHT from 'hyperdht'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Localdrive from 'localdrive'
import MirrorDrive from 'mirror-drive'
import Corestore from 'corestore'
import mime from 'mime'

const args = process.argv.slice(2)

const port = parseInt(process.env.PORT) || 8080

const dht = new DHT()
const swarm = new Hyperswarm({ dht })

const app = express()

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

// Usage: npm start -- <share path|join key> [--port 8520]
switch (args[0]) {
  case 'share':
    {
      const path = args[1] ?? null
      if (!path) {
        console.error('No path specified')
        process.exit(1)
      }

      const store = new Corestore('./.corestore')
      await store.ready()

      const src = new Localdrive(path)
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
      app.listen(port, () => console.log(`Listening on http://localhost:${port}`))
    }
    break
  case 'join':
    {
      const key = args[1] ?? null
      if (!key) {
        console.error('No key specified')
        process.exit(1)
      }

      if (/^[0-9a-f]{64}$/.test(key) === false) {
        console.error('Invalid key')
        process.exit(1)
      }

      const store = new Corestore('/tmp/corestore-cli')
      await store.ready()

      const drive = new Hyperdrive(store, key)

      await drive.ready()
      console.log('drive.ready', drive.key.toString('hex'))

      swarm.on('error', (err) => console.error('Swarm error:', err))
      swarm.on('connection', (conn) => drive.replicate(conn))
      swarm.join(drive.discoveryKey)

      app.use(serveDrive(drive))
      app.listen(port, () => console.log(`Listening on http://localhost:${port}`))
    }
    break
  default:
    console.error('Invalid command')
    process.exit(1)
}

// Teardown - Handle shutdown
let stopping = false
process.on('SIGINT', teardown)
process.on('SIGTERM', teardown)
async function teardown() {
  if (!stopping) {
    console.log('Gracefully shutting down, press Ctrl+C again to force')
    stopping = true
    swarm.destroy()
  } else {
    console.log('Forcing shutdown')
    process.exit(1)
  }
}
