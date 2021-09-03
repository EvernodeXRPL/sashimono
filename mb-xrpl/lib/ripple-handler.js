const eccrypto = require("eccrypto");
const RippleAPI = require('ripple-lib').RippleAPI;

const CONNECTION_RETRY_THREASHOLD = 60;
const CONNECTION_RETRY_INTERVAL = 1000;

const maxLedgerOffset = 10;

const MemoTypes = {
    REDEEM: 'evnRedeem',
    REDEEM_REF: 'evnRedeemRef',
    REDEEM_RESP: 'evnRedeemResp',
    HOST_REG: 'evnHostReg'
}

const MemoFormats = {
    TEXT: 'text/plain',
    JSON: 'text/json',
    BINARY: 'binary'
}

const Events = {
    RECONNECTED: 'reconnected',
    LEDGER: 'ledger',
    PAYMENT: 'payment'
}

const hexToASCII = (hex) => {
    let str = "";
    for (let n = 0; n < hex.length; n += 2) {
        str += String.fromCharCode(parseInt(hex.substr(n, 2), 16));
    }
    return str;
}

class EventEmitter {
    constructor() {
        this.handlers = {};
    }

    on(event, handler) {
        if (!this.handlers[event])
            this.handlers[event] = [];
        this.handlers[event].push(handler);
    }

    emit(event, value, error = null) {
        if (this.handlers[event])
            this.handlers[event].forEach(handler => handler(value, error));
    }
}

class RippleAPIWarpper {
    constructor(rippleServer) {
        this.connectionRetryCount = 0;
        this.connected = false;
        this.rippleServer = rippleServer;
        this.events = new EventEmitter();

        this.api = new RippleAPI({ server: this.rippleServer });
        this.api.on('error', (errorCode, errorMessage) => {
            console.log(errorCode + ': ' + errorMessage);
        });
        this.api.on('connected', () => {
            console.log(`Connected to ${this.rippleServer}`);
            this.connectionRetryCount = 0;
            this.connected = true;
        });
        this.api.on('disconnected', async (code) => {
            if (!this.connected)
                return;

            this.connected = false;
            console.log(`Disconnected from ${this.rippleServer} code:`, code);
            try {
                await this.connect();
                this.events.emit(Events.RECONNECTED, `Reconnected to ${this.rippleServer}`);
            }
            catch (e) { console.error(e); };
        });
        this.api.on('ledger', (ledger) => {
            this.events.emit(Events.LEDGER, ledger);
        });
    }

    async connect() {
        if (this.connected)
            return;

        let retryInterval = CONNECTION_RETRY_INTERVAL;
        // If failed, Keep retrying increasing the retry timeout.
        while (true) {
            try {
                this.connectionRetryCount++;
                console.log(`Trying to connect ${this.rippleServer}`);
                await this.api.connect();
                return;
            }
            catch (e) {
                console.log(`Couldn't connect ${this.rippleServer} : `, e);
                // If threashold reaches increase the retry interval.
                if (this.connectionRetryCount % CONNECTION_RETRY_THREASHOLD === 0)
                    retryInterval += CONNECTION_RETRY_INTERVAL;
                // Wait before retry.
                await new Promise(resolve => setTimeout(resolve, retryInterval));
            }
        }
    }

    deriveAddress(publicKey) {
        return this.api.deriveAddress(publicKey);
    }

    async getLedgerVersion() {
        return (await this.api.getLedgerVersion());
    }
}

class XrplAccount {
    constructor(rippleAPI, address, secret = null) {
        this.rippleAPI = rippleAPI;
        this.address = address;
        this.secret = secret;
        this.events = new EventEmitter();
        this.subscribed = false;
    }

    deriveKeypair() {
        if (!this.secret)
            throw 'Cannot derive key pair: Account secret is empty.';

        return this.rippleAPI.api.deriveKeypair(this.secret);
    }

    async makePayment(toAddr, amount, currency, issuer, memos = null) {
        // Get current ledger.
        const ledger = await (await this.rippleAPI.api.getLedger()).ledgerVersion;
        const maxLedger = ledger + maxLedgerOffset;

        const amountObj = {
            currency: currency,
            counterparty: issuer,
            value: amount.toString()
        }

        // Delete counterparty key if issuer is empty.
        if (!amountObj.counterparty)
            delete amountObj.counterparty;

        const prepared = await this.rippleAPI.api.preparePayment(this.address, {
            source: {
                address: this.address,
                maxAmount: amountObj
            },
            destination: {
                address: toAddr,
                amount: amountObj
            },
            memos: this.getMemoCollection(memos)
        }, {
            maxLedgerVersion: maxLedger
        })

        const signed = this.rippleAPI.api.sign(prepared.txJSON, this.secret);

        await this.rippleAPI.api.submit(signed.signedTransaction);
        const verified = await this.verifyTransaction(signed.id, ledger, maxLedger);
        return verified ? verified : false;
    }

    async createTrustline(currency, issuer, limit, memos = null) {
        const res = await this.createTrustlines([{
            issuer: issuer,
            limit: limit,
            currency: currency,
            memos: this.getMemoCollection(memos)
        }]);
        return res[0];
    }

