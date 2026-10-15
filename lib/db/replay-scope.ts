import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { assertSameReplayHandlerDatabase, assertVerifiedReplayHandlerDatabase, openVerifiedReplayHandlerDatabase,
  verifyReplayDatabaseSession, type VerifiedReplayDatabase } from "@/lib/operations/pipeline-replay-database";
import { currentReplayTransactionHooks, type ReplayTransactionTicket } from "@/lib/operations/pipeline-replay-execution";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Revoke = (error: Error) => void;
type Scope = { identityPath: string; database: VerifiedReplayDatabase; executor: Db;
  active: boolean; closing: boolean; running: Set<Promise<unknown>>; revoke: Set<Revoke> };
type Transaction = { client: postgres.TransactionSql; active: boolean; closing: boolean;
  parent?: Transaction; ticket?: ReplayTransactionTicket; running: Set<Promise<unknown>>; revoke: Set<Revoke> };
type DriverWork = (client: postgres.TransactionSql) => Promise<unknown>;
const replay = new AsyncLocalStorage<Scope>();

function assertActive(scope: Scope, tx?: Transaction): void {
  if (!scope.active || scope.closing || replay.getStore() !== scope) throw new Error("replay_database_scope_closed");
  assertVerifiedReplayHandlerDatabase(scope.database);
  for (let current = tx; current; current = current.parent)
    if (!current.active || current.closing) throw new Error("replay_transaction_closed");
}
function tracked<T>(scope: Scope, work: () => Promise<T>, tx?: Transaction): Promise<T> {
  assertActive(scope, tx);
  const pending = work();
  scope.running.add(pending);
  tx?.running.add(pending);
  const remove = () => { scope.running.delete(pending); tx?.running.delete(pending); };
  void pending.then(remove, remove);
  return pending;
}

/** postgres.js methods used by the pinned Drizzle adapter; no raw client escapes. */
function guardedClient(scope: Scope, transaction?: Transaction): postgres.Sql {
  async function transact(work: DriverWork): Promise<unknown> {
    assertActive(scope, transaction);
    return tracked(scope, async () => {
      const hooks = currentReplayTransactionHooks(scope.database);
      let ticket: ReplayTransactionTicket | undefined;
      let committed = false;
      const run = async (raw: postgres.TransactionSql) => {
        const current: Transaction = { client: raw, active: true, closing: false, parent: transaction,
          running: new Set(), revoke: new Set() };
        let revoke!: Revoke;
        const closed = new Promise<never>((_resolve, reject) => {
          revoke = reject;
        });
        try {
          assertActive(scope, transaction);
          await verifyReplayDatabaseSession(raw, scope.database);
          assertActive(scope, transaction);
          ticket = await hooks.before(raw, transaction?.ticket);
          current.ticket = ticket;
          assertActive(scope, transaction);
          scope.revoke.add(revoke);
          transaction?.revoke.add(revoke);
          // Revoking callback work makes the native transaction roll back. Late callback
          // continuations retain a closed driver token and cannot issue another statement.
          const result = await Promise.race([work(guardedClient(scope, current) as unknown as postgres.TransactionSql), closed]);
          assertActive(scope, current);
          if (current.running.size) throw new Error("replay_transaction_work_not_awaited");
          // Fence callback descendants before the final verifier yields to the event loop.
          current.closing = true;
          if (ticket) await hooks.after(raw, ticket);
          await verifyReplayDatabaseSession(raw, scope.database);
          assertActive(scope, transaction);
          return result;
        } finally {
          current.closing = true;
          for (const cancel of current.revoke) cancel(new Error("replay_transaction_closed"));
          await Promise.allSettled([...current.running]);
          current.active = false;
          scope.revoke.delete(revoke); transaction?.revoke.delete(revoke);
        }
      };
      try {
        const result = await (transaction ? transaction.client.savepoint(run) : scope.database.client.begin(run));
        committed = true;
        // A savepoint release is not a database COMMIT. Failed acknowledgments remain
        // unresolved in the ledger; never run rollback cleanup after native commit.
        if (!transaction && ticket) await hooks.commitAck(ticket);
        return result;
      } catch (error) {
        if (!committed && ticket) await hooks.rollback(ticket);
        throw error;
      }
    }, transaction);
  }
  function unsafe(...args: Parameters<postgres.Sql["unsafe"]>) {
    // Drizzle builders are lazy. Check again when the query is actually consumed.
    let pending: Promise<unknown> | undefined;
    let arrayMode = false;
    const start = () => pending ??= tracked(scope, async () => {
      assertActive(scope, transaction);
      const execute = (client: postgres.TransactionSql) => {
        const query = client.unsafe(...args);
        return arrayMode ? query.values() : query;
      };
      if (transaction) return execute(transaction.client);
      // Auto statements get the same verified commit boundary as explicit writers.
      return transact(async client => arrayMode ? client.unsafe(...args).values() : client.unsafe(...args));
    }, transaction);
    const result = {
      then: <T, U>(ok?: ((value: unknown) => T | PromiseLike<T>) | null, error?: ((reason: unknown) => U | PromiseLike<U>) | null) => start().then(ok, error),
      catch: <T>(error: (reason: unknown) => T | PromiseLike<T>) => start().catch(error),
      finally: (done: () => void) => start().finally(done),
      values() { if (pending && !arrayMode) throw new Error("replay_query_already_started"); arrayMode = true; return result; },
    };
    return result;
  }
  return {
    // Drizzle changes date/JSON parsers. This connection belongs exclusively to this scope.
    options: scope.database.client.options,
    unsafe,
    begin: transact,
    savepoint: transact,
  } as unknown as postgres.Sql;
}

