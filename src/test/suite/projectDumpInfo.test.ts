import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fingerprintProjectDumpInfo, isProjectDumpReplaced } from '../../infra/agent/sync/ProjectDumpInfo';

/**
 * Отпечаток `ConfigDumpInfo.xml` проекта (plan-archive-avoid.md §3.7): `sha1` + `size` + `mtimeMs`.
 * Файл версий большой конфигурации — десятки мегабайт, поэтому при совпадении `size`+`mtimeMs` с прежним
 * отпечатком sha1 НЕ пересчитывается (файл не читается), а проверка замены при совпадении этих двух
 * признаков тоже не читает файл. Это осознанный компромисс (раздел 5.4 плана): подмена содержимого с тем же
 * размером и восстановленным mtime не обнаруживается — тест документирует его, а не прячет.
 */

const sha1 = (text: string | Buffer): string => createHash('sha1').update(text).digest('hex');
const T1 = new Date('2024-05-17T10:30:00.000Z');
const T2 = new Date('2025-01-02T03:04:05.000Z');

suite('ProjectDumpInfo', () => {
  let dir: string;
  let cdi: string;

  const writeCdi = (content: string | Buffer, mtime: Date = T1): void => {
    fs.writeFileSync(cdi, content);
    fs.utimesSync(cdi, mtime, mtime);
  };

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-project-dumpinfo-'));
    cdi = path.join(dir, 'ConfigDumpInfo.xml');
  });
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  suite('fingerprintProjectDumpInfo', () => {
    test('sha1 содержимого, размер в байтах (UTF-8, кириллица), mtimeMs файла', async () => {
      writeCdi('<ConfigDumpInfo>Кириллица</ConfigDumpInfo>');
      const fp = await fingerprintProjectDumpInfo(dir);
      assert.ok(fp);
      assert.strictEqual(fp.sha1, sha1(fs.readFileSync(cdi)));
      assert.strictEqual(fp.size, Buffer.byteLength('<ConfigDumpInfo>Кириллица</ConfigDumpInfo>', 'utf-8'));
      assert.strictEqual(fp.mtimeMs, fs.statSync(cdi).mtimeMs);
    });

    test('файла нет → undefined (поле из манифеста убирается), в том числе при переданном прежнем отпечатке', async () => {
      assert.strictEqual(await fingerprintProjectDumpInfo(dir), undefined);
      assert.strictEqual(await fingerprintProjectDumpInfo(dir, { sha1: 'x', size: 1, mtimeMs: 2 }), undefined);
    });

    test('на месте файла версий каталог → как отсутствие файла: отпечатка нет, замены нет (не исключение чтения)', async () => {
      fs.mkdirSync(cdi);
      assert.strictEqual(await fingerprintProjectDumpInfo(dir), undefined);
      assert.strictEqual(await isProjectDumpReplaced(dir, { sha1: 'x', size: 1, mtimeMs: 2 }), false);
    });

    test('size и mtime те же, что в прежнем отпечатке → sha1 берётся из него, файл НЕ читается (компромисс документирован)', async () => {
      writeCdi('AAAA');
      const first = await fingerprintProjectDumpInfo(dir);
      assert.ok(first);
      // Подмена содержимого с тем же размером и восстановленным mtime — незаметна по построению.
      writeCdi('BBBB');
      assert.strictEqual(fs.statSync(cdi).mtimeMs, first.mtimeMs);
      const second = await fingerprintProjectDumpInfo(dir, first);
      assert.deepStrictEqual(second, first);
      assert.notStrictEqual(second.sha1, sha1('BBBB'));
    });

    test('прежний отпечаток-маркер с теми же size+mtime возвращается как есть (доказательство «не читали»)', async () => {
      writeCdi('AAAA');
      const stat = fs.statSync(cdi);
      const previous = { sha1: 'маркер-из-манифеста', size: stat.size, mtimeMs: stat.mtimeMs };
      assert.deepStrictEqual(await fingerprintProjectDumpInfo(dir, previous), previous);
    });

    test('другой размер → sha1 пересчитан', async () => {
      writeCdi('AAAA');
      const first = await fingerprintProjectDumpInfo(dir);
      assert.ok(first);
      writeCdi('AAAAAA');
      const second = await fingerprintProjectDumpInfo(dir, first);
      assert.strictEqual(second?.sha1, sha1('AAAAAA'));
      assert.strictEqual(second.size, 6);
    });

    test('другой mtime при том же размере → sha1 пересчитан', async () => {
      writeCdi('AAAA', T1);
      const first = await fingerprintProjectDumpInfo(dir);
      assert.ok(first);
      writeCdi('BBBB', T2);
      const second = await fingerprintProjectDumpInfo(dir, first);
      assert.strictEqual(second?.sha1, sha1('BBBB'));
      assert.strictEqual(second.mtimeMs, fs.statSync(cdi).mtimeMs);
    });

    test('большой файл (несколько МБ) хешируется верно', async () => {
      const big = Buffer.alloc(5 * 1024 * 1024 + 7, 'файл-версий');
      writeCdi(big);
      assert.strictEqual((await fingerprintProjectDumpInfo(dir))?.sha1, sha1(big));
    });
  });

  suite('isProjectDumpReplaced', () => {
    test('stored отсутствует (старый манифест, первый импорт) → false: признака нет, ложного срабатывания тоже', async () => {
      writeCdi('AAAA');
      assert.strictEqual(await isProjectDumpReplaced(dir, undefined), false);
    });

    test('файла нет → false (посев всё равно невозможен)', async () => {
      assert.strictEqual(await isProjectDumpReplaced(dir, { sha1: 'x', size: 1, mtimeMs: 2 }), false);
    });

    test('size и mtime те же → false, содержимое не сравнивается (даже при подмене с тем же размером)', async () => {
      writeCdi('AAAA');
      const stored = await fingerprintProjectDumpInfo(dir);
      assert.ok(stored);
      writeCdi('BBBB');
      assert.strictEqual(await isProjectDumpReplaced(dir, stored), false);
    });

    test('размер другой, содержимое другое → true', async () => {
      writeCdi('AAAA');
      const stored = await fingerprintProjectDumpInfo(dir);
      assert.ok(stored);
      writeCdi('СОВСЕМ ДРУГОЕ СОДЕРЖИМОЕ', T2);
      assert.strictEqual(await isProjectDumpReplaced(dir, stored), true);
    });

    test('mtime другой, размер тот же, содержимое другое → true (sha1 сравнивается)', async () => {
      writeCdi('AAAA', T1);
      const stored = await fingerprintProjectDumpInfo(dir);
      assert.ok(stored);
      writeCdi('BBBB', T2);
      assert.strictEqual(await isProjectDumpReplaced(dir, stored), true);
    });

    test('mtime другой, содержимое то же (копирование/checkout без изменений) → false: sha1 равен', async () => {
      writeCdi('AAAA', T1);
      const stored = await fingerprintProjectDumpInfo(dir);
      assert.ok(stored);
      writeCdi('AAAA', T2);
      assert.strictEqual(await isProjectDumpReplaced(dir, stored), false);
    });

    test('размер другой, но sha1 в stored от нового содержимого (рассинхрон полей) → true по size не наступает ложно: решает sha1', async () => {
      writeCdi('AAAA', T1);
      const stored = { sha1: sha1('AAAA'), size: 999, mtimeMs: fs.statSync(cdi).mtimeMs };
      // size не совпал → проверка идёт по sha1, он равен → замены нет.
      assert.strictEqual(await isProjectDumpReplaced(dir, stored), false);
    });
  });
});
