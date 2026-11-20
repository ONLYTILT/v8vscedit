/**
 * Тесты общего взаимного замка операций над конфигурацией/расширением
 * (`src/ui/commands/ext/configurationOperationLock.ts`).
 *
 * Это ИЗВЛЕЧЕНИЕ уже существующего модульного флага `isUpdatingConfigurations`
 * из `ExtensionCommands.ts` (сейчас он там объявлен и переключается трижды —
 * строки ~38/66/123, ~131/136/208, ~949/954/990) в отдельный переиспользуемый
 * модуль: поведение не меняется, тройное дублирование уходит, а новая
 * разрушительная команда (`v8vscedit.loadConfigurationFromCf`) получает тот
 * же взаимный замок, что и импорт/обновление конфигураций.
 *
 * Флаг ОБЩИЙ (module-level singleton) — именно это и проверяет интеграционный
 * тест ниже: замок, взятый ОДНОЙ фичей, реально блокирует другую.
 *
 * `configurationOperationLock.ts` на фазе «красный» ещё не существует —
 * лениво грузится через `tryRequireProductionModule`.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  CONFIGURATION_OPERATION_BUSY_MESSAGE,
  MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE,
  endConfigurationOperation,
  getConfigurationOperationStartedAt,
  isConfigurationOperationRunning,
  runWithConfigurationOperationLock,
  runWithConfigurationOperationLockOrThrow,
  tryBeginConfigurationOperation,
} from '../../ui/commands/ext/configurationOperationLock';
import { waitForNextMillisecond } from './support/mcpFakeExtra';
import { tryRequireProductionModule } from './support/tryRequireProductionModule';

interface ConfigurationOperationLockModule {
  tryBeginConfigurationOperation(): Promise<boolean>;
  endConfigurationOperation(): Promise<void>;
  isConfigurationOperationRunning(): boolean;
}

suite('configurationOperationLock — общий взаимный замок операций над конфигурацией', () => {
  let mod: ConfigurationOperationLockModule | undefined;

  suiteSetup(() => {
    mod = tryRequireProductionModule('../../../ui/commands/ext/configurationOperationLock') as ConfigurationOperationLockModule | undefined;
  });

  test('модуль configurationOperationLock.ts существует и экспортирует API замка', () => {
    assert.ok(mod, 'src/ui/commands/ext/configurationOperationLock.ts ещё не реализован (ожидаемо на фазе «красный» TDD)');
  });

  function m(): ConfigurationOperationLockModule {
    if (!mod) {
      assert.fail('configurationOperationLock.ts не реализован — см. первый тест сьюта');
    }
    return mod;
  }

  // На случай, если предыдущий тест в файле не корректно освободил замок —
  // гарантируем чистое стартовое состояние для каждого теста этого сьюта.
  teardown(async () => {
    if (mod?.isConfigurationOperationRunning()) {
      await mod.endConfigurationOperation();
    }
  });

  test('tryBeginConfigurationOperation на свободном замке возвращает true и isConfigurationOperationRunning() становится true', async () => {
    assert.strictEqual(m().isConfigurationOperationRunning(), false, 'замок обязан быть свободен в начале теста');
    const acquired = await m().tryBeginConfigurationOperation();
    assert.strictEqual(acquired, true);
    assert.strictEqual(m().isConfigurationOperationRunning(), true);
  });

  test('повторный tryBeginConfigurationOperation на занятом замке возвращает false, состояние не меняется', async () => {
    const first = await m().tryBeginConfigurationOperation();
    assert.strictEqual(first, true);

    const second = await m().tryBeginConfigurationOperation();
    assert.strictEqual(second, false, 'занятый замок не должен отдаваться второй раз');
    assert.strictEqual(m().isConfigurationOperationRunning(), true, 'замок обязан остаться занятым после неудачной попытки');
  });

  test('после endConfigurationOperation замок снова свободен, tryBegin возвращает true', async () => {
    assert.strictEqual(await m().tryBeginConfigurationOperation(), true);
    await m().endConfigurationOperation();
    assert.strictEqual(m().isConfigurationOperationRunning(), false);

    const reacquired = await m().tryBeginConfigurationOperation();
    assert.strictEqual(reacquired, true, 'после освобождения замок обязан снова браться');
  });
});

/**
 * Видимость идущей операции для MCP (контракт плана 1.8): момент старта замка и MCP-текст «занято».
 */
