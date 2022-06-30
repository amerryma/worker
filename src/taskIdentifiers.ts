import * as assert from "assert";

import { TaskList, WithPgClient } from "./interfaces";
import { CompiledSharedOptions } from "./lib";

export interface SupportedTaskIdentifierByTaskId {
  [id: number]: string;
}

interface TaskDetails {
  supportedTaskIdentifierByTaskId: SupportedTaskIdentifierByTaskId;
  taskIds: number[];
}

interface Cache {
  lastStr: string | Promise<string>;
  lastDigest: TaskDetails | Promise<TaskDetails>;
}
const cacheByOptions = new Map<CompiledSharedOptions, Cache>();

export function getTaskDetails(
  compiledSharedOptions: CompiledSharedOptions,
  withPgClient: WithPgClient,
  tasks: TaskList,
): TaskDetails | Promise<TaskDetails> {
  let cache = cacheByOptions.get(compiledSharedOptions);
  if (!cache) {
    cache = {
      lastStr: "",
      lastDigest: {
        supportedTaskIdentifierByTaskId: {},
        taskIds: [],
      },
    };
    cacheByOptions.set(compiledSharedOptions, cache);
  }
  const supportedTaskNames = Object.keys(tasks);
  const str = JSON.stringify(supportedTaskNames);
  if (str !== cache.lastStr) {
    const { escapedWorkerSchema } = compiledSharedOptions;
    assert(supportedTaskNames.length, "No runnable tasks!");
    cache.lastStr = str;
    cache.lastDigest = (async () => {
      const { rows } = await withPgClient(async (client) => {
        await client.query({
          text: `insert into ${escapedWorkerSchema}.tasks (identifier) select unnest($1::text[]) on conflict do nothing`,
          values: [supportedTaskNames],
        });
        return client.query<{ id: number; identifier: string }>({
          text: `select id, identifier from ${escapedWorkerSchema}.tasks where identifier = any($1::text[])`,
          values: [supportedTaskNames],
        });
      });

      const supportedTaskIdentifierByTaskId = Object.create(null);
      for (const row of rows) {
        supportedTaskIdentifierByTaskId[row.id] = row.identifier;
      }

      const taskIds = Object.keys(supportedTaskIdentifierByTaskId).map((s) =>
        parseInt(s, 10),
      );

      // Overwrite promises with concrete values
      cache.lastDigest = {
        supportedTaskIdentifierByTaskId,
        taskIds,
      };
      cache.lastStr = str;
      return cache.lastDigest;
    })();
  }
  return cache.lastDigest;
}

export function getSupportedTaskIdentifierByTaskId(
  compiledSharedOptions: CompiledSharedOptions,
  withPgClient: WithPgClient,
  tasks: TaskList,
): SupportedTaskIdentifierByTaskId | Promise<SupportedTaskIdentifierByTaskId> {
  const p = getTaskDetails(compiledSharedOptions, withPgClient, tasks);
  if ("supportedTaskIdentifierByTaskId" in p) {
    return p.supportedTaskIdentifierByTaskId;
  } else {
    return p.then((o) => o.supportedTaskIdentifierByTaskId);
  }
}

export function getSupportedTaskIds(
  compiledSharedOptions: CompiledSharedOptions,
  withPgClient: WithPgClient,
  tasks: TaskList,
): number[] | Promise<number[]> {
  const p = getTaskDetails(compiledSharedOptions, withPgClient, tasks);
  if ("taskIds" in p) {
    return p.taskIds;
  } else {
    return p.then((o) => o.taskIds);
  }
}
