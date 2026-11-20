/**
 * Тесты ленты этапов операции (`src/infra/progress/OperationStageFeed.ts`, контракт плана 1.1) и её
 * публикации из обоих статус-баров (`configurationOperationStatus.ts`, `repositoryStatusBar.ts`):
 * через статус-бары уже идут `RepositoryCommandRunner.onOutput`, раннер расширения и агент.
 */
import * as assert from 'assert';
import {
  beginConfigurationOperationStatus,
  endConfigurationOperationStatus,
  resetConfigurationOperationStatus,
  setConfigurationOperationStatus,
  updateConfigurationOperationStatus,
} from '../../ui/commands/ext/configurationOperationStatus';
import {
  beginRepositoryOperationStatus,
  disposeRepositoryCommandStatusBar,
  endRepositoryOperationStatus,
  setRepositoryOperationStatus,
  updateRepositoryOperationStatus,
} from '../../ui/commands/repository/repositoryStatusBar';
import {
  MAX_STAGE_LENGTH,
  OperationStageFeed,
  describeRunningOperation,
  type OperationStage,
} from '../../infra/progress/OperationStageFeed';
import { operationStageFeed } from '../../ui/commands/ext/configurationOperationStatus';

suite('OperationStageFeed — лента этапов', () => {
  let clock: number;
  const feed = () => new OperationStageFeed(() => clock);
  setup(() => { clock = 1_000; });

  test('до первой публикации current() пуст', () => {
    assert.strictEqual(feed().current(), undefined);
  });

  test('publish запоминает фазу, заголовок, этап и время часов; следующая публикация заменяет предыдущую', () => {
    const f = feed();
    f.publish('begin', 'Хранилище', 'старт');
    assert.deepStrictEqual(f.current(), { title: 'Хранилище', stage: 'старт', phase: 'begin', at: 1_000 });
    clock = 2_500;
    f.publish('update', 'Хранилище', 'Получение объектов');
    assert.deepStrictEqual(f.current(), { title: 'Хранилище', stage: 'Получение объектов', phase: 'update', at: 2_500 });
    clock = 3_000;
    f.publish('end', 'Хранилище', 'завершено');
    assert.deepStrictEqual(f.current(), { title: 'Хранилище', stage: 'завершено', phase: 'end', at: 3_000 });
  });

  test('часы по умолчанию — Date.now', () => {
    const f = new OperationStageFeed();
    const before = Date.now();
    f.publish('update', 'Т', 'э');
    const at = f.current()?.at ?? -1;
    assert.ok(at >= before && at <= Date.now(), `at=${String(at)}`);
  });

  const NORMALIZATION: readonly { title: string; raw: string; expected: string }[] = [
    { title: 'переводы строк и табуляции — в один пробел', raw: 'шаг 1\nшаг\t2\r\nшаг 3', expected: 'шаг 1 шаг 2 шаг 3' },
    { title: 'повторные пробелы схлопываются', raw: 'a    b     c', expected: 'a b c' },
    { title: 'пробелы по краям срезаются', raw: '   этап   ', expected: 'этап' },
  ];
  for (const { title, raw, expected } of NORMALIZATION) {
    test(`этап: ${title}`, () => {
      const f = feed();
      f.publish('update', 'Т', raw);
      assert.strictEqual(f.current()?.stage, expected);
    });
  }

  test('этап длиннее 200 символов обрезается до 200 вместе с «…»; ровно 200 — без изменений', () => {
    assert.strictEqual(MAX_STAGE_LENGTH, 200);
    const f = feed();
    f.publish('update', 'Т', 'x'.repeat(MAX_STAGE_LENGTH));
    assert.strictEqual(f.current()?.stage, 'x'.repeat(MAX_STAGE_LENGTH));
    f.publish('update', 'Т', 'x'.repeat(MAX_STAGE_LENGTH + 1));
    const stage = f.current()?.stage ?? '';
    assert.ok(stage.length <= MAX_STAGE_LENGTH, `длина ${String(stage.length)}: итог (с «…») не длиннее MAX_STAGE_LENGTH`);
    assert.ok(stage.endsWith('…'), stage);
    assert.ok(stage.startsWith('x'.repeat(MAX_STAGE_LENGTH - 5)), 'префикс сохранён');
  });

  test('нормализация выполняется до обрезки: пробелы не съедают лимит', () => {
    const f = feed();
    f.publish('update', 'Т', `${'x'.repeat(150)}${' \n '.repeat(40)}${'y'.repeat(10)}`);
    assert.strictEqual(f.current()?.stage, `${'x'.repeat(150)} ${'y'.repeat(10)}`);
  });
});