suite('configurationOperationLock — момент старта и текст «занято» для MCP', () => {
  const BASE = 'Операция с конфигурацией уже выполняется. Дождитесь её завершения.';
  const MCP_TEXT =
    `${BASE} Состояние идущей операции — v8vscedit_repository_status (operationRunning, currentOperation, lastOperation); повторите вызов после её завершения.`;

  teardown(async () => {
    if (isConfigurationOperationRunning()) {
      await endConfigurationOperation();
    }
  });

  test('замок свободен: момента старта нет', () => {
    assert.strictEqual(getConfigurationOperationStartedAt(), undefined);
  });

  test('tryBegin запоминает момент старта (Date.now в пределах вызова); end сбрасывает', async () => {
    const before = Date.now();
    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    const after = Date.now();
    const startedAt = getConfigurationOperationStartedAt();
    assert.ok(startedAt !== undefined && startedAt >= before && startedAt <= after, `startedAt=${String(startedAt)}`);

    await endConfigurationOperation();
    assert.strictEqual(getConfigurationOperationStartedAt(), undefined);
  });

  test('неудачный повторный tryBegin момент старта чужой операции не меняет', async () => {
    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    const startedAt = getConfigurationOperationStartedAt();
    waitForNextMillisecond();
    assert.strictEqual(await tryBeginConfigurationOperation(), false);
    assert.strictEqual(getConfigurationOperationStartedAt(), startedAt);
  });

  test('runWithConfigurationOperationLockOrThrow: внутри операции момент старта задан, после — сброшен (и при исключении)', async () => {
    let inside: number | undefined;
    await runWithConfigurationOperationLockOrThrow(() => {
      inside = getConfigurationOperationStartedAt();
      return Promise.resolve();
    });
    assert.strictEqual(typeof inside, 'number');
    assert.strictEqual(getConfigurationOperationStartedAt(), undefined);

    await assert.rejects(() => runWithConfigurationOperationLockOrThrow(() => Promise.reject(new Error('сбой'))));
    assert.strictEqual(getConfigurationOperationStartedAt(), undefined);
  });

  test('тексты: базовое сообщение UI не изменилось; MCP-текст = базовое + указание на статус', () => {
    assert.strictEqual(CONFIGURATION_OPERATION_BUSY_MESSAGE, BASE);
    assert.strictEqual(MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE, MCP_TEXT);
    assert.strictEqual(MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE, MCP_TEXT);
  });

  test('OrThrow при занятом замке бросает MCP-текст (смена контракта: прежде — базовый), чужой замок не снят', async () => {
    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    let ran = false;
    await assert.rejects(
      () => runWithConfigurationOperationLockOrThrow(() => { ran = true; return Promise.resolve(); }),
      (error: Error) => error.message === MCP_TEXT
    );
    assert.strictEqual(ran, false);
    assert.strictEqual(isConfigurationOperationRunning(), true);
  });

  test('UI-вариант runWithConfigurationOperationLock при занятом замке показывает ПРЕЖНИЙ текст (без указания на MCP) и возвращает undefined', async () => {
    const infos: string[] = [];
    const w = vscode.window as unknown as { showInformationMessage: unknown };
    const original = w.showInformationMessage;
    w.showInformationMessage = (message: string) => { infos.push(message); return Promise.resolve(undefined); };
    try {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      let ran = false;
      const result = await runWithConfigurationOperationLock(() => { ran = true; return Promise.resolve(1); });
      assert.strictEqual(result, undefined);
      assert.strictEqual(ran, false);
    } finally {
      w.showInformationMessage = original;
    }
    assert.deepStrictEqual(infos, [BASE]);
  });
});
