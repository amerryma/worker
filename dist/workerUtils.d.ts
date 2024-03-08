import { TaskSpec, WorkerUtils, WorkerUtilsOptions } from "./interfaces";
/**
 * Construct (asynchronously) a new WorkerUtils instance.
 */
export declare function makeWorkerUtils(options: WorkerUtilsOptions): Promise<WorkerUtils>;
/**
 * This function can be used to quickly add a job; however if you need to call
 * this more than once in your process you should instead create a WorkerUtils
 * instance for efficiency and performance sake.
 */
export declare function quickAddJob<TIdentifier extends keyof GraphileWorker.Tasks | (string & {}) = string>(options: WorkerUtilsOptions, identifier: TIdentifier, payload: TIdentifier extends keyof GraphileWorker.Tasks ? GraphileWorker.Tasks[TIdentifier] : unknown, spec?: TaskSpec): Promise<import("./interfaces").Job>;
