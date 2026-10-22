/**
 * Expose a function to the page if it does not exist
 *
 * NOTE:
 * Rewrite it to 'upsertFunction' after updating Puppeteer to 20.6 or higher
 * using page.removeExposedFunction
 * https://pptr.dev/api/puppeteer.page.removeexposedfunction
 *
 * @param {object} page - Puppeteer Page instance
 * @param {string} name
 * @param {Function} fn
 */
async function exposeFunctionIfAbsent(page, name, fn) {
    const exist = await page.evaluate((name) => {
        return !!window[name];
    }, name);
    if (exist) {
        return;
    }
    for (let attempt = 1; ; attempt++) {
        try {
            await page.exposeFunction(name, fn);
            return;
        } catch (error) {
            // The page may register the binding between evaluate() and
            // exposeFunction(). Treat only that known race as an idempotent result.
            const message = error?.message || String(error);
            if (
                message.includes(`binding with name ${name}`) &&
                message.includes('already exists')
            ) {
                return;
            }
            // A short-lived iframe (e.g. WA's pdf-viewer) torn down mid-call
            // rejects with a frame/target lifecycle error; without a retry
            // attachEventListeners dies and `ready` never fires.
            if (
                attempt >= EXPOSE_MAX_ATTEMPTS ||
                !isTransientExposeError(message)
            ) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        }
    }
}

const EXPOSE_MAX_ATTEMPTS = 5;

function isTransientExposeError(message) {
    return /target closed|detached|destroyed|session closed|execution context/i.test(
        message,
    );
}

module.exports = { exposeFunctionIfAbsent };
