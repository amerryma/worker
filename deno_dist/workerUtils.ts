/* eslint-disable @typescript-eslint/ban-types */
import { cleanup } from "./cleanup.ts";
import {
  CleanupTask,
  DbJob,
  TaskSpec,
  WorkerUtils,
  WorkerUtilsOptions,
} from "./interfaces.ts";
import { getUtilsAndReleasersFromOptions } from "./lib.ts";
import { migrate } from "./migrate.ts";

/**
 * Construct (asynchronously) a new WorkerUtils instance.
 */
export async function makeWorkerUtils(
  options: WorkerUtilsOptions,
): Promise<WorkerUtils> {
  const [compiledOptions, release] = await getUtilsAndReleasersFromOptions(
    options,
    {
      scope: {
        label: "WorkerUtils",
      },
    },
  );
  const { logger, escapedWorkerSchema, withPgClient, addJob } = compiledOptions;

  return {
    withPgClient,
    logger,
    release,
    addJob,
    migrate: () =>
      withPgClient((pgClient) => migrate(compiledOptions, pgClient)),

    async completeJobs(ids) {
      const { rows } = await withPgClient((client) =>
        client.query<DbJob>(
          `select * from ${escapedWorkerSchema}.complete_jobs($1::bigint[])`,
          [ids],
        ),
      );
      return rows;
    },

    async permanentlyFailJobs(ids, reason) {
      const { rows } = await withPgClient((client) =>
        client.query<DbJob>(
          `select * from ${escapedWorkerSchema}.permanently_fail_jobs($1::bigint[], $2::text)`,
          [ids, reason || null],
        ),
      );
      return rows;
    },

    async rescheduleJobs(ids, options) {
      const { rows } = await withPgClient((client) =>
        client.query<DbJob>(
          `select * from ${escapedWorkerSchema}.reschedule_jobs(
            $1::bigint[],
            run_at := $2::timestamptz,
            priority := $3::int,
            attempts := $4::int,
            max_attempts := $5::int
          )`,
          [
            ids,
            options.runAt || null,
            options.priority || null,
            options.attempts || null,
            options.maxAttempts || null,
          ],
        ),
      );
      return rows;
    },

    async forceUnlockWorkers(workerIds) {
      await withPgClient((client) =>
        client.query(
          `select ${escapedWorkerSchema}.force_unlock_workers($1::text[]);`,
          [workerIds],
        ),
      );
    },

    async cleanup(
      options: { tasks?: CleanupTask[] } = {
        tasks: ["GC_JOB_QUEUES"],
      },
    ): Promise<void> {
      return cleanup(compiledOptions, options.tasks);
    },
  };
}

/**
 * This function can be used to quickly add a job; however if you need to call
 * this more than once in your process you should instead create a WorkerUtils
 * instance for efficiency and performance sake.
 */
export async function quickAddJob<
  TIdentifier extends keyof GraphileWorker.Tasks | (string & {}) = string,
>(
  options: WorkerUtilsOptions,
  identifier: TIdentifier,
  payload: TIdentifier extends keyof GraphileWorker.Tasks
    ? GraphileWorker.Tasks[TIdentifier]
    : unknown,
  spec: TaskSpec = {},
) {
  const utils = await makeWorkerUtils(options);
  try {
    return await utils.addJob<TIdentifier>(identifier, payload, spec);
  } finally {
    await utils.release();
  }
}
