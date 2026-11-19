import * as assert from 'assert';
import {
  buildAgentCommand,
  buildDumpConfigToFilesCommand,
  buildLoadConfigFromFilesCommand,
  buildUpdateDbCfgCommand,
  quoteAgentArgument,
} from '../../domain/agent';

/**
 * Э7: построители команд агента. Вектор аргументов — под точным регресс-тестом (платформа молча
 * принимает и игнорирует неизвестные ключи, поэтому единственная защита от ошибки в команде —
 * тест самой строки). Факты пилота: `--update` и `--archive` вместе не работают (§5b), `--archive`
 * разрешается относительно `--dir`.
 */
suite('AgentCommand: archive / get-changes / config-dump-info-only (Э7)', () => {
  suite('buildDumpConfigToFilesCommand', () => {
    test('базовая выгрузка: порядок ключей прежний, формат по умолчанию hierarchical', () => {
      assert.strictEqual(
        buildDumpConfigToFilesCommand('workspace/ab/cf'),
        'config dump-config-to-files --dir=workspace/ab/cf --format=hierarchical'
      );
    });

    test('шаг 1 дельта-импорта: --update + --get-changes (список), без --force и --archive', () => {
      assert.strictEqual(
        buildDumpConfigToFilesCommand('workspace/ab/cf', { update: true, getChanges: 'exchange/op1.changes' }),
        'config dump-config-to-files --dir=workspace/ab/cf --format=hierarchical --update --get-changes=exchange/op1.changes'
      );
    });

    test('шаг 2 дельта-импорта: --update --force (как прежняя выгрузка в M)', () => {
      assert.strictEqual(
        buildDumpConfigToFilesCommand('workspace/ab/cf', { update: true, force: true }),
        'config dump-config-to-files --dir=workspace/ab/cf --format=hierarchical --update --force'
      );
    });

    test('архив: --dir отдельный каталог обмена, имя архива относительное (разрешается от --dir)', () => {
      assert.strictEqual(
        buildDumpConfigToFilesCommand('exchange/op1', { archive: 'full.zip' }),
        'config dump-config-to-files --dir=exchange/op1 --format=hierarchical --archive=full.zip'
      );
    });

    test('расширение + архив: --extension идёт сразу после --dir', () => {
      assert.strictEqual(
        buildDumpConfigToFilesCommand('exchange/op1', { extensionName: 'Расш', archive: 'full.zip' }),
        'config dump-config-to-files --dir=exchange/op1 --extension=Расш --format=hierarchical --archive=full.zip'
      );
    });

    test('только файл версий: --config-dump-info-only, с архивом и без', () => {
      assert.strictEqual(
        buildDumpConfigToFilesCommand('cdi', { configDumpInfoOnly: true }),
        'config dump-config-to-files --dir=cdi --format=hierarchical --config-dump-info-only'
      );
      assert.strictEqual(
        buildDumpConfigToFilesCommand('cdi', { configDumpInfoOnly: true, archive: 'cdi.zip' }),
        'config dump-config-to-files --dir=cdi --format=hierarchical --config-dump-info-only --archive=cdi.zip'
      );
    });

    test('--config-dump-info-for-changes передаётся значением (путь со пробелом квотируется)', () => {
      assert.strictEqual(
        buildDumpConfigToFilesCommand('workspace/ab/cf', {
          getChanges: 'exchange/op1.changes',
          configDumpInfoForChanges: 'exchange/old info.xml',
        }),
        'config dump-config-to-files --dir=workspace/ab/cf --format=hierarchical ' +
        '--get-changes=exchange/op1.changes --config-dump-info-for-changes="exchange/old info.xml"'
      );
    });

    test('guard: update вместе с archive — исключение (в паре не работают, факт пилота)', () => {
      assert.throws(
        () => buildDumpConfigToFilesCommand('exchange/op1', { update: true, archive: 'full.zip' }),
        /update.*archive|archive.*update/i
      );
    });

    test('guard не срабатывает на update:false и на архив без update', () => {
      assert.doesNotThrow(() => buildDumpConfigToFilesCommand('d', { update: false, archive: 'a.zip' }));
      assert.doesNotThrow(() => buildDumpConfigToFilesCommand('d', { update: true, getChanges: 'x' }));
    });
  });

  suite('buildLoadConfigFromFilesCommand', () => {
    test('полная загрузка из каталога: прежний вектор не изменился', () => {
      assert.strictEqual(
        buildLoadConfigFromFilesCommand('workspace/ab/cf', { updateConfigDumpInfo: true }),
        'config load-config-from-files --dir=workspace/ab/cf --format=hierarchical --update-config-dump-info'
      );
    });

    test('частичная загрузка: --list-file --partial --no-check, без --update-config-dump-info', () => {
      assert.strictEqual(
        buildLoadConfigFromFilesCommand('workspace/ab/cf', { listFile: 'lists/op1.txt', partial: true, noCheck: true }),
        'config load-config-from-files --dir=workspace/ab/cf --format=hierarchical --list-file=lists/op1.txt --partial --no-check'
      );
    });

    test('загрузка архивом: --dir каталог обмена, --archive относительно него; расширение после --dir', () => {
      assert.strictEqual(
        buildLoadConfigFromFilesCommand('exchange/op1', { archive: 'full.zip' }),
        'config load-config-from-files --dir=exchange/op1 --format=hierarchical --archive=full.zip'
      );
      assert.strictEqual(
        buildLoadConfigFromFilesCommand('exchange/op1', { extensionName: 'Расш', archive: 'full.zip' }),
        'config load-config-from-files --dir=exchange/op1 --extension=Расш --format=hierarchical --archive=full.zip'
      );
    });
  });

  suite('прочие построители (изменённый файл — покрытие веток)', () => {
    test('update-db-cfg: с расширением и без', () => {
      assert.strictEqual(buildUpdateDbCfgCommand(), 'config update-db-cfg');
      assert.strictEqual(buildUpdateDbCfgCommand({ extensionName: 'Расш' }), 'config update-db-cfg --extension=Расш');
    });

    test('buildAgentCommand: undefined и false пропускаются, true — флаг, строка — значение', () => {
      assert.strictEqual(
        buildAgentCommand('config x', { a: undefined, b: false, c: true, d: 'v' }),
        'config x --c --d=v'
      );
      assert.strictEqual(buildAgentCommand('config x'), 'config x');
    });

    test('quoteAgentArgument: простое значение как есть; пробелы, кавычки, апостроф и обратный слэш — в кавычках с экранированием', () => {
      assert.strictEqual(quoteAgentArgument('plain/path.txt'), 'plain/path.txt');
      assert.strictEqual(quoteAgentArgument('a b'), '"a b"');
      assert.strictEqual(quoteAgentArgument('a"b'), '"a\\"b"');
      assert.strictEqual(quoteAgentArgument("it's"), '"it\'s"');
      assert.strictEqual(quoteAgentArgument('a\\b c'), '"a\\\\b c"');
    });
  });
});
