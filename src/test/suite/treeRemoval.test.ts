/**
 * `infra/fs/TreeRemoval.removeTreeSync` — удаление каталога расширения обходом `unlink`/`rmdir` (запрет №19:
 * `fs.rmSync` на Windows молча не удаляет файлы с кириллицей в имени). Используется при отказе подключения
 * расширения (`v8vscedit.connectExtension`).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeTreeSync } from '../../infra/fs/TreeRemoval';
import { removeTreeSync as removeTestTree } from './support/tempTree';

suite('TreeRemoval.removeTreeSync', () => {
  let base: string;
  setup(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-tree-removal-')); });
  teardown(() => { removeTestTree(base); });

  test('каталог с кириллицей во вложенных именах удаляется целиком, соседний — нет', () => {
    const target = path.join(base, 'src', 'cfe', 'Расширение');
    fs.mkdirSync(path.join(target, 'Справочники', 'Контрагенты'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Configuration.xml'), 'x');
    fs.writeFileSync(path.join(target, 'Справочники', 'Контрагенты.xml'), 'x');
    fs.mkdirSync(path.join(base, 'src', 'cfe', 'Соседнее'));

    removeTreeSync(target);

    assert.strictEqual(fs.existsSync(target), false);
    assert.strictEqual(fs.existsSync(path.join(base, 'src', 'cfe', 'Соседнее')), true);
  });

  test('одиночный файл с кириллицей удаляется', () => {
    const file = path.join(base, 'Файл.cfe');
    fs.writeFileSync(file, 'x');
    removeTreeSync(file);
    assert.strictEqual(fs.existsSync(file), false);
  });

  test('отсутствующий путь — не ошибка', () => {
    assert.doesNotThrow(() => removeTreeSync(path.join(base, 'нет-такого')));
  });
});
