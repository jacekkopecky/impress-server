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

'use strict';

var WebSocketServer = require('ws').Server
var http = require('http')
var express = require('express')
var posix = require('posix')
var morgan  = require('morgan')
var fs = require('fs')

var app = express()

// standard apache logging to file http.log
var httplog = fs.createWriteStream('http.log', {flags: 'a', mode: 384 /* 0600 */ })
app.use(morgan('combined', {stream: httplog}))

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
if (nofilelimit.hard != null && nofilelimit.hard < desiredlimit) {
    desiredlimit = nofilelimit.hard;
}
posix.setrlimit('nofile', { soft: desiredlimit });
log({'log-msg': 'set nofile limit', 'limit': posix.getrlimit('nofile')});

var fiveMinutes = 5*60*1000
var extensions = [ "html", "css", "js", "ico" ]

app.use(express.static('jacek-soc', { maxAge: fiveMinutes, extensions: extensions}));
app.use(express.static('static', { maxAge: fiveMinutes, extensions: extensions }));

app.get('/api/status', function(req, res) {
    res.header('Content-Type', 'text/plain');
    res.send("server OK at  " + new Date() + "\r\n" +
             "running since " + startdate + "\r\n" +
             "processed " + requestcount + " requests");
})

var server1 = http.createServer(app);
server1.listen(8443);
var server2 = http.createServer(app);
server2.listen(8000);

var queues = {};
var nextClientID = 0;

// todo a lot of logging

var wsserver = function(ws) {
    var path = ws.upgradeReq.url;
    log({'log-msg': 'received connection for uri ' + path});

    // todo check that the path is of the form /impress-rc/escaped-uri/key

    // add the socket to a list by the path
    var queue = queues[path] || (queues[path] = {});
    var clients = queue.clients || (queue.clients = []);
    var clientID = nextClientID++;
    clients.push(ws);

    log({'log-msg': "clients length: " + clients.length});

    // send last message seen on this queue (if any)
    if (queue.lastMessageJSON != undefined) {
        ws.send(queue.lastMessageJSON);
    }

    // resend any message to all the clients, but check pwd
    // save latest message (w/o password)
    ws.on('message', function(data, flags) {
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
                    client.send(msgString);
                }
            });
            // confirm message by echoing it, with "self": "1"
            msg['self']=1;
            ws.send(JSON.stringify(msg));

        } catch (e) {
            log({'log-msg': "malformed message: " + e, data: data}, now);
            ws.send(JSON.stringify({cmd: 'error', error: "malformed message", data: data}));
        }
    });

    // todo maybe have an always-increasing msg-id for ordering semantics?

    ws.on('close', function() {
        log({'log-msg': 'a connection closed for uri ' + path});
        if (clients.indexOf(ws) != -1) {
            clients.splice(clients.indexOf(ws), 1);
            log({'log-msg': "clients length: " + clients.length});
            // remove the socket from its list, if the list is empty, remove that
            if (!clients.length) {
                delete queues[path];
                queue = undefined;
                clients = undefined;
            }
        } else {
            log({'log-msg': "connection for uri " + path + " not found in array clients"});
        }
    });
};

var wss1 = new WebSocketServer({server: server1});
var wss2 = new WebSocketServer({server: server2});
wss1.on('connection', wsserver);
wss2.on('connection', wsserver);
