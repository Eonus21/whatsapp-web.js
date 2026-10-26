const assert = require('node:assert/strict');
const Client = require('../src/Client');

describe('WhatsApp Web connection failure telemetry', function () {
    it('keeps stream and failure codes separate without changing parser results', async function () {
        class Parser {
            parse(stanza) {
                return { success: stanza.parsed };
            }
        }
        const failures = [];
        const pageWindow = {
            require(name) {
                if (name === 'WADeprecatedWapParser') return Parser;
                if (name === 'WAWebFailureErrorCodes')
                    return {
                        FAILURE_REASON: { REASON_NOT_AUTHORIZED: 401 },
                    };
                throw new Error(name);
            },
        };
        const page = {
            waitForFunction: async () => {},
            exposeFunction: async (name, callback) => {
                pageWindow[name] = (failure) =>
                    Promise.resolve(callback(failure));
            },
            evaluate: async (callback) => {
                const previousWindow = global.window;
                global.window = pageWindow;
                try {
                    return callback();
                } finally {
                    global.window = previousWindow;
                }
            },
        };
        const client = new Client();
        client.pupPage = page;
        client.setDeviceName = async () => {
            throw new Error('stop after telemetry setup');
        };
        client.on('wa_connection_failure', (failure) => failures.push(failure));
        await assert.rejects(client.inject(), /stop after telemetry setup/);
        await assert.rejects(client.inject(), /stop after telemetry setup/);

        const previousWindow = global.window;
        global.window = pageWindow;
        try {
            const parser = new Parser();
            const removed = {
                tag: 'stream:error',
                attrs: { code: '401' },
                content: [
                    { tag: 'conflict', attrs: { type: 'device_removed' } },
                ],
                parsed: { type: 'device_removed' },
            };
            assert.deepEqual(parser.parse(removed), {
                success: removed.parsed,
            });
            parser.parse({ tag: 'failure', parsed: { reason: 401, code: 7 } });
            parser.parse({ tag: 'failure', parsed: { reason: 599 } });
            parser.parse({
                tag: 'failure',
                attrs: { reason: '402', code: '104', expire: '86400' },
                parsed: { reason: 402, code: 104 },
            });
            parser.parse({
                tag: 'stream:error',
                parsed: { type: 'code', code: 516 },
            });
            parser.parse({ tag: 'message', parsed: {} });
        } finally {
            global.window = previousWindow;
        }
        assert.deepEqual(failures, [
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
                expire: null,
                attrs: null,
            },
            {
                kind: 'failure',
                reason: 599,
                reasonName: null,
                code: null,
                expire: null,
                attrs: null,
            },
            {
                kind: 'failure',
                reason: 402,
                reasonName: null,
                code: 104,
                expire: '86400',
                attrs: { reason: '402', code: '104', expire: '86400' },
            },
            {
                kind: 'stream_error',
                type: 'code',
                code: 516,
                conflictType: null,
                codeName: 'start_logout',
            },
        ]);
    });
});
