const express = require('express')
const fs = require('fs')
const uuidv4 = require('uuid/v4')
const redis = require('redis')
const WebSocket = require('ws')
const shortid = require('shortid')
const sharp = require('sharp')
const PgClient = require('pg').Client
const cors = require('cors')
const {validPieces} = require('./valid-prizes')

const pgClient = new PgClient()
pgClient.connect()
const apiPort = process.env.API_PORT || 3001
const wsPort = process.env.WS_PORT || 3002
const app = express()
const redisClient = redis.createClient()
const redisSubscriber = redis.createClient()
const wss = new WebSocket.Server({port: wsPort})

const uuidWsMapping = {}
const wsAuthMapping = {}

wss.on('connection', function connection (ws) {
  // stats.increment('connect', 1)

  const eventMapping = {
    'auth': auth,
  }
  ws.on('message', function (msg) {
    const [eventName, payload] = msg.split('|')

    if (typeof eventMapping[eventName] !== 'function') {
      console.log('Error: Unknown client event emitted')
      return
    }

    eventMapping[eventName](payload)
  })

  function auth (authKey) {
    if (!authKey) {
      authKey = shortid.generate()
      ws.authKey = authKey
      wsAuthMapping[authKey] = ws

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`auth|${authKey}`)
      }

      // TODO add authKey to DB
    }

    // TODO check authKey against DB
  }

  function close () {
    //TODO iterate through uuidWsMapping and remove all the UUIDs that belong to that user
  }

  // handle graceful and ungraceful disconnects
  ws.on('close', close)
  ws.on('error', close)
})

redisSubscriber.subscribe(['crop-updates', 'ml-updates'])
const channelMapping = {
  'crop-updates': cropUpdate,
  'ml-updates':   mlUpdate,
}
redisSubscriber.on('message', function (channel, payload) {
  if (typeof channelMapping[channel] !== 'function') {
    console.log('Error: Unknown client event emitted')
    return
  }

  channelMapping[channel](payload)
})

function cropUpdate (payload) {
  const uuid = payload.split(':')[0]
  const client = uuidWsMapping[uuid]

  if (!client || client.readyState !== WebSocket.OPEN) {
    return
  }

  client.send(`crop-update|${payload}`)
}

async function mlUpdate (payload) {
  const uuid = payload.split('_')[0]
  const [pieceId, label] = payload.split(':')
  const client = uuidWsMapping[uuid]

  if (client && client.readyState === WebSocket.OPEN) {
    client.send(`ml-update|${payload}`)
  }

  // add image to db
  const res = await pgClient.query('INSERT INTO pieces (piece_id, machine_label) VALUES ($1::text, $2::text)', [pieceId, label])
}

function resize (uuid) {
  sharp(`image-uploads/original/${uuid}`)
    .resize(400)
    .rotate()
    .toFile(`image-uploads/resized/${uuid}.jpg`, (err, info) => {
      const client = uuidWsMapping[uuid]
      if (!client || client.readyState !== WebSocket.OPEN) {
        return
      }

      client.send(`resize-update|${uuid}`)
    })
}

app.use(cors())

app.post('/upload', function (req, res) {
  const authKey = typeof req.headers.authorization === 'string' && req.headers.authorization.split(' ')[1]
  const ws = wsAuthMapping[authKey]
  if (!ws) {
    res.sendStatus(401)
    return
  }

  const uuid = uuidv4()
  // TODO require auth header, the short id generated by initial connect to websocket
  uuidWsMapping[uuid] = ws
  const writeStream = fs.createWriteStream(`image-uploads/original/${uuid}`)
  req.on('end', () => {
    res.status(200).send(uuid)
    redisClient.lpush('crop-queue', uuid)
    // TODO create map of UUID -> owner auth, so we know where to send updates when received
    resize(uuid)
  }).pipe(writeStream)
})

app.get('/classify', async function (req, res) {
  // TODO add authentication and only allow classification from admins
  // res.sendStatus(401)
  // return

  const {piece, label} = req.query
  console.log(piece, label)

  if (piece && validPieces.includes(label.toLowerCase())) {
    await pgClient.query('update pieces set human_label = $1::text where piece_id = $2::text', [label, piece])
  }

  const data = await pgClient.query('select * from pieces where human_label is null limit 1')
  responseObject = data.rows[0] || {}
  res.send(responseObject)
})

app.use(express.static('image-uploads'))

app.listen(apiPort, function () {
  console.log(`listening on port ${apiPort}`)
})