suite('describeRunningOperation — вид идущей операции для v8vscedit_repository_status', () => {
  const STARTED = 1_700_000_000_000;
  const NOW = STARTED + 125_000;
  const stage = (at: number): OperationStage => ({ title: 'Хранилище', stage: 'Получение объектов', phase: 'update', at });

  test('операции нет: operationRunning=false, currentOperation=null (даже при остатках startedAt/этапа)', () => {
    assert.deepStrictEqual(
      describeRunningOperation({ running: false, startedAt: STARTED, stage: stage(STARTED + 1), now: NOW }),
      { operationRunning: false, currentOperation: null }
    );
  });

  test('идёт, но момент старта неизвестен (замок взят не через tryBegin): currentOperation=null', () => {
    assert.deepStrictEqual(
      describeRunningOperation({ running: true, stage: stage(NOW), now: NOW }),
      { operationRunning: true, currentOperation: null }
    );
  });

  test('идёт без этапа: startedAt — ISO-время, elapsedSeconds; полей title/stage нет', () => {
    assert.deepStrictEqual(
      describeRunningOperation({ running: true, startedAt: STARTED, now: NOW }),
      { operationRunning: true, currentOperation: { startedAt: new Date(STARTED).toISOString(), elapsedSeconds: 125 } }
    );
  });

  test('идёт со свежим этапом: добавляются title, stage, stageUpdatedAt (ISO)', () => {
    const at = STARTED + 60_000;
    assert.deepStrictEqual(
      describeRunningOperation({ running: true, startedAt: STARTED, stage: stage(at), now: NOW }),
      {
        operationRunning: true,
        currentOperation: {
          startedAt: new Date(STARTED).toISOString(),
          elapsedSeconds: 125,
          title: 'Хранилище',
          stage: 'Получение объектов',
          stageUpdatedAt: new Date(at).toISOString(),
        },
      }
    );
  });

  test('граница: этап, опубликованный ровно в момент старта, считается свежим', () => {
    const view = describeRunningOperation({ running: true, startedAt: STARTED, stage: stage(STARTED), now: NOW });
    assert.strictEqual(view.currentOperation?.stage, 'Получение объектов');
  });

  test('этап старше старта операции (остаток чужой операции) отбрасывается', () => {
    assert.deepStrictEqual(
      describeRunningOperation({ running: true, startedAt: STARTED, stage: stage(STARTED - 1), now: NOW }),
      { operationRunning: true, currentOperation: { startedAt: new Date(STARTED).toISOString(), elapsedSeconds: 125 } }
    );
  });
});

interface StatusBarApi {
  readonly name: string;
  begin(title: string, message: string): void;
  update(title: string, message: string): void;
  end(title: string, message: string): void;
  setRunning(title: string, message: string, running: boolean): void;
  cleanup(): void;
}

const STATUS_BARS: readonly StatusBarApi[] = [
  {
    name: 'статус-бар конфигурации (configurationOperationStatus)',
    begin: beginConfigurationOperationStatus,
    update: updateConfigurationOperationStatus,
    end: endConfigurationOperationStatus,
    setRunning: setConfigurationOperationStatus,
    cleanup: resetConfigurationOperationStatus,
  },
  {
    name: 'статус-бар хранилища (repositoryStatusBar)',
    begin: beginRepositoryOperationStatus,
    update: updateRepositoryOperationStatus,
    end: endRepositoryOperationStatus,
    setRunning: setRepositoryOperationStatus,
    cleanup: disposeRepositoryCommandStatusBar,
  },
];

suite('Публикация этапов из статус-баров в operationStageFeed', () => {
  for (const bar of STATUS_BARS) {
    suite(bar.name, () => {
      teardown(() => bar.cleanup());

      const reset = (): void => {
        // Единственный экземпляр ленты общий: опорой служит собственная публикация, а не «чистое» начало.
        operationStageFeed.publish('end', 'сброс', 'сброс');
      };

      test('begin / update / end публикуют фазу, заголовок и сообщение', () => {
        reset();
        const feed = operationStageFeed;
        const t0 = Date.now();
        bar.begin('Получение', 'старт');
        assert.deepStrictEqual(feed.current()?.phase, 'begin');
        assert.strictEqual(feed.current()?.title, 'Получение');
        assert.strictEqual(feed.current()?.stage, 'старт');
        assert.ok((feed.current()?.at ?? 0) >= t0);

        bar.update('Получение', 'Объект Товары');
        assert.deepStrictEqual(
          [feed.current()?.phase, feed.current()?.title, feed.current()?.stage],
          ['update', 'Получение', 'Объект Товары']
        );

        bar.end('Получение', 'завершено');
        assert.deepStrictEqual(
          [feed.current()?.phase, feed.current()?.title, feed.current()?.stage],
          ['end', 'Получение', 'завершено']
        );
      });

      test('многострочное сообщение попадает в ленту одной строкой', () => {
        bar.update('Т', 'первая\n  вторая');
        assert.strictEqual(operationStageFeed.current()?.stage, 'первая вторая');
      });

      test('компат-обёртка set…Status: running=true — begin, running=false — end', () => {
        bar.setRunning('Операция', 'идёт', true);
        assert.strictEqual(operationStageFeed.current()?.phase, 'begin');
        bar.setRunning('Операция', 'готово', false);
        assert.deepStrictEqual(
          [operationStageFeed.current()?.phase, operationStageFeed.current()?.stage],
          ['end', 'готово']
        );
      });
    });
  }

  suite('endConfigurationOperationStatus() без аргументов', () => {
    teardown(() => resetConfigurationOperationStatus());

    test('финализирующий вызов без title/message лента не меняет (этап уже выставлен предыдущим шагом)', () => {
      beginConfigurationOperationStatus('Импорт', 'идёт');
      updateConfigurationOperationStatus('Импорт', 'Файл 3');
      const before = operationStageFeed.current();
      endConfigurationOperationStatus();
      assert.deepStrictEqual(operationStageFeed.current(), before);
      assert.strictEqual(before?.phase, 'update');
    });
  });
});
