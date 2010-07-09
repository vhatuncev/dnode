var net = require('net');
var sys = require('sys');
var BufferList = require('bufferlist').BufferList;
var Buffer = require('buffer').Buffer;
var EventEmitter = require('events').EventEmitter;
var io = require('socket.io');

exports.DNode = DNode;
function DNode (wrapper) {
    if (!(this instanceof DNode)) return new DNode(wrapper);
    if (wrapper === undefined) wrapper = {};
    var dnode = this;
    
    function firstTypes (args) {
        var types = {};
        [].concat.apply([],args).forEach(function (arg) {
            var t = typeof(arg);
            if (!(t in types)) types[t] = arg;
        });
        return types;
    }
    
    this.connect = function () {
        var types = firstTypes(arguments) || {};
        var kwargs = types.object || {};
        var host = types.string || kwargs.host;
        var port = types.number || kwargs.port;
        var block = types['function'] || kwargs.block;
        
        var conn = new DNodeConn({
            stream : net.createConnection(port, host),
            wrapper : wrapper,
        });
        conn.addListener('remote', function (remote) {
            block.call(remote, remote, conn);
        });
    };
    
    this.listen = function () {
        var types = firstTypes(arguments) || {};
        var kwargs = types.object || {};
        var proto = kwargs.protocol || 'socket';
        var block = types['function']
            || kwargs.block || function () {};
        
        if (proto == 'socket') {
            var host = types.string || kwargs.host;
            var port = types.number || kwargs.port;
            
            net.createServer(function (stream) {
                var conn = new DNodeConn({
                    stream : stream,
                    wrapper : wrapper,
                });
                conn.addListener('remote', function (remote) {
                    block.call(remote, remote, conn);
                });
            }).listen(port, host);
        }
        else if (proto == 'socket.io') {
            // http server to proxy socketIO connections with
            var server = kwargs.server;
            delete kwargs.server;
            delete kwargs.protocol;
            var socketIO = io.listen(server, kwargs);
            DNodeSocketIO({
                socketIO : socketIO,
                wrapper : wrapper,
                block : block,
            });
        }
        else {
            throw 'Unsupported protocol: ' + proto;
        }
        return this;
    };
}

// So DNode.connect and DNode().connect do the same thing:
DNode.connect = function () {
    var dnode = DNode();
    return dnode.connect.apply(dnode,[].concat.apply([],arguments));
};

DNodeConn.prototype = new EventEmitter;
function DNodeConn (args) {
    var conn = this;
    
    var sock = args.stream;
    var remote = {};
    
    // share an object or a function that builds an object
    var instance = typeof(args.wrapper) == 'function'
        ? new args.wrapper(remote)
        : args.wrapper
    ;
    if (!('methods' in instance)) {
        instance.methods = function () {
            return Object.keys(instance);
        }
    }
    
    var bufferList = new BufferList;
    sock.addListener('data', function (buf) {
        if (buf instanceof Buffer) {
            bufferList.push(buf);
            var n = buf.toString().indexOf('\n');
            while (n >= 0) {
                var i = bufferList.length - (buf.length - n);
                var line = bufferList.take(i); // up to the \n
                bufferList.advance(i + 1); // past the \n
                
                var cmd = JSON.parse(line);
                if ('method' in cmd) {
                    handleRequest(cmd);
                }
                else if ('result' in cmd) {
                    handleResult(cmd);
                }
                n = buf.toString().indexOf('\n', n + 1);
            }
        }
        else if (typeof(buf) == 'string') {
            // SocketIO wrapper sends strings
            var cmd = JSON.parse(buf);
            if ('method' in cmd) {
                handleRequest(cmd);
            }
            else if ('result' in cmd) {
                handleResult(cmd);
            }
        }
    });
    
    sock.addListener('connect', function () {
        conn.request({
            method : 'methods',
            block : function (methods) {
                methods.forEach(function (method) {
                    remote[method] = function () {
                        var argv = [].concat.apply([],arguments);
                        conn.request({
                            method : method,
                            arguments : argv.slice(0,-1),
                            block : argv.slice(-1)[0],
                        });
                    };
                });
                conn.emit('methods', methods);
                conn.emit('remote', remote);
            }
        });
    });
    
    var handlers = {}; // id => function
    var sendID = 0;
    
    this.request = function (req) {
        sock.write(JSON.stringify({
            id : sendID,
            method : req.method,
            arguments : req.arguments || [],
        }) + '\n');
        handlers[sendID] = req.block;
        sendID ++;
    };
    
    function handleRequest(req) {
        var f = instance[req.method];
        if (req.method == 'methods' && f == undefined) {
            var methods = ['methods'];
            for (var method in instance) {
                methods.push(method);
            }
            f = function () { return methods };
        }
        
        function respond (res) {
            sock.write(JSON.stringify({
                id : req.id,
                result : res,
            }) + '\n');
        }
        
        if (f.asynchronous == true) {
            var args = req.arguments.concat(respond);
            f.apply(instance, args);
        }
        else {
            var res = f.apply(instance, req.arguments);
            respond(res);
        }
        conn.emit('request', req);
    }
    
    function handleResult(res) {
        handlers[res.id].call(remote, res.result);
        conn.emit('result', res);
    }
};

function DNodeSocketIO (params) {
    var sock = params.socketIO;
    
    var streams = {};
    StreamIO.prototype = new EventEmitter;
    function StreamIO (client) {
        this.write = function (msg) {
            client.send(msg);
        }
    }
    
    sock.addListener('clientConnect', function (client) {
        var id = client.sessionId;
        streams[id] = new StreamIO(client);
        var conn = new DNodeConn({
            wrapper : params.wrapper,
            stream : streams[id],
        });
        conn.addListener('remote', function (remote) {
            params.block.call(remote, conn, remote);
        });
        streams[id].emit('connect');
    });
    
    sock.addListener('clientMessage', function (msg,client) {
        var id = client.sessionId;
        streams[id].emit('data', msg);
    });
}

exports.async = async;
DNode.async = async;
function async (f) {
    f.asynchronous = true;
    return f;
};

