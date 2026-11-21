/**
 * Фейк признака «конфигурация БД отстаёт» для тестов раннеров, цепочек хранилища и MCP-инструментов:
 * хранит состояние в памяти и ведёт журнал вызовов, чтобы порядок и источник `markBehind`/`markCurrent`
 * проверялись точно. Настоящее хранилище (файл, атомарная запись) проверяет `databaseConfigLag.test.ts`.
 */
import {
  lagScopeKey,
  type DatabaseConfigLagRecorder,
  type DatabaseLagEntry,
  type DatabaseLagSource,
  type DatabaseLagTarget,
} from '../../../infra/database/DatabaseConfigLag';

export type LagCall =
  | { readonly op: 'behind'; readonly key: string; readonly source: DatabaseLagSource }
  | { readonly op: 'current'; readonly key: string };

/** Ключ — тот же, что у настоящего хранилища (`lagScopeKey`): фейк не должен расходиться с ним в нормализации. */
export function lagKeyOf(target: DatabaseLagTarget): string {
  return lagScopeKey(target);
}

export class FakeLagRecorder implements DatabaseConfigLagRecorder {
  readonly calls: LagCall[] = [];
  private readonly entries = new Map<string, DatabaseLagEntry>();

  markBehind(target: DatabaseLagTarget, source: DatabaseLagSource): void {
    const key = lagKeyOf(target);
    this.calls.push({ op: 'behind', key, source });
    const previous = this.entries.get(key);
    this.entries.set(key, { ...target, since: previous?.since ?? '2026-01-01T00:00:00.000Z', source });
  }

  markCurrent(target: DatabaseLagTarget): void {
    const key = lagKeyOf(target);
    this.calls.push({ op: 'current', key });
    this.entries.delete(key);
  }

  isBehind(target: DatabaseLagTarget): boolean {
    return this.entries.has(lagKeyOf(target));
  }

  list(): readonly DatabaseLagEntry[] {
    return [...this.entries.values()];
  }

  /** Источник текущей отметки цели (`undefined` — цель не отстаёт). */
  sourceOf(target: DatabaseLagTarget): DatabaseLagSource | undefined {
    return this.entries.get(lagKeyOf(target))?.source;
  }
}
