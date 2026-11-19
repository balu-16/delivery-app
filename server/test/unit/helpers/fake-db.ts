import { jest } from '@jest/globals';
import {
  PostgresQueryCompiler,
  createQueryId,
  type CompiledQuery,
  type RootOperationNode,
} from 'kysely';
import type { Database, TransactionContext } from '../../../src/platform/database/database.js';

/** Routes compiled SQL to canned rows; records every query for call-count assertions. */
export function fakeDatabase(route: (query: CompiledQuery) => { rows: unknown[] }) {
  const queries: CompiledQuery[] = [];
  const compiler = new PostgresQueryCompiler();
  const execute = jest.fn(async (query: CompiledQuery) => {
    queries.push(query);
    return route(query);
  });
  const executor = {
    transformQuery: (query: RootOperationNode) => query,
    compileQuery: (query: RootOperationNode) => compiler.compileQuery(query, createQueryId()),
    executeQuery: execute,
  };
  const tx = { getExecutor: () => executor } as unknown as TransactionContext;
  const transaction = jest.fn(async (work: (tx: TransactionContext) => Promise<unknown>) =>
    work(tx),
  );
  const db = {
    getExecutor: () => executor,
    transaction: () => ({ execute: transaction }),
  } as unknown as Database;
  return { db, queries, transaction };
}
