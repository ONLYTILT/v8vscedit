import * as assert from 'assert';
import { buildDumpConfigToFilesCommand, buildLoadConfigFromFilesCommand } from '../../domain/agent';

/**
 * Точечная выгрузка `dump --list-file` (plan-archive-avoid.md §4, эксперимент 11/12). Платформа молча
 * принимает и игнорирует неизвестные ключи, а `--list-file` вместе с `--update` отклоняет невнятным
 * `CommandFormatError` только на сервере, уже после побочных эффектов подготовки — поэтому вектор
 * аргументов и guard ловятся тестом самой строки/исключения.
 */
suite('AgentCommand: dump --list-file (точечная выгрузка)', () => {
  test('основная конфигурация: --dir, формат, --force, затем --list-file (порядок ключей фиксирован)', () => {
    assert.strictEqual(
      buildDumpConfigToFilesCommand('exchange/cf-1/restore', { force: true, listFile: 'exchange/cf-1.objects.txt' }),
      'config dump-config-to-files --dir=exchange/cf-1/restore --format=hierarchical --force --list-file=exchange/cf-1.objects.txt'
    );
  });

  test('расширение: --extension сразу после --dir, остальное как у основной конфигурации', () => {
    assert.strictEqual(
      buildDumpConfigToFilesCommand('exchange/cfe-Расш-1/restore', {
        extensionName: 'Расш',
        force: true,
        listFile: 'exchange/cfe-Расш-1.objects.txt',
      }),
      'config dump-config-to-files --dir=exchange/cfe-Расш-1/restore --extension=Расш --format=hierarchical --force --list-file=exchange/cfe-Расш-1.objects.txt'
    );
  });

  test('--list-file вместе с --update — ошибка построения команды с названием обоих ключей (до отправки)', () => {
    assert.throws(
      () => buildDumpConfigToFilesCommand('d', { update: true, listFile: 'l.txt' }),
      (error: unknown) => error instanceof Error
        && error.message === 'Выгрузка агента: ключи --list-file и --update вместе не поддерживаются (list-file + update).'
    );
    assert.throws(
      () => buildDumpConfigToFilesCommand('d', { update: true, force: true, listFile: 'l.txt', extensionName: 'Расш' }),
      /list-file \+ update/
    );
  });

  test('прежние guard\'ы неизменны: --update + --archive по-прежнему ошибка, а update без listFile и listFile без update — нет', () => {
    assert.throws(() => buildDumpConfigToFilesCommand('d', { update: true, archive: 'full.zip' }), /update \+ archive/);
    assert.doesNotThrow(() => buildDumpConfigToFilesCommand('d', { update: true, force: true }));
    assert.doesNotThrow(() => buildDumpConfigToFilesCommand('d', { listFile: 'l.txt' }));
  });

  test('загрузка с --list-file (частичная) этим guard\'ом не затронута', () => {
    assert.strictEqual(
      buildLoadConfigFromFilesCommand('workspace/ab/cf', { partial: true, listFile: 'lists/op.txt' }),
      'config load-config-from-files --dir=workspace/ab/cf --format=hierarchical --list-file=lists/op.txt --partial'
    );
  });
});
