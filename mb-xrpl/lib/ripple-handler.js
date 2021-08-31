const RippleAPI = require('ripple-lib').RippleAPI;

const MAX_CONNECTION_RETRY_COUNT = 60;
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

        // If failed, Keep retrying until max threashold reaches.
        while (this.connectionRetryCount < MAX_CONNECTION_RETRY_COUNT) {
            try {
                this.connectionRetryCount++;
                console.log(`Trying to connect ${this.rippleServer}`);
                await this.api.connect();
                return;
            }
            catch (e) {
                console.log(`Couldn't connect ${this.rippleServer} : `, e);
                // Wait for one second before retry.
                await new Promise(resolve => setTimeout(resolve, CONNECTION_RETRY_INTERVAL));
            }
        }

        this.connectionRetryCount = 0;
        throw `Max connection retry count reached for ${this.rippleServer}. Try again later.`;
    }

    async getLedgerVersion() {
        return (await this.api.getLedgerVersion());
    }
}

class XrplAccount {
    constructor(rippleAPI, address, secret = null) {
        this.api = rippleAPI;
        this.address = address;
        this.secret = secret;
        this.events = new EventEmitter();

        this.api.connection.on("transaction", (data) => {
            const eventName = data.transaction.TransactionType.toLowerCase();
            if (data.engine_result === "tesSUCCESS")
                this.events.emit(eventName, data.transaction)
            else
                this.events.emit(eventName, null, data.engine_result_message)
        });
    }

    async makePayment(toAddr, amount, currency, issuer, memos = null) {
        // Get current ledger.
        const ledger = await (await this.api.getLedger()).ledgerVersion;
        const maxLedger = ledger + maxLedgerOffset;

        const amountObj = {
            currency: currency,
            counterparty: issuer,
            value: amount.toString()
        }

        // Delete counterparty key if issuer is empty.
        if (!amountObj.counterparty)
            delete amountObj.counterparty;

        const prepared = await this.api.preparePayment(this.address, {
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

        const signed = this.api.sign(prepared.txJSON, this.secret);

        await this.api.submit(signed.signedTransaction);
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
        const ledger = await (await this.api.getLedger()).ledgerVersion;
        const maxLedger = ledger + maxLedgerOffset;

        // Create and verify multiple trust lines in parallel.
        const tasks = [];
        for (const line of lines) {
            tasks.push(new Promise(async (resolve) => {
                const prepared = await this.api.prepareTrustline(this.address, {
                    counterparty: line.issuer,
                    currency: line.currency,
                    limit: line.limit.toString(),
                    memos: line.memos
                }, {
                    maxLedgerVersion: maxLedger
                })

                const signed = this.api.sign(prepared.txJSON, this.secret);

                await this.api.submit(signed.signedTransaction);
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
            this.api.getTransaction(txHash, {
                minLedgerVersion: minLedger,
                maxLedgerVersion: maxLedger
            }).then(data => {
                console.log(data.outcome.result);
                if (data.outcome.result !== 'tesSUCCESS')
                    console.log("Transaction verification failed. Result: " + data.outcome.result);
                resolve(data.outcome.result === 'tesSUCCESS' ? { txHash: data.id, ledgerVersion: data.outcome.ledgerVersion } : false);
            }).catch(error => {
                // If transaction not in latest validated ledger, try again until max ledger is hit.
                if (error instanceof this.api.errors.PendingLedgerVersionError || error instanceof this.api.errors.NotFoundError) {
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

    subscribe() {
        this.api.connection.request({
            command: 'subscribe',
            accounts: [this.address]
        });
        console.log("Subscribed to transactions on " + this.address);
    }
}

module.exports = {
    XrplAccount,
    RippleAPIWarpper,
    MemoFormats,
    MemoTypes,
    Events
}