    getMemoCollection(memos) {
        return memos ? memos.filter(m => m.data).map(m => {
            return {
                type: m.type,
                format: m.format,
                data: (typeof m.data === "object") ? JSON.stringify(m.data) : m.data
            }
        }) : [];
    }

    async createTrustlines(lines) {
        // Get current ledger.
        const ledger = await (await this.rippleAPI.api.getLedger()).ledgerVersion;
        const maxLedger = ledger + maxLedgerOffset;

        // Create and verify multiple trust lines in parallel.
        const tasks = [];
        for (const line of lines) {
            tasks.push(new Promise(async (resolve) => {
                const prepared = await this.rippleAPI.api.prepareTrustline(this.address, {
                    counterparty: line.issuer,
                    currency: line.currency,
                    limit: line.limit.toString(),
                    memos: line.memos
                }, {
                    maxLedgerVersion: maxLedger
                })

                const signed = this.rippleAPI.api.sign(prepared.txJSON, this.secret);

                await this.rippleAPI.api.submit(signed.signedTransaction);
                console.log("Submitted trust line.");
                const verified = await this.verifyTransaction(signed.id, ledger, maxLedger);
                verified ? resolve(verified) : resolve(false);
            }));
        }

        const results = await Promise.all(tasks);
        return results;
    }

    verifyTransaction(txHash, minLedger, maxLedger) {
        return new Promise(resolve => {
            this.rippleAPI.api.getTransaction(txHash, {
                minLedgerVersion: minLedger,
                maxLedgerVersion: maxLedger
            }).then(data => {
                console.log(data.outcome.result);
                if (data.outcome.result !== 'tesSUCCESS')
                    console.log("Transaction verification failed. Result: " + data.outcome.result);
                resolve(data.outcome.result === 'tesSUCCESS' ? { txHash: data.id, ledgerVersion: data.outcome.ledgerVersion } : false);
            }).catch(error => {
                // If transaction not in latest validated ledger, try again until max ledger is hit.
                if (error instanceof this.rippleAPI.api.errors.PendingLedgerVersionError || error instanceof this.rippleAPI.api.errors.NotFoundError) {
                    console.log("Waiting for verification...");
                    setTimeout(() => {
                        this.verifyTransaction(txHash, minLedger, maxLedger).then(result => resolve(result));
                    }, CONNECTION_RETRY_INTERVAL);
                }
                else {
                    console.log(error);
                    console.log("Transaction verification failed.");
                    resolve(false); // give up.
                }
            })
        })
    }

    deserializeMemo(memo) {
        return {
            type: memo.MemoType ? hexToASCII(memo.MemoType) : null,
            format: memo.MemoFormat ? hexToASCII(memo.MemoFormat) : null,
            data: memo.MemoData ? hexToASCII(memo.MemoData) : null
        };
    }

    subscribe() {
        if (this.subscribed) {
            throw `Already subscribed to ${this.address}`
        }

        this.rippleAPI.api.connection.on("transaction", (data) => {
            const eventName = data.transaction.TransactionType.toLowerCase();
            if (data.engine_result === "tesSUCCESS") {
                if (data.transaction.Memos)
                    data.transaction.Memos = data.transaction.Memos.filter(m => m.Memo).map(m => this.deserializeMemo(m.Memo));
                this.events.emit(eventName, data.transaction)
            }
            else
                this.events.emit(eventName, null, data.engine_result_message)
        });

        const request = {
            command: 'subscribe',
            accounts: [this.address]
        }
        const message = `Subscribed to transactions on ${this.address}`;

        // Subscribe to transactions when api is reconnected.
        // Because API will be automatically reconnected if it's disconnected.
        this.rippleAPI.events.on(Events.RECONNECTED, (e) => {
            this.rippleAPI.api.connection.request(request);
            console.log(message);
        });

        this.rippleAPI.api.connection.request(request);
        console.log(message);

        this.eventHandled = true;
    }
}

class EncryptionHelper {
    static ivOffset = 65;
    static macOffset = this.ivOffset + 16;
    static ciphertextOffset = this.macOffset + 32;
    static contentFormat = 'base64';
    static keyFormat = 'hex';

    static async encrypt(publicKeyStr, jsonObj) {
        const encrypted = await eccrypto.encrypt(Buffer.from(publicKeyStr, this.keyFormat), Buffer.from(JSON.stringify(jsonObj)));
        return Buffer.concat([encrypted.ephemPublicKey, encrypted.iv, encrypted.mac, encrypted.ciphertext]).toString(this.contentFormat);
    }

    static async decrypt(privateKeyStr, encryptedStr) {
        const encryptedBuf = Buffer.from(encryptedStr, this.contentFormat);
        const encrypted = {
            ephemPublicKey: encryptedBuf.slice(0, this.ivOffset),
            iv: encryptedBuf.slice(this.ivOffset, this.macOffset),
            mac: encryptedBuf.slice(this.macOffset, this.ciphertextOffset),
            ciphertext: encryptedBuf.slice(this.ciphertextOffset)
        }
        const decrypted = (await eccrypto.decrypt(Buffer.from(privateKeyStr, this.keyFormat).slice(1), encrypted)).toString();
        return JSON.parse(decrypted);
    }
}

module.exports = {
    XrplAccount,
    RippleAPIWarpper,
    EncryptionHelper,
    MemoFormats,
    MemoTypes,
    Events
}