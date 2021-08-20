const RippleAPI = require('ripple-lib').RippleAPI;

const maxLedgerOffset = 10;

const MemoTypes = {
    INST_CRET: 'evndInstCreate',
    INST_CRET_RESP: 'evndInstCreateResp',
    HOST_REG: 'evndHostReg'
}

const MemoFormats = {
    TEXT: 'text/plain',
    JSON: 'text/json',
    BINARY: 'binary'
}

const Events = {
    PAYMENT: 'payment'
}

class XrplAccount {
    constructor(server, addr, secret = null) {
        this.api = new RippleAPI({ server: server });
        this.addr = addr;
        this.secret = secret;
        this.handlers = {};
        this.connected = false;
        this.keepConnectionAlive = false;
    }

    async rippleConnect(keepAlive = false) {
        if (!this.connected) {
            await this.api.connect();
            this.connected = true;
        }
        this.keepConnectionAlive = keepAlive;
    }

    async rippleDisconnect() {
        if (this.connected && !this.keepConnectionAlive) {
            await this.api.disconnect();
            this.connected = false;
        }
    }

    async makePayment(toAddr, amount, currency, issuer, memoType = null, memoFormat = null, memoData = null) {
        await this.rippleConnect();

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

        const prepared = await this.api.preparePayment(this.addr, {
            source: {
                address: this.addr,
                maxAmount: amountObj
            },
            destination: {
                address: toAddr,
                amount: amountObj
            },
            memos: this.getMemoCollection(memoType, memoFormat, memoData)
        }, {
            maxLedgerVersion: maxLedger
        })

        const signed = this.api.sign(prepared.txJSON, this.secret);

        await this.api.submit(signed.signedTransaction);
        const verified = await this.verifyTransaction(signed.id, ledger, maxLedger);
        await this.rippleDisconnect();

        return verified ? signed.id : false;
    }

    async createTrustline(currency, issuer, limit, memoType = null, memoFormat = null, memoData = null) {
        const res = await this.createTrustlines([{
            issuer: issuer,
            limit: limit,
            currency: currency,
            memos: this.getMemoCollection(memoType, memoFormat, memoData)
        }]);
        return res[0];
    }

    getMemoCollection(memoType, memoFormat, memoData) {
        return memoData ? [{
            type: memoType,
            format: memoFormat,
            data: memoFormat == MemoFormats.JSON ? JSON.stringify(memoData) : memoData
        }] : [];
    }

    async createTrustlines(lines) {
        await this.rippleConnect();

        // Get current ledger.
        const ledger = await (await this.api.getLedger()).ledgerVersion;
        const maxLedger = ledger + maxLedgerOffset;

        // Create and verify multiple trust lines in parallel.
        const tasks = [];
        for (const line of lines) {
            tasks.push(new Promise(async (resolve) => {
                const prepared = await this.api.prepareTrustline(this.addr, {
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
                verified ? resolve(signed.id) : resolve(false);
            }));
        }

        const results = await Promise.all(tasks);
        await this.rippleDisconnect();

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

                resolve(data.outcome.result === 'tesSUCCESS');
            }).catch(error => {
                // If transaction not in latest validated ledger, try again until max ledger is hit.
                if (error instanceof this.api.errors.PendingLedgerVersionError || error instanceof this.api.errors.NotFoundError) {
                    console.log("Waiting for verification...");
                    setTimeout(() => {
                        this.verifyTransaction(txHash, minLedger, maxLedger).then(result => resolve(result));
                    }, 1000);
                }
                else {
                    console.log(error);
                    console.log("Transaction verification failed.");
                    resolve(false); // give up.
                }
            })
        })
    }

    async getTrustlines(currency) {
        await this.rippleConnect();
        let res = await this.api.getTransactions(this.addr, {
            excludeFailures: true,
            types: ["trustline"]
        });
        await this.rippleDisconnect();

        return res;
    }

    async subscribe() {
        await this.rippleConnect(true);

        this.api.connection.request({
            command: 'subscribe',
            accounts: [this.addr]
        });

        console.log("Listening to transactions on " + this.addr);

        this.api.connection.on("transaction", (data) => {
            const handler = this.handlers[data.transaction.TransactionType.toLowerCase()];
            if (handler) {
                if (data.engine_result === "tesSUCCESS")
                    handler(data.transaction);
                else
                    handler(null, data.engine_result_message)
            }
        });
    }

    on(event, handler) {
        this.handlers[event] = handler;
    }
}

module.exports = {
    XrplAccount,
    MemoFormats,
    MemoTypes,
    Events
}