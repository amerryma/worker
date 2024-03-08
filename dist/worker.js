"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeNewWorker = void 0;
const tslib_1 = require("tslib");
const assert = tslib_1.__importStar(require("assert"));
const crypto_1 = require("crypto");
const deferred_1 = tslib_1.__importDefault(require("./deferred"));
const helpers_1 = require("./helpers");
const completeJob_1 = require("./sql/completeJob");
const failJob_1 = require("./sql/failJob");
const getJob_1 = require("./sql/getJob");
function makeNewWorker(compiledSharedOptions, params) {
    const { tasks, withPgClient, continuous, abortSignal, workerPool, autostart = true, workerId = `worker-${(0, crypto_1.randomBytes)(9).toString("hex")}`, } = params;
    const { events, resolvedPreset: { worker: { pollInterval }, }, hooks, _rawOptions: { forbiddenFlags }, } = compiledSharedOptions;
    const logger = compiledSharedOptions.logger.scope({
        label: "worker",
        workerId,
    });
    const workerDeferred = (0, deferred_1.default)();
    const promise = workerDeferred.finally(() => {
        return hooks.process("stopWorker", { worker, withPgClient });
    });
    promise.then(() => {
        events.emit("worker:stop", { worker });
    }, (error) => {
        events.emit("worker:stop", { worker, error });
    });
    let activeJob = null;
    let doNextTimer = null;
    const cancelDoNext = () => {
        if (doNextTimer !== null) {
            clearTimeout(doNextTimer);
            doNextTimer = null;
            return true;
        }
        return false;
    };
    let active = true;
    const release = (force = false) => {
        if (active) {
            active = false;
            events.emit("worker:release", { worker });
            if (cancelDoNext()) {
                workerDeferred.resolve();
            }
            else if (force) {
                // TODO: do `abortController.abort()` instead
                workerDeferred.resolve();
            }
        }
        else if (force) {
            workerDeferred.resolve();
        }
        return Promise.resolve(promise);
    };
    const nudge = () => {
        assert.ok(active, "nudge called after worker terminated");
        if (doNextTimer) {
            // Must be idle; call early
            doNext();
            return true;
        }
        else {
            again = true;
            // Not idle; find someone else!
            return false;
        }
    };
    const worker = {
        workerPool,
        nudge,
        workerId,
        release,
        promise,
        getActiveJob: () => activeJob,
        _start: autostart
            ? null
            : () => {
                doNext(true);
                worker._start = null;
            },
    };
    events.emit("worker:create", { worker, tasks });
    logger.debug(`Spawned`);
    let contiguousErrors = 0;
    let again = false;
    const doNext = async (first = false) => {
        again = false;
        cancelDoNext();
        assert.ok(active, "doNext called when active was false");
        assert.ok(!activeJob, "There should be no active job");
        // Find us a job
        try {
            let flagsToSkip = null;
            if (Array.isArray(forbiddenFlags)) {
                flagsToSkip = forbiddenFlags;
            }
            else if (typeof forbiddenFlags === "function") {
                const forbiddenFlagsResult = forbiddenFlags();
                if (Array.isArray(forbiddenFlagsResult)) {
                    flagsToSkip = forbiddenFlagsResult;
                }
                else if (forbiddenFlagsResult != null) {
                    flagsToSkip = await forbiddenFlagsResult;
                }
            }
            if (first) {
                const event = {
                    worker,
                    flagsToSkip,
                    tasks,
                    withPgClient,
                };
                await hooks.process("startWorker", event);
                flagsToSkip = event.flagsToSkip;
            }
            events.emit("worker:getJob:start", { worker });
            const jobRow = await (0, getJob_1.getJob)(compiledSharedOptions, withPgClient, tasks, workerId, flagsToSkip);
            // `doNext` cannot be executed concurrently, so we know this is safe.
            // eslint-disable-next-line require-atomic-updates
            activeJob = jobRow && jobRow.id ? jobRow : null;
            if (activeJob) {
                events.emit("job:start", { worker, job: activeJob });
            }
            else {
                events.emit("worker:getJob:empty", { worker });
            }
        }
        catch (err) {
            events.emit("worker:getJob:error", { worker, error: err });
            if (continuous) {
                contiguousErrors++;
                logger.debug(`Failed to acquire job: ${err.message} (${contiguousErrors} contiguous fails)`);
                if (active) {
                    // Error occurred fetching a job; try again...
                    doNextTimer = setTimeout(() => doNext(), pollInterval);
                }
                else {
                    workerDeferred.reject(err);
                }
                return;
            }
            else {
                workerDeferred.reject(err);
                release();
                return;
            }
        }
        contiguousErrors = 0;
        // If we didn't get a job, try again later (if appropriate)
        if (!activeJob) {
            if (continuous) {
                if (active) {
                    if (again) {
                        // This could be a synchronisation issue where we were notified of
                        // the job but it's not visible yet, lets try again in just a
                        // moment.
                        doNext();
                    }
                    else {
                        doNextTimer = setTimeout(() => doNext(), pollInterval);
                    }
                }
                else {
                    workerDeferred.resolve();
                }
            }
            else {
                workerDeferred.resolve();
                release();
            }
            return;
        }
        // We did get a job then; store it into the current scope.
        const job = activeJob;
        // We may want to know if an error occurred or not
        let err = null;
        try {
            /*
             * Be **VERY** careful about which parts of this code can throw - we
             * **MUST** release the job once we've attempted it (success or error).
             */
            const startTimestamp = process.hrtime();
            let result = undefined;
            try {
                logger.debug(`Found task ${job.id} (${job.task_identifier})`);
                const task = tasks[job.task_identifier];
                assert.ok(task, `Unsupported task '${job.task_identifier}'`);
                const helpers = (0, helpers_1.makeJobHelpers)(compiledSharedOptions, job, {
                    withPgClient,
                    logger,
                    abortSignal,
                });
                result = await task(job.payload, helpers);
            }
            catch (error) {
                err = error;
            }
            const durationRaw = process.hrtime(startTimestamp);
            const duration = durationRaw[0] * 1e3 + durationRaw[1] * 1e-6;
            // `batchJobFailedPayloads` and `batchJobErrors` should always have the same length
            const batchJobFailedPayloads = [];
            const batchJobErrors = [];
            if (!err && Array.isArray(job.payload) && Array.isArray(result)) {
                if (job.payload.length !== result.length) {
                    console.warn(`Task '${job.task_identifier}' has invalid return value - should return either nothing or an array with the same length as the incoming payload to indicate success or otherwise for each entry. We're going to treat this as full success, but this is a bug in your code.`);
                }
                else {
                    // "Batch job" handling of the result list
                    const results = await Promise.allSettled(result);
                    for (let i = 0; i < job.payload.length; i++) {
                        const entryResult = results[i];
                        if (entryResult.status === "rejected") {
                            batchJobFailedPayloads.push(job.payload[i]);
                            batchJobErrors.push(entryResult.reason);
                        }
                        else {
                            // success!
                        }
                    }
                    if (batchJobErrors.length > 0) {
                        // Create a "partial" error for the batch
                        err = new Error(`Batch failures:\n${batchJobErrors
                            .map((e) => e.message ?? String(e))
                            .join("\n")}`);
                    }
                }
            }
            if (err) {
                try {
                    events.emit("job:error", {
                        worker,
                        job,
                        error: err,
                        batchJobErrors: batchJobErrors.length > 0 ? batchJobErrors : undefined,
                    });
                }
                catch (e) {
                    logger.error("Error occurred in event emitter for 'job:error'; this is an issue in your application code and you should fix it");
                }
                if (job.attempts >= job.max_attempts) {
                    try {
                        // Failed forever
                        events.emit("job:failed", {
                            worker,
                            job,
                            error: err,
                            batchJobErrors: batchJobErrors.length > 0 ? batchJobErrors : undefined,
                        });
                    }
                    catch (e) {
                        logger.error("Error occurred in event emitter for 'job:failed'; this is an issue in your application code and you should fix it");
                    }
                }
                const { message: rawMessage, stack } = err;
                /**
                 * Guaranteed to be a non-empty string
                 */
                const message = rawMessage ||
                    String(err) ||
                    "Non error or error without message thrown.";
                logger.error(`Failed task ${job.id} (${job.task_identifier}, ${duration.toFixed(2)}ms, attempt ${job.attempts} of ${job.max_attempts}) with error '${message}'${stack ? `:\n  ${String(stack).replace(/\n/g, "\n  ").trim()}` : ""}`, { failure: true, job, error: err, duration });
                await (0, failJob_1.failJob)(compiledSharedOptions, withPgClient, workerId, job, message, 
                // "Batch jobs": copy through only the unsuccessful parts of the payload
                batchJobFailedPayloads.length > 0
                    ? batchJobFailedPayloads
                    : undefined);
            }
            else {
                try {
                    events.emit("job:success", { worker, job });
                }
                catch (e) {
                    logger.error("Error occurred in event emitter for 'job:success'; this is an issue in your application code and you should fix it");
                }
                if (!process.env.NO_LOG_SUCCESS) {
                    logger.info(`Completed task ${job.id} (${job.task_identifier}, ${duration.toFixed(2)}ms${job.attempts > 1
                        ? `, attempt ${job.attempts} of ${job.max_attempts}`
                        : ""}) with success`, { job, duration, success: true });
                }
                await (0, completeJob_1.completeJob)(compiledSharedOptions, withPgClient, workerId, job);
            }
            events.emit("job:complete", { worker, job, error: err });
        }
        catch (fatalError) {
            try {
                events.emit("worker:fatalError", {
                    worker,
                    error: fatalError,
                    jobError: err,
                });
            }
            catch (e) {
                logger.error("Error occurred in event emitter for 'worker:fatalError'; this is an issue in your application code and you should fix it");
            }
            const when = err ? `after failure '${err.message}'` : "after success";
            logger.error(`Failed to release job '${job.id}' ${when}; committing seppuku\n${fatalError.message}`, { fatalError, job });
            workerDeferred.reject(fatalError);
            release();
            return;
        }
        finally {
            // `doNext` cannot be executed concurrently, so we know this is safe.
            // eslint-disable-next-line require-atomic-updates
            activeJob = null;
        }
        if (active) {
            doNext();
        }
        else {
            workerDeferred.resolve();
        }
    };
    // Start!
    if (autostart) {
        doNext(true);
    }
    // For tests
    promise.worker = worker;
    return worker;
}
exports.makeNewWorker = makeNewWorker;
//# sourceMappingURL=worker.js.map