import * as assert from 'assert';
import {
  OnecStarterExecutableError,
  assertNotOnecStarter,
  assertServerDesignerExecutable,
  classifyV8Executable,
  type V8ExecutableKind,
} from '../../infra/process/V8ExecutableGuard';

suite('V8ExecutableGuard: классификация исполняемого файла 1С', () => {
  const table: [string, V8ExecutableKind][] = [
    ['1cv8.exe', 'designer'],
    ['1CV8.EXE', 'designer'],
    ['1cv8', 'designer'],
    ['C:\\Program Files\\1cv8\\8.3.27.2130\\bin\\1cv8.exe', 'designer'],
    ['C:/Program Files/1cv8/8.3.27.2130/bin/1cv8.exe', 'designer'],
    ['/opt/1cv8/x86_64/8.3.27/1cv8', 'designer'],
    ['1cestart.exe', 'starter'],
    ['1CEStart.EXE', 'starter'],
    ['1cestart', 'starter'],
    ['C:\\Program Files\\1cv8\\common\\1cestart.exe', 'starter'],
    ['C:/Program Files/1cv8/common/1cestart.exe', 'starter'],
    ['\\\\srv\\share\\common\\1CEStart.exe', 'starter'],
    ['1cv8c.exe', 'other'],
    ['ibcmd.exe', 'other'],
    ['', 'other'],
    // Кавычки снимает вызывающий: классификатор их не трогает, поэтому имя с кавычкой — не стартер.
    ['"C:\\Program Files\\1cv8\\common\\1cestart.exe"', 'other'],
  ];
  for (const [input, expected] of table) {
    test(`${JSON.stringify(input)} → ${expected}`, () => {
      assert.strictEqual(classifyV8Executable(input), expected);
    });
  }
});

suite('V8ExecutableGuard: assertNotOnecStarter', () => {
  const STARTER = 'C:\\Program Files\\1cv8\\common\\1cestart.exe';

  test('стартер: OnecStarterExecutableError с путём, источником и пояснением', () => {
    assert.throws(
      () => assertNotOnecStarter(STARTER, 'v8vscedit.remote.v8Path'),
      (error: unknown) => {
        assert.ok(error instanceof OnecStarterExecutableError);
        assert.ok(error instanceof Error);
        assert.strictEqual(error.executablePath, STARTER);
        assert.strictEqual(error.source, 'v8vscedit.remote.v8Path');
        for (const part of ['v8vscedit.remote.v8Path', '1cestart.exe', '1cv8.exe', 'Ошибка блокировки информационной базы', STARTER]) {
          assert.ok(error.message.includes(part), `нет «${part}» в: ${error.message}`);
        }
        return true;
      }
    );
  });

  for (const ok of ['C:\\Program Files\\1cv8\\8.3.27.2130\\bin\\1cv8.exe', '/opt/1cv8/1cv8', '1cv8c.exe', '']) {
    test(`не стартер (${JSON.stringify(ok)}) — не бросает`, () => {
      assert.doesNotThrow(() => assertNotOnecStarter(ok, 'источник'));
    });
  }
});

suite('V8ExecutableGuard: assertServerDesignerExecutable', () => {
  test('1cv8.exe (любой регистр, любой разделитель) — допустим', () => {
    for (const ok of ['C:\\1c\\bin\\1cv8.exe', 'C:/1c/bin/1CV8.EXE', '1cv8.exe']) {
      assert.doesNotThrow(() => assertServerDesignerExecutable(ok, 'v8vscedit.remote.v8Path'));
    }
  });

  test('стартер — OnecStarterExecutableError', () => {
    assert.throws(
      () => assertServerDesignerExecutable('C:\\Program Files\\1cv8\\common\\1CEStart.exe', 'v8vscedit.remote.v8Path'),
      OnecStarterExecutableError
    );
  });

  test('иной файл (1cv8c.exe) — обычная Error «не 1cv8.exe» с источником', () => {
    assert.throws(
      () => assertServerDesignerExecutable('C:\\1c\\bin\\1cv8c.exe', 'v8vscedit.remote.v8Path'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof OnecStarterExecutableError));
        assert.match(error.message, /не 1cv8\.exe/);
        assert.ok(error.message.includes('v8vscedit.remote.v8Path'));
        return true;
      }
    );
  });

  test('Unix-файл 1cv8 без расширения для сервера Windows — не 1cv8.exe', () => {
    assert.throws(() => assertServerDesignerExecutable('/opt/1cv8/1cv8', 'src'), /не 1cv8\.exe/);
  });
});
