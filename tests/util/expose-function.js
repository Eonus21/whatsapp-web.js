const { expect } = require('chai');

const { exposeFunctionIfAbsent } = require('../../src/util/Puppeteer');

function createPage({ present = false, failures = [] } = {}) {
    const calls = { expose: 0 };
    return {
        calls,
        evaluate: async () => present,
        exposeFunction: async () => {
            calls.expose++;
            const next = failures.shift();
            if (next) throw next;
        },
    };
}

async function captureError(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    return undefined;
}

describe('exposeFunctionIfAbsent', function () {
    it('skips exposing when the function already exists', async function () {
        const page = createPage({ present: true });
        await exposeFunctionIfAbsent(page, 'onAddMessageEvent', () => {});
        expect(page.calls.expose).to.equal(0);
    });

    it('treats a concurrent "already exists" binding as success', async function () {
        const page = createPage({
            failures: [
                new Error(
                    'Failed to add page binding with name onAddMessageEvent: window["onAddMessageEvent"] already exists!',
                ),
            ],
        });
        await exposeFunctionIfAbsent(page, 'onAddMessageEvent', () => {});
        expect(page.calls.expose).to.equal(1);
    });

    it('retries transient frame/target errors then succeeds', async function () {
        const page = createPage({
            failures: [
                new Error('Target closed'),
                new Error("Attempted to use detached Frame '28F5ADBA'"),
            ],
        });
        await exposeFunctionIfAbsent(page, 'onAddMessageEvent', () => {});
        expect(page.calls.expose).to.equal(3);
    });

    it('rethrows after exhausting retries', async function () {
        const page = createPage({
            failures: Array.from(
                { length: 10 },
                () => new Error('Target closed'),
            ),
        });
        const err = await captureError(
            exposeFunctionIfAbsent(page, 'onAddMessageEvent', () => {}),
        );
        expect(err).to.be.instanceOf(Error);
        expect(err.message).to.equal('Target closed');
        expect(page.calls.expose).to.equal(5);
    });

    it('fails fast on non-transient errors', async function () {
        const page = createPage({
            failures: [new Error('Protocol error: something else broke')],
        });
        const err = await captureError(
            exposeFunctionIfAbsent(page, 'onAddMessageEvent', () => {}),
        );
        expect(err).to.be.instanceOf(Error);
        expect(page.calls.expose).to.equal(1);
    });
});
