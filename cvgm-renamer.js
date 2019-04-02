#!/usr/bin/env node

const url = require('url')
const mkdirSync = require('fs').mkdirSync
const path = require('path')
const program = require('commander')
const tunnel = require('tunnel')
const ora = require('ora')()
const readline = require('readline')
const ms = require('ms')
const { filter } = require('fuzzaldrin')
const Interstice = require('interstice')
const Monitor = require('cvgm-monitor')

const { version, description } = require('./package.json')
const endpoint = 'theEndpoint'

program
  .description(description)
  .version(version, '-v, --version')
  .arguments('<url>')
  .option('-o, --output [dir]', 'output for recordings', './recordings')
  .option('-p, --proxy [proxy]', 'proxy', null)
  .option('-t, --timeout [ms]', 'milliseconds until connection timeout (0 will disable)', 0)
  .option('-r, --reconnect [ms]', 'milliseconds until reconnection (implies -t)', 4200)
  .action(recordCvgm)
  .parse(process.argv)

if (!process.argv.slice(2).length) {
  program.help()
}

function recordCvgm () {
  let agent = null
  let reconnect = program.reconnect
  if (program.proxy) {
    let proxyUrl = url.parse(program.proxy)
    agent = tunnel.httpOverHttp({
      proxy: {
        host: proxyUrl.hostname,
        port: proxyUrl.port
      }
    })
  }

  let outputRenamed = path.join(program.output, 'renamed')
  try {
    mkdirSync(program.output)
    mkdirSync(outputRenamed)
  } catch (e) {
    if (e.code !== 'EEXIST') {
      ora.fail(e.message)
      process.exit()
    }
  }

  let playedSongs = []
  let downloadedSongs = []

  let monitor = new Monitor()
  monitor
    .on('nowplaying', song => {
      ora.info(`monitor: now playing '${song.name}' [${song.id}]`)
      playedSongs.push(song)
    })
    .on('error', e => {
      ora.fail(`monitor: ${e.message}`)
    })

  let interstice = new Interstice({
    output: program.output,
    timeout: program.timeout,
    agent
  })
  let isConnected = false
  let connectionRetries = 0
  interstice
    .on('connection', () => {
      isConnected = true
      connectionRetries = 0
      ora.succeed(`interstice: connected to ${endpoint}`)
    })
    .on('song:start', title => {
      ora.start(`intersticer: downloading ${title}`)
    })
    .on('song:complete', title => {
      ora.succeed(`interstice: completed ${title}`)
      downloadedSongs.push(title)
      matchSongTitles()
    })
    .on('stop', () => {
      ora.info('interstice: exited gracefully')
      process.exit()
    })
    .on('error', e => {
      if (e instanceof Interstice.IntersticeError) {
        if ([ 'ConnectionError', 'DataTimeoutError' ].includes(e.name)) {
          let retriesMsg = connectionRetries++ > 0
            ? `(attempts: ${connectionRetries})`
            : ''
          ora.warn(`${e.message}, reconnecting in ${ms(reconnect, { long: true })} ${retriesMsg}`)
          isConnected = false
          setTimeout(rip, reconnect)
        }
      } else {
        ora.fail(`interstice: ${e.message}`)
      }
    })

  readline.emitKeypressEvents(process.stdin)
  process.stdin.setEncoding('utf8')
  process.stdin.setRawMode(true)
  process.stdin.on('keypress', key => {
    if (key !== '\u0003') { return }
    if (interstice.isStopped || !isConnected) {
      ora.stop()
      process.exit()
    }
    ora.info('press Ctrl+C again to quit immediately')
    monitor.disconnect()
    interstice.stop()
  })

  function matchSongTitles () {
    downloadedSongs.forEach(downloadTitle => {
      let playedTitle = filter(playedSongs, downloadTitle, { maxResults: 1 })
      ora.info('Matched:')
      ora.info(`\tdownloadTitle: ${downloadTitle}`)
      ora.info(`\tplayedTitle: ${playedTitle}`)
      if (playedTitle.size) {
        updateId3Tag()
      }
    })
  }

  function rip () {
    ora.start('Connecting...')
    interstice.start(endpoint)
    monitor.connect()
  }

  rip()
}
