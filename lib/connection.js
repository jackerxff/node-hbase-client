/*!
 * node-hbase-client - lib/connection.js
 * Copyright(c) 2013 fengmk2 <fengmk2@gmail.com>
 * MIT Licensed
 */

"use strict";

/**
 * Module dependencies.
 */

var debug = require('debug')('hbase:connection');
var Long = require('long');
var Readable = require('readable-stream').Readable;
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var utility = require('utility');
var net = require('net');
var Text = require('./text');
var Bytes = require('./util/bytes');
var ResponseFlag = require('./ipc/response_flag');
var DataInputBuffer = require('./data_input_buffer');
var DataOutputBuffer = require('./data_output_buffer');
var DataInputStream = require('./data_input_stream');
var DataOutputStream = require('./data_output_stream');
var HbaseObjectWritable = require('./io/hbase_object_writable');
var Invocation = require('./ipc/invocation');
var HConstants = require('./hconstants');
var errors = require('./errors');
var RemoteException = errors.RemoteException;

var HEADER = new Buffer("hrpc", "utf8");
var CURRENT_VERSION = 3;
var PING_CALL_ID = -1;

/**
 * The IPC connection header sent by the client to the server
 * on connection establishment.
 * 
 * Create a new {@link ConnectionHeader} with the given <code>protocol</code>
 * and {@link User}.
 * @param protocol protocol used for communication between the IPC client
 *                 and the server
 * @param user {@link User} of the client communicating with
 *            the server
 */
function ConnectionHeader(protocol, user) {
  this.protocol = protocol;
  this.user = user;
}

ConnectionHeader.prototype.write = function (out) {
  debug('ConnectionHeader: write %s', this.protocol);
  Text.writeString(out, this.protocol || '');
},

ConnectionHeader.prototype.getProtocol = function () {
  return this.protocol;
};

ConnectionHeader.prototype.getUser = function () {
  return null;
};

ConnectionHeader.prototype.toString = function () {
  return this.protocol;
};

var _Connection_id = 0;

/** Thread that reads responses and notifies callers.  Each connection owns a
 * socket connected to a remote address.  Calls are multiplexed through this
 * socket: responses may be delivered out of order. */
function Connection(options) {
  EventEmitter.call(this);
  this.id = _Connection_id++;
  this.header = null; // connection header
  this.socket = null; // connected socket
  this.in;
  this.out;
  
  this.tcpNoDelay = false; // nodelay not or
  this.tcpKeepAlive = true;

  // currently active calls
  this.calls = {};

  this.address = {host: options.host, port: options.port};
  this.hostnamePort = options.host + ':' + options.port;
  this.name = 'Connection(' + this.hostnamePort + ')#' + this.id;
  var protocol = options.protocol || HConstants.PROTOCOL;
  this.rpcTimeout = options.rpcTimeout || HConstants.DEFAULT_HBASE_RPC_TIMEOUT;
  this.logger = options.logger || console;
  this.header = new ConnectionHeader(protocol, options.ticket);
  this.setupIOstreams();
}

util.inherits(Connection, EventEmitter);

Connection.prototype.setupConnection = function () {
  var ioFailures = 0;
  var timeoutFailures = 0;
  this.socket = net.connect(this.address);
  this.socketReadable = this.socket;
  if (typeof this.socketReadable.read !== 'function') {
    this.socketReadable = new Readable();
    this.socketReadable.wrap(this.socket);
    // ignore error event
    this.socketReadable.on('error', utility.noop);
  }
  this.socket.setNoDelay(this.tcpNoDelay);
  this.socket.setKeepAlive(this.tcpKeepAlive);
  // if (this.remoteId.rpcTimeout > 0) {
  //   this.pingInterval = this.remoteId.rpcTimeout;
  // }
  // this.socket.setTimeout(this.pingInterval);
  this.socket.on('timeout', this.emit.bind(this, 'timeout'));
  this.socket.on('close', this._handleClose.bind(this));

  // when error, response all calls error
  this.socket.on('error', this._handleError.bind(this));
};

Connection.prototype._cleanupCalls = function (err) {
  var count = 0;
  var calls = this.calls;
  this.calls = {}; // should reset calls before traverse it.
  for (var id in calls) {
    var call = calls[id];
    call.setException(err);
    count++;
  }
  // this.calls = {};
  debug('conn#%d: clenaup %d calls, send "%s:%s" response.', this.id, count, err.name, err.message);
};

Connection.prototype._handleClose = function () {
  this.closed = true;
  var address = this.address;
  var msg = '[WARNNING] socket ' + address.host + ':' + address.port + ' closed.';
  debug(msg);
  this.logger.warn(msg);
  var err = new errors.ConnectionClosedException(msg);
  this._cleanupCalls(err);
  this.emit('close');
};

Connection.prototype._handleError = function (err) {
  this._cleanupCalls(err);
};

