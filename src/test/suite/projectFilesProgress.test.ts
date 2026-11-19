import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyProjectChanges, projectFileSize } from '../../infra/agent/sync/ProjectFiles';
import { createSyncProgress, type AgentProgressEvent } from '../../infra/agent/sync/SyncProgress';
import { removeTreeSync } from './support/tempTree';

/**
 * Запись в проект (`applyProjectChanges`) сообщает о ходе: этап «Запись в проект: изменено …, удалено …» и
 * счётчик по записываемым файлам. Без `onProgress` поведение прежнее.
 */
suite('applyProjectChanges: прогресс записи', () => {
  let dir: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-apply-progress-'));
    fs.mkdirSync(path.join(dir, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Catalogs', 'Удалить.xml'), 'старое');
  });
  teardown(() => { removeTreeSync(dir); });

  const contents: Record<string, string> = {
    'Configuration.xml': '<Configuration/>',
    'Catalogs/А.xml': '<А/>',
    'Catalogs/Б.xml': '<Б/>',
  };

  const reader = async (rels: readonly string[], sink: (rel: string, data: Uint8Array) => void | Promise<void>): Promise<void> => {
    for (const rel of rels) {
      await sink(rel, Buffer.from(contents[rel]));
    }
  };

  test('с onProgress: этап с числами записи и удаления, затем счётчик от 0 до числа записываемых файлов', async () => {
    const journal: string[] = [];
    const ui: AgentProgressEvent[] = [];
    const progress = createSyncProgress({
      onMessage: (message) => { journal.push(message); },
      onProgress: (event) => { ui.push(event); },
    }, () => 0);

    const changed = await applyProjectChanges({
      projectDir: dir,
      writes: Object.keys(contents),
      deletes: ['Catalogs/Удалить.xml'],
      read: reader,
      onProgress: progress,
    });

    assert.strictEqual(changed.length, 4);
    assert.strictEqual(journal[0], 'Запись в проект: изменено 3, удалено 1');
    const counter = journal.slice(1);
    assert.strictEqual(counter[0], 'Запись в проект: 0 из 3 файлов');
    assert.strictEqual(counter.at(-1), 'Запись в проект: 3 из 3 файлов');
    for (const line of counter) {
      assert.match(line, /^Запись в проект: \d+ из 3 файлов$/);
    }
    assert.deepStrictEqual(ui.map((event) => event.text), journal, 'в UI те же строки');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'Configuration.xml'), 'utf-8'), '<Configuration/>');
    assert.ok(!fs.existsSync(path.join(dir, 'Catalogs', 'Удалить.xml')));
  });

  test('только удаления: этап есть, счётчик файлов молчит (total 0)', async () => {
    const journal: string[] = [];
    const progress = createSyncProgress({ onMessage: (message) => { journal.push(message); } }, () => 0);
    await applyProjectChanges({
      projectDir: dir,
      writes: [],
      deletes: ['Catalogs/Удалить.xml'],
      read: reader,
      onProgress: progress,
    });
    assert.deepStrictEqual(journal, ['Запись в проект: изменено 0, удалено 1']);
  });

  test('изменений нет вовсе: ни записи, ни сообщений', async () => {
    const journal: string[] = [];
    const progress = createSyncProgress({ onMessage: (message) => { journal.push(message); } }, () => 0);
    const changed = await applyProjectChanges({ projectDir: dir, writes: [], deletes: [], read: reader, onProgress: progress });
    assert.deepStrictEqual(changed, []);
    assert.deepStrictEqual(journal, []);
  });

  test('projectFileSize: размер существующего файла в байтах, отсутствующий файл — undefined', () => {
    assert.strictEqual(projectFileSize(dir, 'Catalogs/Удалить.xml'), Buffer.byteLength('старое'));
    assert.strictEqual(projectFileSize(dir, 'Catalogs/Нет.xml'), undefined);
  });

  test('без onProgress: прежнее поведение — те же файлы записаны и удалены, исключений нет', async () => {
    const changed = await applyProjectChanges({
      projectDir: dir,
      writes: Object.keys(contents),
      deletes: ['Catalogs/Удалить.xml'],
      read: reader,
    });
    assert.strictEqual(changed.length, 4);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'Catalogs', 'А.xml'), 'utf-8'), '<А/>');
    assert.ok(!fs.existsSync(path.join(dir, 'Catalogs', 'Удалить.xml')));
  });
});
