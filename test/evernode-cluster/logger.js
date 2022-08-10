const http = require('http');

const dispatchInterval = 1000;

const reqOptions = {
    hostname: '45.76.178.184',
    port: 3000,
    path: '/writelog',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    }
};

const dispatchEnabled = true;

const logger = {
    contractId: '',
    pubkey: '',
    queue: [],
    cancelled: false,
    timer: null
}

function initLog(contractId, pubkey, lclSeqNo, lclHash) {
    logger.contractId = contractId.replaceAll('-', '').substr(0, 10);
    logger.pubkey = pubkey.substr(0, 10);

    if (dispatchEnabled) {
        scheduleLogDispatch();
        traceLogCloud(`LCL ${lclSeqNo} - ${lclHash}`)
    }
}

function deinitLog() {

    if (dispatchEnabled) {
        logger.cancelled = true;
        clearTimeout(logger.timer);
        dispatchLogs(); // Distach any queued logs immediately.
    }
}

function traceLog(...params) {
    traceLogInternal(...params);
}

function traceLogCloud(...params) {
    queueForLogSending(traceLogInternal(...params));
}


function traceLogInternal(...params) {
    let str = '';
    for (p of params) {
        if (typeof p === 'string' || p instanceof String) {
            str += p
        }
        else if (!isNaN(p)) {
            str += p
        }
        else {
            str += JSON.stringify(p)
        }
        str += ' ';
    }
    console.log(new Date().toISOString(), str);
    return str;
}

function queueForLogSending(msg) {
    logger.queue.push({
        contractId: logger.contractId,
        pubkey: logger.pubkey,
        message: msg,
        timestamp: new Date().getTime()
    });
}

function scheduleLogDispatch() {
    if (logger.cancelled)
        return;

    logger.timer = setTimeout(() => {
        dispatchLogs();
    }, dispatchInterval);
}

function dispatchLogs() {
    const logs = logger.queue.splice(0);

    if (logs.length > 0) {
        const req = http.request(reqOptions);
        req.write(JSON.stringify(logs));
        req.on('error', error => { });
        req.end();
    }

    if (dispatchEnabled)
        scheduleLogDispatch();
}

module.exports = {
    initLog,
    deinitLog,
    traceLog,
    traceLogCloud
}