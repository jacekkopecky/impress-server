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
 * (done) for a given path, accept the first password that comes, retire it after last client disconnects
 */

var WebSocketServer = require('ws').Server;
var http = require('http');
var express = require('express');
var app = express();
var posix = require('posix');

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

app.use(express.static('static'));

var server1 = http.createServer(app);
server1.listen(8443);
var server2 = http.createServer(app);
server2.listen(8000);

var queues = {};

// todo a lot of logging

wsserver = function(ws) {
    var path = ws.upgradeReq.url;
    log({'log-msg': 'received connection for uri ' + path});

    // todo check that the path is of the form /impress-rc/escaped-uri/key

    // add the socket to a list by the path
    var queue = queues[path] || (queues[path] = {});
    var clients = queue.clients || (queue.clients = []);
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
        var msg = {};
        try {
            msg = JSON.parse(data);
            msg['server-date'] = now.toISOString();
            msg['server-time-millis'] = now.getTime();
            msg['server-path'] = path;
            if (!queue.password) { 
                queue.password = msg.password; 
                log({'log-msg': 'password received', 'password': queue.password}, now);
            }
            else if (queue.password != msg.password) {
                log({'log-msg': "wrong pwd, not sending msg " + JSON.stringify(msg)}, now);
                ws.send(JSON.stringify({error: "wrong password", data: data}));
                return;
            }
            
            delete msg.password;
            queue.lastMessageJSON = JSON.stringify(msg);
            clients.forEach(function(client) {
                if (client != ws) {
                    client.send(queue.lastMessageJSON);
                }
            });
            // confirm message by echoing it, with "self": "1"
            msg['self']=1;
            ws.send(JSON.stringify(msg));

            // log message
            log(msg, now);
        } catch (e) {
            log({'log-msg': "malformed message: " + e}, now);
            ws.send(JSON.stringify({error: "malformed message", data: data}));
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
