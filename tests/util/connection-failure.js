const { expect } = require('chai');

const Client = require('../../src/Client');

function createPageWindow(Parser) {
    return {
        require(name) {
            if (name === 'WADeprecatedWapParser') return Parser;
            if (name === 'WAWebFailureErrorCodes')
                return { FAILURE_REASON: { REASON_NOT_AUTHORIZED: 401 } };
            return {};
        },
    };
}

function createPage(pageWindow) {
    return {
        waitForFunction: async () => {},
        exposeFunction: async (name, callback) => {
            pageWindow[name] = (failure) => Promise.resolve(callback(failure));
        },
        evaluate: async (callback, ...args) => {
            const previousWindow = global.window;
            global.window = pageWindow;
            try {
                return callback(...args);
            } finally {
                global.window = previousWindow;
            }
        },
    };
}

async function injectUntilDeviceName(client) {
    client.setDeviceName = async () => {
        throw new Error('stop after telemetry setup');
    };
    try {
        await client.inject();
    } catch (err) {
        if (err.message !== 'stop after telemetry setup') throw err;
    }
}

function parseWithPageWindow(pageWindow, Parser, stanzas) {
    const previousWindow = global.window;
    global.window = pageWindow;
    try {
        const parser = new Parser();
        return stanzas.map((stanza) => parser.parse(stanza));
    } finally {
        global.window = previousWindow;
    }
}

describe('wa_connection_failure telemetry', function () {
    it('emits stream:error and failure causes without changing parser results', async function () {
        class Parser {
            parse(stanza) {
                return { success: stanza.parsed };
            }
        }
        const pageWindow = createPageWindow(Parser);
        const client = new Client();
        client.pupPage = createPage(pageWindow);
        const failures = [];
        client.on('wa_connection_failure', (failure) => failures.push(failure));

        await injectUntilDeviceName(client);
        await injectUntilDeviceName(client);

        const removed = {
            tag: 'stream:error',
            attrs: { code: '401' },
            content: [{ tag: 'conflict', attrs: { type: 'device_removed' } }],
            parsed: { type: 'device_removed' },
        };
        const results = parseWithPageWindow(pageWindow, Parser, [
            removed,
            { tag: 'failure', parsed: { reason: 401, code: 7 } },
            { tag: 'failure', parsed: { reason: 599 } },
            { tag: 'stream:error', parsed: { type: 'code', code: 516 } },
            { tag: 'message', parsed: {} },
        ]);
        await new Promise((resolve) => setImmediate(resolve));

        expect(results[0]).to.deep.equal({ success: removed.parsed });
        expect(failures).to.deep.equal([
            {
                kind: 'stream_error',
                type: 'device_removed',
                code: '401',
                conflictType: 'device_removed',
                codeName: null,
            },
            {
                kind: 'failure',
                reason: 401,
                reasonName: 'REASON_NOT_AUTHORIZED',
                code: 7,
            },
            { kind: 'failure', reason: 599, reasonName: null, code: null },
            {
                kind: 'stream_error',
                type: 'code',
                code: 516,
                conflictType: null,
                codeName: 'start_logout',
            },
        ]);
    });

    it('does not break injection when the parser module is missing', async function () {
        const pageWindow = createPageWindow({});
        const client = new Client();
        client.pupPage = createPage(pageWindow);

        await injectUntilDeviceName(client);
    });
});
