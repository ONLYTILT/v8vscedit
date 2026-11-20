/**
 * Тесты реестра исходов долгих операций MCP (`src/infra/mcp/McpOperationOutcome.ts`, контракт плана 1.6):
 * `lastOperation` в `v8vscedit_repository_status` — единственный надёжный способ узнать исход операции,
 * если ответ потерян при обрыве соединения. Один экземпляр на сервер (живёт дольше сессии).
 */
import * as assert from 'assert';
import { McpOperationOutcomeRegistry, type OperationOutcome } from '../../infra/mcp/McpOperationOutcome';

const outcome = (over: Partial<OperationOutcome> = {}): OperationOutcome => ({
  tool: 'v8vscedit_repository_update',
  startedAt: 1_000,
  finishedAt: 5_000,
  isError: false,
  summary: 'Получено объектов: 3',
  ...over,
});

suite('McpOperationOutcome — реестр исходов', () => {
  const create = () => new McpOperationOutcomeRegistry();

  test('до первой записи исхода нет', () => {
    assert.strictEqual(create().last() ?? null, null);
  });

  test('record → last возвращает записанный исход (успех)', () => {
    const registry = create();
    registry.record(outcome());
    assert.deepStrictEqual(registry.last(), outcome());
  });

  test('ошибка записывается с isError=true и текстом', () => {
    const registry = create();
    registry.record(outcome({ isError: true, summary: 'Нет доступа к хранилищу' }));
    assert.deepStrictEqual(registry.last(), outcome({ isError: true, summary: 'Нет доступа к хранилищу' }));
  });

  test('прерывание (abort) записывается как ошибка с пометкой «прервано»', () => {
    const registry = create();
    registry.record(outcome({ isError: true, summary: 'прервано' }));
    const last = registry.last();
    assert.ok(last);
    assert.strictEqual(last.isError, true);
    assert.strictEqual(last.summary, 'прервано');
  });

  test('хранится только последний исход: новая запись заменяет прежнюю', () => {
    const registry = create();
    registry.record(outcome({ tool: 'v8vscedit_repository_lock', summary: 'первый' }));
    registry.record(outcome({ tool: 'v8vscedit_dump_cf', startedAt: 7_000, finishedAt: 8_000, summary: 'второй' }));
    assert.deepStrictEqual(registry.last(), outcome({ tool: 'v8vscedit_dump_cf', startedAt: 7_000, finishedAt: 8_000, summary: 'второй' }));
  });

  test('экземпляры независимы (реестр на сервер, а не глобальный синглтон модуля)', () => {
    const first = create();
    const second = create();
    first.record(outcome());
    assert.strictEqual(second.last() ?? null, null);
  });

  test('summary ровно 300 символов хранится без изменений', () => {
    const registry = create();
    registry.record(outcome({ summary: 'я'.repeat(300) }));
    assert.strictEqual(registry.last()?.summary, 'я'.repeat(300));
  });

  test('summary длиннее 300 символов обрезается до 300 (полный результат не хранится)', () => {
    const registry = create();
    registry.record(outcome({ summary: 'я'.repeat(5_000) }));
    const summary = registry.last()?.summary ?? '';
    assert.ok(summary.length <= 300, `длина ${String(summary.length)}`);
    assert.ok(summary.startsWith('я'.repeat(290)), 'префикс сохранён (допустим хвостовой маркер обрезки)');
  });
});