/** Connect to the server and set up the I/O streams. It then sends
 * a header to the server and starts
 * the connection thread that waits for responses.
 * @throws java.io.IOException e
 */
Connection.prototype.setupIOstreams = function () {
  debug("Connecting to %s", this.name);
  this.setupConnection();
  this.in = new DataInputStream(this.socketReadable);
  this.out = new DataOutputStream(this.socket);
  
  var self = this;
  this.socket.on('connect', function () {
    self.writeHeader();
    self._nextResponse();
    self.emit('connect');
  });
};

/* Write the header for each connection
 * Out is not synchronized because only the first thread does this.
 */
Connection.prototype.writeHeader = function () {
  this.out.write(HEADER);
  this.out.writeByte(CURRENT_VERSION);
  //When there are more fields we can have ConnectionHeader Writable.
  var buf = new DataOutputBuffer();
  this.header.write(buf);

  var bufLen = buf.getLength();
  this.out.writeInt(bufLen);
  this.out.write(buf.getData());
};

/* Initiates a call by sending the parameter to the remote server.
 * Note: this is not called from the Connection thread, but by other
 * threads.
 */
Connection.prototype.sendParam = function (call) {

  // For serializing the data to be written.

  debug(this.name + " sending #" + call.id);

  var d = new DataOutputBuffer();
  d.writeInt(0); // placeholder for data length
  d.writeInt(call.id);
  call.param.write(d);
  var data = d.getData();
  var dataLength = d.getLength();

  // fill in the placeholder
  Bytes.putInt(data, 0, dataLength - 4);
  this.out.write(data, 0, dataLength);
};

Connection.prototype._close = function () {
  this.closed = true;
  // TODO: end or close?
  // this.socket.end();
  // var address = this.remoteId.getAddress();
  // var msg = 'socket ' + address.host + ':' + address.port + ' destroy()';
  // console.warn(msg);
  this.socket.destroy();
};
Connection.prototype.close = Connection.prototype._close;

Connection.prototype._nextResponse = function () {
  var self = this;
  // See HBaseServer.Call.setResponse for where we write out the response.
  // It writes the call.id (int), a flag byte, then optionally the length
  // of the response (int) followed by data.
  self.in.readFields([
    {name: 'id', method: 'readInt'},
    {name: 'flag', method: 'readByte'},
    {name: 'size', method: 'readInt'},
  ], function (err, data) {

    if (!data.hasOwnProperty('id') || !data.hasOwnProperty('flag') || !data.hasOwnProperty('size')) {
      self.logger.warn('[ERROR] [%s] data format wrong: %j', new Date(), data);
      err = new RemoteException('RemoteException', 'data packet wrong, data: ' + JSON.stringify(data));
      self._close();
      return;
    }

    // Read the call id.
    var id = data && data.id;
    var size = data.size - 9; // remove header size, Int, Byte, Int, 9 bytes
    debug('receiveResponse: got call#%s response, flag: %s, size: %s', id, data.flag, data.size);
    var call = self.calls[id];

    if (!call) {
      // timeout remove
      debug('[WARNNING] [%s] call#%s not exists, data: %j', new Date(), id, data);
    } else {
      delete self.calls[id];
    }
    
    if (err) {
      call && call.setException(err);
      self._close();
      return;
    }

    // Read the flag byte
    var flag = data.flag;
    var isError = ResponseFlag.isError(flag);
    if (typeof flag !== 'number' || !ResponseFlag.isLength(flag)) {
      err = new RemoteException('RemoteException', 'missing data length packet, flag: ' + flag);
      call && call.setException(err);
      self._close();
      return;
    }

    self.in.readBytes(size, function (err, buf) {
      var io = new DataInputBuffer(buf);

      var state = io.readInt(); // Read the state.  Currently unused.
      if (isError) {
        err = new RemoteException(io.readString(), io.readString());
        call && call.setException(err);
      } else {
        var obj = HbaseObjectWritable.readFields(io);
        debug('call#%s got %s instance', id, obj.declaredClass);
        call && call.setValue(obj.instance);
      }

      // RangeError: Maximum call stack size exceeded
      // self._nextResponse();
      process.nextTick(self._nextResponse.bind(self));
    });
  });

};
  
// impl HRegionInterface
Connection.prototype.call = function (method, parameters, rpcTimeout, callback) {
  if (typeof rpcTimeout === 'function') {
    callback = rpcTimeout;
    rpcTimeout = null;
  }
  rpcTimeout = rpcTimeout || this.rpcTimeout;
  var param = new Invocation(method, parameters);
  var call = new Call(param, rpcTimeout);
  this.calls[call.id] = call;
  call.on('done', callback); // TODO: handle MAX Number error response, should close the connection.

  if (this.closed) {
    return this._handleClose();
  }

  var self = this;
  call.on('timeout', function () {
    // remove the call
    delete self.calls[call.id];
  });
  this.sendParam(call);
};

