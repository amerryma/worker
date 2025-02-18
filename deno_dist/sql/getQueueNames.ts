import { EnhancedWithPgClient } from "../interfaces.ts";
import { CompiledSharedOptions } from "../lib.ts";

export async function getQueueNames(
  compiledSharedOptions: CompiledSharedOptions,
  withPgClient: EnhancedWithPgClient,
  queueIds: number[],
): Promise<ReadonlyArray<string | null>> {
  const {
    escapedWorkerSchema,
    workerSchema,
    resolvedPreset: {
      worker: { preparedStatements },
    },
  } = compiledSharedOptions;
  const text = `\
select id, queue_name
from ${escapedWorkerSchema}._private_job_queues as job_queues
where id = any($1::int[]);`;
  const values = [queueIds];
  const name = !preparedStatements
    ? undefined
    : `get_queue_names/${workerSchema}`;

  const { rows } = await withPgClient.withRetries((client) =>
    client.query<{ id: number; queue_name: string }>({
      text,
      values,
      name,
    }),
  );
  // Turn O(M * N) for nested loop into O(M + N) for hash table lookup
  const lookup = Object.create(null);
  for (const row of rows) {
    lookup[row.id] = row.queue_name;
  }
  return queueIds.map((id) => lookup[id] ?? null);
}
