/**
 * Чистые решения импорта конфигураций (`ui/commands/ext/importTargets.ts`): разбор аргумента команды,
 * выбор целей по именам и по корням канона MCP, порядок/дедупликация, сбор целей из дерева и ФС, сводка
 * прогона. Файловая система — настоящие временные каталоги; в `example/` тесты не пишут.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConfigEntry } from '../../domain/Configuration';
import type { ConfigurationImportOutcome } from '../../ui/commands/ext/configurationOperationTypes';
import {
  IMPORT_ARGS_INVALID,
  collectImportTargets,
  isDirectory,
  orderImportTargets,
  parseImportConfigurationsArgs,
  selectImportTargets,
  selectImportTargetsByRoots,
  summarizeImportRun,
  type ImportTarget,
} from '../../ui/commands/ext/importTargets';
import { removeTreeSync } from './support/tempTree';

const cf = (name: string, rootPath = `C:\\ws\\src\\cf`): ImportTarget => ({ kind: 'cf', name, rootPath });
const cfe = (name: string, rootPath = `C:\\ws\\src\\cfe\\${name}`): ImportTarget => ({ kind: 'cfe', name, rootPath });

suite('importTargets: parseImportConfigurationsArgs', () => {
  const foreign: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['число', 5],
    ['строка all (не объект)', 'all'],
    ['массив', ['A']],
    ['пустой объект', {}],
    ['узел дерева webview', { nodeKind: 'configuration', xmlPath: 'C:\\x\\Configuration.xml', label: 'Основная' }],
    ['vscode.Uri', vscode.Uri.file(path.join(os.tmpdir(), 'x'))],
    ['targets только в прототипе', Object.create({ targets: 'all' }) as unknown],
  ];
  for (const [title, arg] of foreign) {
    test(`посторонний аргумент (${title}) → undefined: окно выбора`, () => {
      assert.strictEqual(parseImportConfigurationsArgs(arg), undefined);
    });
  }

  test("{ targets: 'all' } → { kind: 'all' }", () => {
    assert.deepStrictEqual(parseImportConfigurationsArgs({ targets: 'all' }), { kind: 'all' });
  });

  test('{ targets: [имена] } → names с обрезкой крайних пробелов', () => {
    assert.deepStrictEqual(
      parseImportConfigurationsArgs({ targets: ['A', ' b '] }),
      { kind: 'names', names: ['A', 'b'] }
    );
  });

  const invalid: [string, unknown][] = [
    ['пустой массив', []],
    ["'ALL' (регистр)", 'ALL'],
    ['строка-имя', 'x'],
    ['число в массиве', [1]],
    ['пустое имя', ['']],
    ['пробельное имя', ['  ']],
    ['null', null],
    ['undefined', undefined],
    ['объект', {}],
  ];
  for (const [title, targets] of invalid) {
    test(`targets неверной формы (${title}) → исключение IMPORT_ARGS_INVALID`, () => {
      assert.throws(() => parseImportConfigurationsArgs({ targets }), (error: Error) => error.message === IMPORT_ARGS_INVALID);
    });
  }
});

suite('importTargets: selectImportTargets', () => {
  const available = [cf('БП'), cfe('Альфа'), cfe('Бета')];

  test('all → все цели в исходном порядке', () => {
    assert.deepStrictEqual(selectImportTargets(available, { kind: 'all' }), available);
  });

  test('имена без учёта регистра и крайних пробелов', () => {
    assert.deepStrictEqual(selectImportTargets(available, { kind: 'names', names: ['бп', ' БЕТА '] }), [available[0], available[2]]);
  });

  test('повтор имени → одна цель', () => {
    assert.deepStrictEqual(selectImportTargets(available, { kind: 'names', names: ['Альфа', 'альфа'] }), [available[1]]);
  });

  test('одно неизвестное имя → исключение со списком неизвестных и доступных', () => {
    assert.throws(
      () => selectImportTargets(available, { kind: 'names', names: ['Нет'] }),
      (error: Error) => error.message === 'Неизвестные цели импорта: «Нет». Доступны: БП, Альфа, Бета.'
    );
  });

  test('два неизвестных имени → одно исключение с обоими', () => {
    assert.throws(
      () => selectImportTargets(available, { kind: 'names', names: ['Нет1', 'Нет2'] }),
      (error: Error) => error.message === 'Неизвестные цели импорта: «Нет1», «Нет2». Доступны: БП, Альфа, Бета.'
    );
  });

  test('известное вместе с неизвестным → исключение, ничего не возвращается', () => {
    assert.throws(
      () => selectImportTargets(available, { kind: 'names', names: ['БП', 'Нет'] }),
      /Неизвестные цели импорта: «Нет»/
    );
  });

  test('одно имя у cf и у cfe → исключение «неоднозначно», выбор — в окне', () => {
    const ambiguous = [cf('Общее'), cfe('Общее')];
    assert.throws(
      () => selectImportTargets(ambiguous, { kind: 'names', names: ['Общее'] }),
      (error: Error) => error.message.includes('неоднозначн') && error.message.includes('«Общее»')
    );
  });
});

suite('importTargets: selectImportTargetsByRoots', () => {
  const root = path.join(os.tmpdir(), 'imp-roots');
  const available = [cf('БП', path.join(root, 'src', 'cf')), cfe('Расш', path.join(root, 'src', 'cfe', 'Расш'))];

  test('совпадение по нормализованному пути: регистр, разделители, хвостовой слеш', () => {
    const variant = path.join(root, 'SRC', 'cfe', 'расш').split(path.sep).join('/') + '/';
    assert.deepStrictEqual(
      selectImportTargetsByRoots(available, [{ label: 'Расширение', rootDir: variant }]),
      [available[1]]
    );
  });

  test('два элемента на один корень → одна цель', () => {
    assert.deepStrictEqual(
      selectImportTargetsByRoots(available, [
        { label: 'Конфигурация', rootDir: available[0].rootPath },
        { label: 'Конфигурация', rootDir: available[0].rootPath.toUpperCase() },
      ]),
      [available[0]]
    );
  });

  test('корень вне списка → исключение с label', () => {
    assert.throws(
      () => selectImportTargetsByRoots(available, [{ label: 'Расширение (Чужое)', rootDir: path.join(root, 'other') }]),
      (error: Error) => error.message.includes('Расширение (Чужое)')
    );
  });
});

suite('importTargets: orderImportTargets', () => {
  test('cf первым, cfe по localeCompare; вход не мутируется', () => {
    const input = [cfe('Б'), cf('Основная'), cfe('А')];
    const copy = [...input];
    assert.deepStrictEqual(orderImportTargets(input).map((t) => t.name), ['Основная', 'А', 'Б']);
    assert.deepStrictEqual(input, copy);
  });

  test('дубли по rootPath (в т.ч. отличающиеся регистром) удаляются', () => {
    const ordered = orderImportTargets([cf('Основная', 'C:\\ws\\src\\cf'), cf('Основная', 'c:\\WS\\src\\CF')]);
    assert.strictEqual(ordered.length, 1);
  });
});

suite('importTargets: collectImportTargets и isDirectory (временная ФС)', () => {
  let tmp: string;
  setup(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-import-targets-'))); });
  teardown(() => { removeTreeSync(tmp); });

  const writeConfig = (dir: string, name: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'Configuration.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>${name}</Name></Properties></Configuration></MetaDataObject>`
    );
  };

  test('cf + два cfe: имена из Configuration.xml, порядок cf → cfe по алфавиту', () => {
    const cfDir = path.join(tmp, 'src', 'cf');
    const bDir = path.join(tmp, 'src', 'cfe', 'Б');
    const aDir = path.join(tmp, 'src', 'cfe', 'А');
    writeConfig(cfDir, 'Основная');
    writeConfig(bDir, 'РасшБ');
    writeConfig(aDir, 'РасшА');
    const entries: ConfigEntry[] = [{ kind: 'cfe', rootPath: bDir }, { kind: 'cf', rootPath: cfDir }, { kind: 'cfe', rootPath: aDir }];
    assert.deepStrictEqual(collectImportTargets(entries, tmp), [
      { kind: 'cf', name: 'Основная', rootPath: cfDir },
      { kind: 'cfe', name: 'РасшА', rootPath: aDir },
      { kind: 'cfe', name: 'РасшБ', rootPath: bDir },
    ]);
  });

  test('повреждённый Configuration.xml → имя = имя каталога', () => {
    const dir = path.join(tmp, 'src', 'cfe', 'Битое');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Configuration.xml'), '<<<не xml');
    const targets = collectImportTargets([{ kind: 'cfe', rootPath: dir }], tmp);
    assert.strictEqual(targets.find((t) => t.kind === 'cfe')?.name, 'Битое');
  });

  test('src/cf есть, но не в entries → добавлена «Основная конфигурация»', () => {
    const cfDir = path.join(tmp, 'src', 'cf');
    fs.mkdirSync(cfDir, { recursive: true });
    assert.deepStrictEqual(collectImportTargets([], tmp), [{ kind: 'cf', name: 'Основная конфигурация', rootPath: cfDir }]);
  });

  test('src/cf уже в entries (другой регистр пути) → не дублируется', () => {
    const cfDir = path.join(tmp, 'src', 'cf');
    writeConfig(cfDir, 'Основная');
    const entries: ConfigEntry[] = [{ kind: 'cf', rootPath: cfDir.toUpperCase() }];
    const targets = collectImportTargets(entries, tmp);
    assert.strictEqual(targets.filter((t) => t.kind === 'cf').length, 1);
  });

  test('src/cf нет → цель не добавляется', () => {
    assert.deepStrictEqual(collectImportTargets([], tmp), []);
  });

  test('src/cf — файл, а не каталог → цель не добавляется', () => {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'cf'), 'файл');
    assert.deepStrictEqual(collectImportTargets([], tmp), []);
  });

  test('isDirectory: каталог / файл / несуществующий путь', () => {
    const file = path.join(tmp, 'f.txt');
    fs.writeFileSync(file, '1');
    assert.strictEqual(isDirectory(tmp), true);
    assert.strictEqual(isDirectory(file), false);
    assert.strictEqual(isDirectory(path.join(tmp, 'нет')), false);
  });
});

suite('importTargets: summarizeImportRun', () => {
  const ordered = [cf('Основная'), cfe('А'), cfe('Б')];
  const ok = (warnings: string[] = []): ConfigurationImportOutcome => ({ success: true, warnings });

  test('все успешны → все imported', () => {
    const results = summarizeImportRun(ordered, [ok(), ok(), ok()]);
    assert.deepStrictEqual(results.map((r) => r.status), ['imported', 'imported', 'imported']);
    assert.deepStrictEqual(results.map((r) => r.name), ['Основная', 'А', 'Б']);
  });

  test('второй из трёх неуспешен → imported, failed (причина, requiresUserAction, warnings), skipped с «остановлен на»', () => {
    const results = summarizeImportRun(ordered, [
      ok(),
      { success: false, reason: 'нужна полная выгрузка', requiresUserAction: true, warnings: ['w'] },
    ]);
    assert.strictEqual(results[0].status, 'imported');
    assert.strictEqual(results[1].status, 'failed');
    assert.strictEqual(results[1].reason, 'нужна полная выгрузка');
    assert.strictEqual(results[1].requiresUserAction, true);
    assert.deepStrictEqual(results[1].warnings, ['w']);
    assert.strictEqual(results[2].status, 'skipped');
    assert.strictEqual(results[2].reason, 'Не выполнялся: импорт остановлен на «А».');
    assert.deepStrictEqual(results[2].warnings, []);
  });

  test('исходов нет → все skipped', () => {
    const results = summarizeImportRun(ordered, []);
    assert.deepStrictEqual(results.map((r) => r.status), ['skipped', 'skipped', 'skipped']);
  });

  test('warnings успешной цели переносятся', () => {
    const results = summarizeImportRun([cf('Основная')], [ok(['предупреждение'])]);
    assert.deepStrictEqual(results[0].warnings, ['предупреждение']);
  });
});
