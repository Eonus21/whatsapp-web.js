const { existsSync } = require('node:fs');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');

const Client = require('../src/Client');
const NoAuth = require('../src/authStrategies/NoAuth');
const { WhatsWebURL } = require('../src/util/Constants');

const expect = chai.expect;
chai.use(chaiAsPromised);

class OfflineAuth extends NoAuth {
    constructor(sandbox) {
        super();
        this.sandbox = sandbox;
        this.fixture = {};
        this.pageErrors = [];
        this.firstDebugRead = new Promise((resolve) => {
            this.onFirstDebugRead = resolve;
        });
    }

    async afterBrowserInitialized() {
        const page = this.client.pupPage;
        page.on('pageerror', (error) => this.pageErrors.push(error));
        const profileArg = this.client.pupBrowser
            .process()
            .spawnargs.find((arg) => arg.startsWith('--user-data-dir='));
        this.profilePath = profileArg.slice('--user-data-dir='.length);

        await page.setOfflineMode(true);
        await page.exposeFunction('onFixtureDebugRead', this.onFirstDebugRead);
        await page.evaluateOnNewDocument(this.installFixture, this.fixture);
        this.waitForFunction = this.sandbox.spy(page, 'waitForFunction');

        const goto = page.goto.bind(page);
        this.sandbox.stub(page, 'goto').callsFake((url, options) => {
            expect(url).to.equal(WhatsWebURL);
            return goto(
                'data:text/html,<title>Offline auth fixture</title>',
                options,
            );
        });
    }

    installFixture = ({
        debug = 'ready',
        socket = 'ready',
        state = 'UNPAIRED',
        socketModel = 'present',
    }) => {
        const trace = (window.fixtureTrace = {
            debugReads: 0,
            socketReads: 0,
            rafRequests: 0,
            refreshQRCalls: 0,
        });
        window.requestAnimationFrame = () => {
            trace.rafRequests++;
            return 0;
        };

        let debugReady = debug === 'ready';
        Object.defineProperty(window, 'Debug', {
            get() {
                trace.debugReads++;
                if (trace.debugReads === 1) {
                    window.onFixtureDebugRead();
                    // Start after the first false predicate, not page load.
                    if (debug === 'delayed') {
                        setTimeout(() => (debugReady = true), 50);
                    }
                }
                return debugReady ? { VERSION: 'offline-fixture' } : undefined;
            },
        });

        class Model {
            constructor() {
                this.listeners = new Map();
            }
            on(event, handler) {
                const handlers = this.listeners.get(event) || [];
                this.listeners.set(event, [...handlers, handler]);
            }
            off(event, handler) {
                const handlers = this.listeners.get(event) || [];
                this.listeners.set(
                    event,
                    handlers.filter((entry) => entry !== handler),
                );
            }
            trigger(event, ...args) {
                for (const handler of this.listeners.get(event) || []) {
                    handler(...args);
                }
            }
        }

        let socketReady = socket === 'ready';
        const readState = () => {
            trace.socketReads++;
            if (trace.socketReads === 1 && socket === 'delayed') {
                setTimeout(() => (socketReady = true), 50);
            }
            return socketReady ? state : 'OPENING';
        };

        const Socket = Object.assign(new Model(), { hasSynced: false });
        Object.defineProperty(Socket, 'state', { get: readState });

        const BackendEventBus = Object.assign(new Model(), {
            triggerRefreshQR() {
                trace.refreshQRCalls++;
            },
        });
        Object.defineProperty(BackendEventBus, 'socketState', {
            get: readState,
        });

        const modules = {
            WAWebSocketModel: socketModel === 'missing' ? null : { Socket },
            WAWebBackendEventBus: {
                BackendEvent: {
                    SET_SOCKET_STATE: 'set_socket_state',
                    REFRESH_QR: 'refresh_qr',
                },
                BackendEventBus,
            },
            WAWebLaunchSocketUtils: {},
            WAWebCmd: { Cmd: new Model() },
            WAWebConnModel: {
                Conn: Object.assign(new Model(), { ref: 'synthetic-ref' }),
            },
            WAWebSignalStoreApi: {
                waSignalStore: {
                    getRegistrationInfo: async () => ({
                        identityKeyPair: { pubKey: new Uint8Array([1, 2, 3]) },
                    }),
                },
            },
            WAWebUserPrefsInfoStore: {
                waNoiseInfo: {
                    get: async () => ({
                        staticKeyPair: { pubKey: new Uint8Array([4, 5, 6]) },
                    }),
                },
            },
            WABase64: {
                encodeB64: (bytes) => btoa(String.fromCharCode(...bytes)),
            },
            WAWebUserPrefsMultiDevice: {
                getADVSecretKey: async () => 'synthetic-only',
            },
            WAWebCompanionRegClientUtils: {
                DEVICE_PLATFORM: 'offline-fixture',
            },
        };
        window.require = (name) => {
            if (!Object.prototype.hasOwnProperty.call(modules, name)) {
                throw new Error(`Unexpected fixture module: ${name}`);
            }
            return modules[name];
        };
    };
}

