/*
 * this is a server for my impress.js remote control and interactivity features
 *
 * author: Jacek Kopecký, jacek@jacek.cz, http://github.com/jacekkopecky
 *
 * current task
 * ------------
 * (none ongoing)
 */

'use strict';

const WebSocketServer = require('ws').Server;
const http = require('http');
const https = require('https');
const express = require('express');
const posix = require('posix');
const morgan  = require('morgan');
const fs = require('fs');
const serveIndex = require('serve-index');
const cors = require('cors');

const config = require('./config');


let credentials = {};

if (config.https) {
  console.log('reading ssl stuff');
  const httpsKey  = fs.readFileSync(config.httpsKey, 'utf8');
  const httpsCert = fs.readFileSync(config.httpsCert, 'utf8');
  credentials = { key: httpsKey, cert: httpsCert };
}


const app = express();

// standard apache logging to file http.log
const httplog = fs.createWriteStream('http.log', { flags: 'a', mode: 384 /* 0600 */ });
app.use(morgan('combined', { stream: httplog }));

// also tiny logging to console
app.use(morgan('tiny'));

let requestcount = 0;
const startdate = new Date();

// a simple request counter
app.use((req, res, next) => {
  requestcount += 1;
  return next();
});

const log = function (obj, now) {
  now = now || new Date();
  obj.logging_timestamp = now.toISOString();
  console.log(JSON.stringify(obj));
};


// raise maximum number of open file descriptors to 10k, hard limit is left unchanged
const nofilelimit = posix.getrlimit('nofile');
let desiredlimit = 10000;
if (nofilelimit.hard !== null && nofilelimit.hard < desiredlimit) {
  desiredlimit = nofilelimit.hard;
}
posix.setrlimit('nofile', { soft: desiredlimit });
// log({'log-msg': 'set nofile limit', 'limit': posix.getrlimit('nofile')});

const extensions = ['html', 'css', 'js', 'ico'];

// this is for WebScript, but should find a better place somewhere else
const messages = ['Ahoj!', 'Hi!', 'Cześć!', '¡Hola!', 'Ciao!', 'Servus!'];
app.use('/tmp/ws', cors());
app.use('/tmp/ws', express.static('static/tmp/ws', { maxAge: config.staticCacheTime, extensions }));
app.use('/tmp/ws', serveIndex('static/tmp/ws', { view: 'details' }));
app.use('/tmp/ws/dyn1', (req, res) => {
  const message = messages[Math.floor(Date.now()/5000) % messages.length];
  res.send(message + '\n' + new Date().toString());
});
app.use('/tmp/ws/dyn2', (req, res) => {
  res.send(JSON.stringify({ x: Math.round(Math.random()*200), y: Math.round(Math.random()*200) }));
});


app.use(express.static('jacek-soc', { maxAge: config.staticCacheTime, extensions }));
app.use(express.static('static', { maxAge: config.staticCacheTime, extensions }));

// this cannot go on the main public server as I don't want everything visible and linked
if (config.provideIndex) app.use('/', serveIndex('static', { view: 'details' }));

app.get('/api/status', (req, res) => {
  res.header('Content-Type', 'text/plain');
  res.send(`server OK at  ${new Date()}\r\n
running since ${startdate}\r\n
processed ${requestcount} requests`);
});

const server = http.createServer(app);
server.listen(8000);
console.log('server started on port 8000');

let servers = null;

if (config.https) {
  servers = https.createServer(credentials, app);
  servers.listen(8443);
  console.log('secure server started on port 8443');
}


const queues = {};
let nextClientID = 0;

// todo a lot of logging

const wsserver = function (ws, req) {
  const path = req.url;
  req = null; // we don't need it, let it be GCed
  // todo check that the path is of the form /impress-rc/escaped-uri/key

  // add the socket to a list by the path
  let queue = queues[path] || (queues[path] = {});
  const clients = queue.clients || (queue.clients = []);
  nextClientID += 1;
  const clientID = nextClientID;
  clients.push(ws);

  log({ 'log-msg': 'received connection for uri ' + path, clients: clients.length });

  // send last message seen on this queue (if any)
  if (queue.lastMessageJSON !== undefined) {
    ws.send(queue.lastMessageJSON);
  }

  // resend any message to all the clients, but check pwd
  // save latest message (w/o password)
  ws.on('message', (data) => {
    const now = new Date();
    log({ 'log-msg': 'message on path ' + path }, now);
    try {
      const msg = JSON.parse(data);
      msg['server-date'] = now.toISOString();
      msg['server-time-millis'] = now.getTime();
      msg['server-path'] = path;
      msg['client-id'] = clientID;

      if (msg.cmd !== 'form-data') {
        if (!queue.password && msg.password) {
          queue.password = msg.password;
          log({ 'log-msg': 'password received' }, now);
        } else if (!msg.password || queue.password !== msg.password) {
          log({ 'log-msg': 'wrong pwd, not sending msg ' + JSON.stringify(msg) }, now);
          ws.send(JSON.stringify({ cmd: 'error', error: 'wrong password', data }));
          return;
        }
      }

      // todo refactor, don't handle form-data like this
      // but the default cmd (if not present) must be 'goto' for old presentations

      delete msg.password;

      const msgString = JSON.stringify(msg);

      if (msg.cmd !== 'form-data' &&
                msg.cmd !== 'reset-form') {
        queue.lastMessageJSON = msgString;
      }

      // log message
      log({ msg }, now);

      clients.forEach((client) => {
        if (client !== ws) {
          client.send(msgString, () => {});
        }
      });
      // confirm message by echoing it, with "self": "1"
      msg.self=1;
      ws.send(JSON.stringify(msg), () => {});
    } catch (e) {
      log({ 'log-msg': 'malformed message: ' + e, data }, now);
      ws.send(JSON.stringify({ cmd: 'error', error: 'malformed message', data }));
    }
  });

  // todo maybe have an always-increasing msg-id for ordering semantics?

  ws.on('close', () => {
    log({ 'log-msg': 'a connection closed for uri ' + path, client: clientID, clients: clients.length - 1 });
    if (clients.indexOf(ws) !== -1) {
      clients.splice(clients.indexOf(ws), 1);
      // remove the socket from its list, if the list is empty, remove that
      if (!clients.length) {
        delete queues[path];
        queue = undefined;
        // clients = undefined;
      } else {
        const msg = {};
        const now = new Date();
        msg.cmd = 'client-gone';
        msg['client-id'] = clientID;
        msg['server-date'] = now.toISOString();
        msg['server-time-millis'] = now.getTime();
        msg['server-path'] = path;
        // log({msg: msg}, now);
        const msgString = JSON.stringify(msg);

        clients.forEach((client) => {
          client.send(msgString, () => {});
        });
      }
    } else {
      log({ 'log-msg': 'connection for uri ' + path + ' not found in array clients' });
    }
  });
};

const wss = new WebSocketServer({ server });
wss.on('connection', wsserver);

if (config.https) {
  const wsss = new WebSocketServer({ server: servers });
  wsss.on('connection', wsserver);
}
