/**
 * Чтение каталога пакета перенесено из `cli/commands/cfeBatchShared.ts` в `infra/cfFile/CfeDirectoryListing.ts`
 * (infra не импортирует cli; агентская ветка пакетов живёт в infra). В `cfeBatchShared.ts` остаётся реэкспорт —
 * второй копии нет: проверяем и поведение, и тождество функций.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readCfeDirectoryEntries as cliEntries, readDirectoryFileNames as cliNames } from '../../cli/commands/cfeBatchShared';
import { readCfeDirectoryEntries, readDirectoryFileNames } from '../../infra/cfFile/CfeDirectoryListing';
import { removeTreeSync } from './support/tempTree';

suite('CfeDirectoryListing: перенос в infra + реэкспорт в cli', () => {
  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-cfe-listing-'));
    fs.writeFileSync(path.join(dir, 'Расш.cfe'), 'abcde');
    fs.writeFileSync(path.join(dir, 'пустой.cfe'), '');
    fs.mkdirSync(path.join(dir, 'подкаталог'));
    fs.writeFileSync(path.join(dir, 'подкаталог', 'вложенный.cfe'), 'x');
  });
  teardown(() => { removeTreeSync(dir); });

  test('readCfeDirectoryEntries: только файлы первого уровня, с размерами', () => {
    const entries = readCfeDirectoryEntries(dir).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    assert.deepStrictEqual(entries, [{ name: 'пустой.cfe', sizeBytes: 0 }, { name: 'Расш.cfe', sizeBytes: 5 }]);
  });

  test('readDirectoryFileNames: имена файлов без каталогов; недоступный каталог — пустой список', () => {
    assert.deepStrictEqual(readDirectoryFileNames(dir).sort(), ['Расш.cfe', 'пустой.cfe'].sort());
    assert.deepStrictEqual(readDirectoryFileNames(path.join(dir, 'нет-такого')), []);
  });

  test('cli/commands/cfeBatchShared реэкспортирует ТЕ ЖЕ функции (второй копии нет)', () => {
    assert.strictEqual(cliEntries, readCfeDirectoryEntries);
    assert.strictEqual(cliNames, readDirectoryFileNames);
  });
});
