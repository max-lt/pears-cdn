# Using pears tools to serve static files over http

### Configuration

#### Environment variables / Command line arguments

- `PORT` / `--port` - The port to listen on. Default is 8080.
- `SEED` / `--seed` - The path to the seed directory. Required if `join` is not set.
- `JOIN` / `--join` - The drive key to join. Required if `seed` is not set.

> Note: Command line arguments take precedence over environment variables.

### Usage

#### Initialize a new drive

use the following command to initialize a new drive and output a drive key that can be used to share the drive.
```bash
node main.js --port 8080 --seed /path/to/seed
```

#### Connect to the drive

```bash
node main.js --port 8080 --join <drive-key>
```


#### With docker

docker build . -t pears-cdn

docker run -p 8080:8080 -e JOIN=<drive-key> pears-cdn
