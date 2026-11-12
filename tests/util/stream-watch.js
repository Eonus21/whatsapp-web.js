const { EventEmitter } = require('events');
const { expect } = require('chai');

const Client = require('../../src/Client');

const StreamMode = {
    MAIN: 'MAIN',
    QR: 'QR',
    OFFLINE: 'OFFLINE',
    SYNCING: 'SYNCING',
};
const StreamInfo = { NORMAL: 'NORMAL', OFFLINE: 'OFFLINE', SYNCING: 'SYNCING' };

function createStream(mode, displayInfo) {
    const stream = new EventEmitter();
    stream.mode = mode;
    stream.displayInfo = displayInfo;
    stream.set = (attrs) => {
        Object.assign(stream, attrs);
        stream.emit('change');
    };
    return stream;
}

function withWindow(pageWindow, fn) {
    const previousWindow = global.window;
    global.window = pageWindow;
    try {
        return fn();
    } finally {
        global.window = previousWindow;
    }
}

function createWindow(modules, events) {
    return {
        require(name) {
            return modules[name] || {};
        },
        onConnectionStateEvent: (screen, percent) =>
            events.push([screen, percent]),
    };
}

describe('installWWebStreamWatch', function () {
    it('returns false when the Stream model is unavailable', function () {
        const events = [];
        const pageWindow = createWindow({}, events);
        const result = withWindow(pageWindow, () =>
            Client._installWWebStreamWatch(),
        );
        expect(result).to.equal(false);
        expect(events).to.deep.equal([]);
    });

    it('fires once for the current state and maps Stream transitions', function () {
        const events = [];
        const Stream = createStream(StreamMode.MAIN, StreamInfo.NORMAL);
        const pageWindow = createWindow(
            {
                WAWebStreamModel: { Stream, StreamMode, StreamInfo },
                WAWebOfflineHandler: {
                    OfflineMessageHandler: {
                        getOfflineDeliveryProgress: () => 42,
                    },
                },
            },
            events,
        );

        const result = withWindow(pageWindow, () =>
            Client._installWWebStreamWatch(),
        );
        expect(result).to.equal(true);
        expect(events).to.deep.equal([['CONNECTED', 42]]);

        withWindow(pageWindow, () => {
            Stream.set({ mode: StreamMode.OFFLINE }); // socket dropped
            Stream.set({ mode: StreamMode.OFFLINE, displayInfo: 'x' }); // dedupe
            Stream.set({
                mode: StreamMode.MAIN,
                displayInfo: StreamInfo.SYNCING,
            });
            Stream.set({ displayInfo: StreamInfo.NORMAL }); // reconnected
            Stream.set({ mode: StreamMode.QR }); // emits nothing on the client
        });
        expect(events).to.deep.equal([
            ['CONNECTED', 42],
            ['DISCONNECTED', 42],
            ['LOADING', 42],
            ['CONNECTED', 42],
            ['QR', 42],
        ]);
    });

    it('prefers WAWebStreamGetters.getDisplayInfo and re-installs idempotently', function () {
        const events = [];
        const Stream = createStream(StreamMode.MAIN, undefined);
        const pageWindow = createWindow(
            {
                WAWebStreamModel: { Stream, StreamMode, StreamInfo },
                WAWebStreamGetters: { getDisplayInfo: () => StreamInfo.NORMAL },
            },
            events,
        );

        withWindow(pageWindow, () => Client._installWWebStreamWatch());
        withWindow(pageWindow, () => Client._installWWebStreamWatch());
        expect(Stream.listenerCount('change')).to.equal(1);
        expect(events).to.deep.equal([['CONNECTED', 0]]);
    });
});