describe('Client authentication polling (offline)', function () {
    this.timeout(15000);

    let sandbox;
    let auth;
    let client;
    let qr;
    let authenticated;
    let ready;

    beforeEach(function () {
        sandbox = sinon.createSandbox();
        auth = new OfflineAuth(sandbox);
        client = new Client({
            authStrategy: auth,
            authTimeoutMs: 1000,
            userAgent: false,
            webVersionCache: { type: 'none' },
            puppeteer: {
                headless: true,
                args: [
                    '--disable-background-networking',
                    '--disable-component-update',
                    '--disable-domain-reliability',
                    '--disable-sync',
                ],
            },
        });
        qr = sinon.spy();
        authenticated = sinon.spy();
        ready = sinon.spy();
        client.on('qr', qr);
        client.on('authenticated', authenticated);
        client.on('ready', ready);
    });

    afterEach(async function () {
        try {
            await client.destroy();
        } finally {
            sandbox.restore();
        }
        if (auth.profilePath) {
            expect(existsSync(auth.profilePath)).to.equal(false);
        }
        expect(auth.pageErrors).to.deep.equal([]);
    });

    for (const [name, fixture] of [
        ['immediate readiness', {}],
        ['delayed Debug readiness', { debug: 'delayed' }],
        ['delayed socket readiness', { socket: 'delayed' }],
    ]) {
        const title = `should emit one QR with ${name} and no animation callbacks`;

        it(title, async function () {
            auth.fixture = fixture;
            const qrReceived = new Promise((resolve) =>
                client.once('qr', resolve),
            );

            await client.initialize();
            await qrReceived;

            expect(qr.calledOnce).to.equal(true);
            expect(qr.firstCall.args[0]).to.equal(
                'synthetic-ref,BAUG,AQID,synthetic-only,offline-fixture',
            );
            expect(authenticated.called).to.equal(false);
            expect(ready.called).to.equal(false);
            const trace = await client.pupPage.evaluate(
                () => window.fixtureTrace,
            );
            expect(trace.rafRequests).to.equal(0);

            const [debugWait, socketWait] = auth.waitForFunction.getCalls();
            expect(debugWait.args[1].timeout).to.equal(1000);
            expect(debugWait.args[1].signal).to.be.instanceOf(AbortSignal);
            expect(debugWait.args[1].signal.aborted).to.equal(false);
            expect(socketWait.args[1].timeout).to.equal(1000);
            expect(socketWait.args[1]).not.to.have.property('signal');
        });
    }

    it('should still reject when Debug readiness never arrives', async function () {
        auth.fixture = { debug: 'never' };

        const error = await expect(client.initialize()).to.be.rejected;

        expect(error).to.equal('auth timeout');
        expect(qr.called).to.equal(false);
        expect(authenticated.called).to.equal(false);
        expect(ready.called).to.equal(false);
    });

    it('should still reject when the socket stays OPENING', async function () {
        auth.fixture = { socket: 'never' };

        await expect(client.initialize()).to.be.rejectedWith(
            'Waiting failed: 1000ms exceeded',
        );

        expect(qr.called).to.equal(false);
        expect(authenticated.called).to.equal(false);
        expect(ready.called).to.equal(false);
    });

    it('should preserve initial-wait cancellation on destroy', async function () {
        auth.fixture = { debug: 'never' };
        const initialization = client.initialize();
        await auth.firstDebugRead;
        const signal = auth.waitForFunction.firstCall.args[1].signal;

        await client.destroy();
        await initialization;

        expect(signal.aborted).to.equal(true);
        expect(qr.called).to.equal(false);
        expect(authenticated.called).to.equal(false);
        expect(ready.called).to.equal(false);
    });

    it('should propagate an authentication strategy failure', async function () {
        const failure = new Error('Synthetic authentication strategy failure');
        sandbox.stub(auth, 'onAuthenticationNeeded').rejects(failure);

        const error = await expect(client.initialize()).to.be.rejected;

        expect(error).to.equal(failure);
        expect(qr.called).to.equal(false);
        expect(authenticated.called).to.equal(false);
        expect(ready.called).to.equal(false);
    });

    it('should not request authentication for a connected socket', async function () {
        auth.fixture = { state: 'CONNECTED' };
        const onAuthenticationNeeded = sandbox.spy(
            auth,
            'onAuthenticationNeeded',
        );

        await client.initialize();

        expect(onAuthenticationNeeded.called).to.equal(false);
        expect(qr.called).to.equal(false);
        expect(authenticated.called).to.equal(false);
        expect(ready.called).to.equal(false);
    });

    describe('standalone /login/ page (no WAWebSocketModel)', function () {
        it('should emit one QR from the BackendEventBus socket state', async function () {
            auth.fixture = { socketModel: 'missing' };
            const qrReceived = new Promise((resolve) =>
                client.once('qr', resolve),
            );

            await client.initialize();
            await qrReceived;

            expect(qr.calledOnce).to.equal(true);
            expect(qr.firstCall.args[0]).to.equal(
                'synthetic-ref,BAUG,AQID,synthetic-only,offline-fixture',
            );
            expect(authenticated.called).to.equal(false);
            expect(ready.called).to.equal(false);
            expect(await client.getState()).to.equal('UNPAIRED');
        });

        it('should refresh the QR through the BackendEventBus when idle', async function () {
            auth.fixture = { socketModel: 'missing' };
            const qrReceived = new Promise((resolve) =>
                client.once('qr', resolve),
            );
            await client.initialize();
            await qrReceived;

            await client.pupPage.evaluate(() => {
                window
                    .require('WAWebBackendEventBus')
                    .BackendEventBus.trigger(
                        'set_socket_state',
                        'UNPAIRED_IDLE',
                    );
            });
            await client.pupPage.waitForFunction(
                () => window.fixtureTrace.refreshQRCalls === 1,
                { timeout: 3000, polling: 50 },
            );

            expect(authenticated.called).to.equal(false);
            expect(ready.called).to.equal(false);
        });

        it('should still reject when the login page state stays OPENING', async function () {
            auth.fixture = { socketModel: 'missing', socket: 'never' };

            await expect(client.initialize()).to.be.rejectedWith(
                'Waiting failed: 1000ms exceeded',
            );

            expect(qr.called).to.equal(false);
            expect(authenticated.called).to.equal(false);
            expect(ready.called).to.equal(false);
        });
    });
});
