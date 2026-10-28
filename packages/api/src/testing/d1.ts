import type { Database, SQLQueryBindings } from "bun:sqlite";
import { onTestFinished } from "bun:test";

export interface QueryEvent {
  /** The D1 method that ran the statement; "batch" for a batch member. */
  method: "all" | "batch" | "first" | "raw" | "run";
  sql: string;
  values: readonly SQLQueryBindings[];
}

export interface D1Options {
  /** Runs before each statement; throwing fails it, or its whole batch. */
  onQuery?: (event: QueryEvent) => void;
  /**
   * Runs once a statement's result is ready. For a batch member it runs after
   * the batch commits, so throwing models a response lost after the commit.
   */
  afterQuery?: (event: QueryEvent) => void;
}

/**
 * Serves bun:sqlite through the D1 surface the Worker uses. Each batch is one
 * transaction, as in D1, and hooks for its statements run outside it: a
 * write made by `onQuery` lands before the batch, like a concurrent request.
 */
export function toD1(database: Database, options: D1Options = {}) {
  const prepare = (sql: string) =>
    new TestStatement(database, options, sql, []);
  return {
    batch: async (statements: D1PreparedStatement[]) =>
      runBatch(database, options, statements.map(asTestStatement)),
    exec: async (sql: string) => {
      database.exec(sql);
      return { count: sql.split(";").filter((part) => part.trim()).length };
    },
    prepare,
  } as unknown as D1Database;
}

class TestStatement {
  constructor(
    readonly database: Database,
    readonly options: D1Options,
    readonly sql: string,
    readonly values: readonly SQLQueryBindings[],
  ) {}

  bind(...values: unknown[]) {
    for (const value of values)
      if (value === undefined)
        throw new TypeError(
          `D1_TYPE_ERROR: Type 'undefined' not supported in ${this.sql}`,
        );
    return new TestStatement(
      this.database,
      this.options,
      this.sql,
      values as SQLQueryBindings[],
    );
  }

  async all() {
    return this.#observe("all", () => this.execute());
  }

  async first(column?: string) {
    const row = await this.#observe(
      "first",
      () => this.execute().results[0] ?? null,
    );
    if (row === null || column === undefined) return row;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: ${column}`);
    return row[column];
  }

  async raw(options: { columnNames?: boolean } = {}) {
    return this.#observe("raw", () => {
      const statement = this.database.query(this.sql);
      const rows = statement.values(...this.values) as unknown[][];
      return options.columnNames ? [statement.columnNames, ...rows] : rows;
    });
  }

  async run() {
    return this.#observe("run", () => this.execute());
  }

  event(method: QueryEvent["method"]): QueryEvent {
    return { method, sql: this.sql, values: this.values };
  }

  execute() {
    const before = totalChanges(this.database);
    const results = this.database.query(this.sql).all(...this.values) as Record<
      string,
      unknown
    >[];
    const meta = this.database
      .query("SELECT changes() AS changes, last_insert_rowid() AS last_row_id")
      .get() as { changes: number; last_row_id: number };
    // changes() keeps the previous write's count across reads.
    if (totalChanges(this.database) === before) meta.changes = 0;
    return {
      meta: { ...meta, changed_db: meta.changes > 0, duration: 0 },
      results,
      success: true,
    };
  }

  #observe<T>(method: QueryEvent["method"], execute: () => T) {
    const event = this.event(method);
    this.options.onQuery?.(event);
    const result = execute();
    this.options.afterQuery?.(event);
    return result;
  }
}

function runBatch(
  database: Database,
  options: D1Options,
  statements: TestStatement[],
) {
  const events = statements.map((statement) => statement.event("batch"));
  for (const event of events) options.onQuery?.(event);
  const results = database.transaction(() =>
    statements.map((statement) => statement.execute()),
  )();
  for (const event of events) options.afterQuery?.(event);
  return results;
}

function asTestStatement(statement: D1PreparedStatement) {
  if (statement instanceof TestStatement) return statement;
  throw new TypeError("A batch accepts only statements from the same D1.");
}

function totalChanges(database: Database) {
  return (
    database.query("SELECT total_changes() AS total").get() as {
      total: number;
    }
  ).total;
}

type QueryMatch = string | RegExp | ((event: QueryEvent) => boolean);

export interface QueryHookOptions {
  /** Only statements run through this D1 method. */
  method?: QueryEvent["method"];
  /** How many matching statements the hook runs for; 1 unless set. */
  times?: number;
}

export interface QueryHook {
  /** How many times the hook has run. */
  readonly calls: number;
  /** Stops the hook; a removed hook need not have run. */
  remove(): void;
}

/**
 * Fault and race hooks for `toD1`, matched by SQL text. A test fails if one of
 * its hooks never runs, so rewording a query cannot silently skip its fault.
 */
export function queryHooks() {
  const hooks: Array<{
    action: (event: QueryEvent) => void;
    calls: number;
    match: QueryMatch;
    method: QueryEvent["method"] | undefined;
    phase: "after" | "before";
    remaining: number;
  }> = [];
  const register = (
    phase: "after" | "before",
    match: QueryMatch,
    action: (event: QueryEvent) => void,
    { method, times = 1 }: QueryHookOptions,
  ): QueryHook => {
    const hook = { action, calls: 0, match, method, phase, remaining: times };
    let removed = false;
    hooks.push(hook);
    onTestFinished(() => {
      if (hook.calls > 0 || removed) return;
      const target = method ? `${String(match)} (${method})` : String(match);
      throw new Error(`The ${phase} hook for ${target} never ran.`);
    });
    return {
      get calls() {
        return hook.calls;
      },
      remove: () => {
        removed = true;
        hook.remaining = 0;
      },
    };
  };
  const dispatch = (phase: "after" | "before", event: QueryEvent) => {
    for (const hook of hooks) {
      if (hook.phase !== phase || hook.remaining === 0) continue;
      if (hook.method && hook.method !== event.method) continue;
      if (!matches(hook.match, event)) continue;
      hook.remaining -= 1;
      hook.calls += 1;
      hook.action(event);
    }
  };
  return {
    afterQuery: (event: QueryEvent) => dispatch("after", event),
    onQuery: (event: QueryEvent) => dispatch("before", event),
    /** Runs `action` before the next matching statement executes. */
    before: (
      match: QueryMatch,
      action: (event: QueryEvent) => void,
      options: QueryHookOptions = {},
    ) => register("before", match, action, options),
    /** Runs `action` once the next matching statement's result is ready. */
    after: (
      match: QueryMatch,
      action: (event: QueryEvent) => void,
      options: QueryHookOptions = {},
    ) => register("after", match, action, options),
  };
}

function matches(match: QueryMatch, event: QueryEvent) {
  if (typeof match === "string") return event.sql.includes(match);
  if (match instanceof RegExp) return match.test(event.sql);
  return match(event);
}