/**
 * Return all the data for the row that matches <i>row</i> exactly,
 * or the one that immediately preceeds it.
 *
 * @param regionName region name
 * @param row row key
 * @param family Column family to look for row in.
 * @return map of values
 * @throws IOException e
 */
Connection.prototype.getClosestRowBefore = function (regionName, row, family, rpcTimeout, callback) {
  // debug('getClosestRowBefore(`%s`, `%s`, `%s`)', regionName, row, family);
  this.call('getClosestRowBefore', [regionName, row, family], rpcTimeout, callback);
};

/**
 * Return protocol version corresponding to protocol interface.
 * 
 * @param protocol The classname of the protocol interface
 * @param clientVersion The version of the protocol that the client speaks
 * @return the version that the server will speak
 * @throws IOException if any IO error occurs
 */
Connection.prototype.getProtocolVersion = function (protocol, clientVersion, rpcTimeout, callback) {
  protocol = protocol || HConstants.PROTOCOL;
  clientVersion = clientVersion || HConstants.CLIENT_VERSION;
  if (!(clientVersion instanceof Long)) {
    clientVersion = Long.fromNumber(clientVersion);
  }
  this.call('getProtocolVersion', [protocol, clientVersion], rpcTimeout, callback);
};

/**
 * Perform Get operation.
 * @param regionName name of region to get from
 * @param get Get operation
 * @return Result
 * @throws IOException e
 */
Connection.prototype.get = function (regionName, get, callback) {
  this.call('get', [regionName, get], callback);
};

/**
 * Put data into the specified region
 * @param regionName region name
 * @param put the data to be put
 * @throws IOException e
 */
Connection.prototype.put = function (regionName, put, callback) {
  this.call('put', [regionName, put], callback);
};

/**
 * Opens a remote scanner with a RowFilter.
 *
 * @param regionName name of region to scan
 * @param scan configured scan object
 * @return scannerId scanner identifier used in other calls
 * @throws IOException e
 */
Connection.prototype.openScanner = function (regionName, scan, callback) {
  this.call('openScanner', [regionName, scan], callback);
};

/**
 * Get the next set of values
 * 
 * @param scannerId clientId passed to openScanner
 * @return map of values; returns null if no results.
 * @throws IOException e
 */
// Connection.prototype.next = function (scannerId, callback) {
//   this.call('next', [scannerId], callback);
// };

/**
 * Get the next set of values
 * 
 * @param scannerId clientId passed to openScanner
 * @param [numberOfRows] the number of rows to fetch
 * @return Array of Results (map of values); array is empty if done with this
 * region and null if we are NOT to go to the next region (happens when a
 * filter rules that the scan is done).
 * @throws IOException e
 */
Connection.prototype.nextResult = function (scannerId, numberOfRows, callback) {
  if (typeof numberOfRows === 'function') {
    callback = numberOfRows;
    numberOfRows = null;
  }
  var params = [scannerId];
  if (numberOfRows) {
    params.push(numberOfRows);
  }
  this.call('next', params, callback);
};

/**
 * Close a scanner
 *
 * @param scannerId the scanner id returned by openScanner
 * @throws IOException e
 */
Connection.prototype.closeScanner = function (scannerId, callback) {
  this.call('close', [scannerId], callback);
};

var Call_Counter = 0;

/** A call waiting for a value. */
function Call(param, timeout) {
  EventEmitter.call(this);
  this.id = Call_Counter++; // call id
  this.param = param; // parameter
  this.value = null; // value, null if error
  this.error = null; // exception, null if value
  this.done = false; // true when call is done
  this.startTime = Date.now();

  this.timeout = timeout;
  if (timeout && timeout > 0) {
    this.timer = setTimeout(this._handleTimeout.bind(this), timeout);
  }
}

util.inherits(Call, EventEmitter);

Call.prototype._handleTimeout = function () {
  var err = new errors.RemoteCallTimeoutException(this.timeout + ' ms timeout');
  this.setException(err);
  this.emit('timeout');
};

/** Indicate when the call is complete and the
 * value or error are available.  Notifies by default.  */
Call.prototype.callComplete = function () {
  if (this.timer) {
    clearTimeout(this.timer);
  }
  if (this.done) {
    // if done before, do not emit done again
    return;
  }
  this.done = true;
  if (debug.enabled) {
    debug('call#%d use %d ms', this.id, Date.now() - this.startTime);
  }
  this.emit('done', this.error, this.value);
};

/** Set the exception when there is an error.
 * Notify the caller the call is done.
 *
 * @param error exception thrown by the call; either local or remote
 */
Call.prototype.setException = function (err) {
  debug('call#%s error: %s', this.id, err.message);
  this.error = err;
  this.callComplete();
};

/** Set the return value when there is no error.
 * Notify the caller the call is done.
 *
 * @param value return value of the call.
 */
Call.prototype.setValue = function (value) {
  this.value = value;
  this.callComplete();
};

Call.prototype.getStartTime = function () {
  return this.startTime;
};


module.exports = Connection;