function guardExecutor(scope: Scope, executor: Db): Db {
  return new Proxy(executor, {
    get(target, prop) {
      assertActive(scope);
      if (prop === "$client") throw new Error("replay_raw_client_rejected");
      const value = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (...args: unknown[]) => { assertActive(scope); return Reflect.apply(value, target, args); }
        : value;
    },
  });
}

/** Inactive inherited contexts fail closed instead of falling back to a live DB. */
export function currentReplayDb(): Db | undefined {
  const scope = replay.getStore();
  if (!scope) return undefined;
  assertActive(scope);
  return scope.executor;
}

/** Bind a separately owned ledger connection without exposing its private target/nonce. */
export function assertReplayDatabaseScopeIdentity(expected: VerifiedReplayDatabase): void {
  const scope = replay.getStore();
  if (!scope) throw new Error("replay_database_scope_required");
  assertActive(scope);
  assertSameReplayHandlerDatabase(scope.database, expected);
}

/** Explicit runner entry only. Opens a fresh restricted local connection and always closes it. */
export async function withReplayDatabaseScope<T>(identityPath: string, load: () => Promise<T>): Promise<T> {
  const enclosing = replay.getStore();
  if (enclosing) {
    assertActive(enclosing);
    if (enclosing.identityPath !== identityPath) throw new Error("replay_database_scope_conflict");
    return load();
  }
  // The verified identity selects this DB; never rewrite or consume the live singleton URL.
  // The opener separately rejects real PG*/replica/migration ambient overrides.
  const database = await openVerifiedReplayHandlerDatabase(identityPath, {});
  const scope: Scope = { identityPath, database, executor: undefined as unknown as Db,
    active: true, closing: false, running: new Set(), revoke: new Set() };
  try {
    assertVerifiedReplayHandlerDatabase(database);
    scope.executor = guardExecutor(scope, drizzle(guardedClient(scope), { schema }));
    return await replay.run(scope, async () => {
      try { return await load(); }
      finally {
        scope.closing = true;
        const unfinished = [...scope.running];
        for (const revoke of scope.revoke) revoke(new Error("replay_database_scope_closed"));
        await Promise.allSettled(unfinished);
        if (unfinished.length) throw new Error("replay_database_work_not_awaited");
      }
    });
  } finally {
    scope.active = false;
    await database.close();
  }
}
