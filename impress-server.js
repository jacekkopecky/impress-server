/*
 * this is a server for impress.js remote control and interactivity features
 *
 * author: Jacek Kopecký, jacek@jacek.cz, http://github.com/jacekkopecky
 *
 * for impress.js, see http://github.com/bartaz/impress.js
 *
 * as of 2014-06-17, the remote control package hasn't actually been put on
 * github yet, and no interactivity features have been written, sorry about
 * that, it's all coming
 *
 * current task
 * ------------
 * (none ongoing)
 */

/* jshint node:true, asi:true, sub: true */

'use strict';

var WebSocketServer = require('ws').Server;
var http = require('http');
var https = require('https');
var express = require('express');
var responseTime = require('response-time');
var statsd = require('node-statsd');
var posix = require('posix');
var morgan  = require('morgan');
var fs = require('fs');
var serveIndex = require('serve-index');

var config = require('./config');

var stats = new statsd(config.statsd);


var credentials = {};

if (config.https) {
  console.log("reading ssl stuff");
  let httpsKey  = fs.readFileSync(config.httpsKey, 'utf8');
  let httpsCert = fs.readFileSync(config.httpsCert, 'utf8');
  credentials = {key: httpsKey, cert: httpsCert};
}


var app = express()

// standard apache logging to file http.log
var httplog = fs.createWriteStream('http.log', {flags: 'a', mode: 384 /* 0600 */ })
app.use(morgan('combined', {stream: httplog}))

app.use(responseTime(function(req,res,time) {
  var stat = 'http.' + req.method.toLowerCase() + '.';
  var timingStat = stat +
    req.url.toLowerCase()
           .replace(/[:\.]/g, '')
           .replace(/^\/+|\/+$/g, '')
           .split('/', 3)
           .join('.');
  stats.timing(timingStat, time);

  var counterStat = stat +
    req.url.toLowerCase()
           .replace(/[:\.]/g, '')
           .replace(/^\/+|\/+$/g, '')
           .split('/')
           .join('.');

  stats.increment(counterStat);
}));

// also tiny logging to console
app.use(morgan('tiny'))

var requestcount = 0;
var startdate = new Date();

// a simple request counter
app.use(function(req, res, next) {
    requestcount++
    return next()
})

var log = function(obj, now) {
    now = now || new Date();
    obj.logging_timestamp = now.toISOString();
    console.log(JSON.stringify(obj));
}


// raise maximum number of open file descriptors to 10k, hard limit is left unchanged
var nofilelimit = posix.getrlimit('nofile');
var desiredlimit = 10000;
if (nofilelimit.hard !== null && nofilelimit.hard < desiredlimit) {
    desiredlimit = nofilelimit.hard;
}
posix.setrlimit('nofile', { soft: desiredlimit });
//log({'log-msg': 'set nofile limit', 'limit': posix.getrlimit('nofile')});

var extensions = [ "html", "css", "js", "ico" ]

app.use(express.static('jacek-soc', { maxAge: config.staticCacheTime, extensions: extensions}));
app.use(express.static('static', { maxAge: config.staticCacheTime, extensions: extensions }));

// this cannot go on the main public server as I don't want everything visible and linked
if (config.provideIndex) app.use('/', serveIndex('static', {view: 'details'}));

app.get('/api/status', function(req, res) {
    res.header('Content-Type', 'text/plain');
    res.send("server OK at  " + new Date() + "\r\n" +
             "running since " + startdate + "\r\n" +
             "processed " + requestcount + " requests");
})

app.use(function(req,res,next) { console.log(req); next(); });
var server = http.createServer(app);
server.listen(8000);
console.log('server started on port 8000');

if (config.https) {
  var servers = https.createServer(credentials, app);
  servers.listen(8443);
  console.log('secure server started on port 8443');
}


var queues = {};
var nextClientID = 0;

// todo a lot of logging and stats

var wsserver = function(ws) {
    stats.increment('ws.connection');
    var path = ws.upgradeReq.url;
    // todo check that the path is of the form /impress-rc/escaped-uri/key

    var counterStat = 'ws.connection.' +
      path.toLowerCase()
             .replace(/[:\.]/g, '')
             .replace(/^\/+|\/+$/g, '')
             .split('/')
             .join('.');
    stats.increment(counterStat);

    // add the socket to a list by the path
    var queue = queues[path] || (queues[path] = {});
    var clients = queue.clients || (queue.clients = []);
    var clientID = ws.clientID = nextClientID++;
    clients.push(ws);

    log({'log-msg': 'received connection for uri ' + path, 'clients': clients.length});

    // send last message seen on this queue (if any)
    if (queue.lastMessageJSON !== undefined) {
        ws.send(queue.lastMessageJSON);
    }

    // resend any message to all the clients, but check pwd
    // save latest message (w/o password)
    ws.on('message', function(data, flags) {
        stats.increment('ws.message');
        var now = new Date();
        log({'log-msg': "message on path " + path}, now);
        try {
            var msg = JSON.parse(data);
            msg['server-date'] = now.toISOString();
            msg['server-time-millis'] = now.getTime();
            msg['server-path'] = path;
            msg['client-id'] = clientID;

            if (msg.cmd !== 'form-data') {
                if (!queue.password && msg.password) {
                    queue.password = msg.password;
                    log({'log-msg': 'password received'}, now);
                }
                else if (!msg.password || queue.password != msg.password) {
                    log({'log-msg': "wrong pwd, not sending msg " + JSON.stringify(msg)}, now);
                    ws.send(JSON.stringify({cmd: 'error', error: "wrong password", data: data}));
                    return;
                }
            }

            // todo refactor, don't handle form-data like this
            // but the default cmd (if not present) must be 'goto' for old presentations

            delete msg.password;

            var msgString = JSON.stringify(msg);

            if (msg.cmd !== 'form-data' &&
                msg.cmd !== 'reset-form') {
                queue.lastMessageJSON = msgString;
            }

            // log message
            log({msg: msg}, now);

            clients.forEach(function(client) {
                if (client != ws) {
                    client.send(msgString, function(){});
                }
            });
            // confirm message by echoing it, with "self": "1"
            msg['self']=1;
            ws.send(JSON.stringify(msg), function(){});

        } catch (e) {
            log({'log-msg': "malformed message: " + e, data: data}, now);
            ws.send(JSON.stringify({cmd: 'error', error: "malformed message", data: data}));
        }
    });

    // todo maybe have an always-increasing msg-id for ordering semantics?

    ws.on('close', function() {
        log({'log-msg': 'a connection closed for uri ' + path, 'client': clientID, 'clients': clients.length - 1});
        if (clients.indexOf(ws) != -1) {
            clients.splice(clients.indexOf(ws), 1);
            // remove the socket from its list, if the list is empty, remove that
            if (!clients.length) {
                delete queues[path];
                queue = undefined;
                //clients = undefined;
            } else {
                var msg = {};
                var now = new Date();
                msg['cmd'] = 'client-gone';
                msg['client-id'] = clientID;
                msg['server-date'] = now.toISOString();
                msg['server-time-millis'] = now.getTime();
                msg['server-path'] = path;
                // log({msg: msg}, now);
                var msgString = JSON.stringify(msg);

                clients.forEach(function(client) {
                    client.send(msgString, function(error){});
                });
            }
        } else {
            log({'log-msg': "connection for uri " + path + " not found in array clients"});
        }
    });
};

var wss = new WebSocketServer({server: server});
wss.on('connection', wsserver);

if (config.https) {
    var wsss = new WebSocketServer({server: servers});
    wsss.on('connection', wsserver);
}
