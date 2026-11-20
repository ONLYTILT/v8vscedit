/**
 * Исход последней долгой операции MCP (`lastOperation` в `v8vscedit_repository_status`).
 *
 * При обрыве соединения ответ на долгий вызов может потеряться (окно потери SDK ≈ `retryInterval`,
 * см. docs/mcp-server-lifecycle.md), а операция в расширении доходит до конца под общим замком.
 * Узнать её исход агент может только отсюда. Экземпляр — на сервер, а не на сессию: обрыв может
 * закрыть сессию, и новый клиент должен увидеть исход.
 */

export interface OperationOutcome {
  readonly tool: string;
  /** Мс epoch; в статусе выводится ISO-строкой. */
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly isError: boolean;
  readonly summary: string;
}

/** Предел summary: исход читает агент, полный результат (списки объектов) здесь не нужен. */
export const MAX_OUTCOME_SUMMARY_LENGTH = 300;

export class McpOperationOutcomeRegistry {
  private lastOutcome: OperationOutcome | undefined;

  record(outcome: OperationOutcome): void {
    const summary = outcome.summary.length <= MAX_OUTCOME_SUMMARY_LENGTH
      ? outcome.summary
      : `${outcome.summary.slice(0, MAX_OUTCOME_SUMMARY_LENGTH - 1)}…`;
    this.lastOutcome = { ...outcome, summary };
  }

  last(): OperationOutcome | undefined {
    return this.lastOutcome;
  }
}
