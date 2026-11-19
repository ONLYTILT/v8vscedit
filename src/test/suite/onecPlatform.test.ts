import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeInfoBasePath, resolveV8ExecutablePath, resolveV8PathHintFromVersion, resolveV8ThinClientExecutablePath } from '../../infra/process/OnecPlatform';
import { OnecStarterExecutableError } from '../../infra/process/V8ExecutableGuard';

suite('OnecPlatform', () => {
  test('Сохраняет абсолютный путь файловой базы на macOS/Linux', () => {
    assert.strictEqual(
      normalizeInfoBasePath('/Users/test/InfoBases/dev', 'darwin'),
      '/Users/test/InfoBases/dev'
    );
  });

  test('Нормализует Windows-путь файловой базы только на Windows', () => {
    assert.strictEqual(
      normalizeInfoBasePath('C:/InfoBases/dev', 'win32'),
      'C:\\InfoBases\\dev'
    );
  });

  test('Раскрывает домашний каталог на Unix-платформах', () => {
    assert.ok(normalizeInfoBasePath('~/InfoBases/dev', 'linux').endsWith('/InfoBases/dev'));
  });

  test('Берёт бинарник из macOS app, а не ресурс иконки', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-onec-platform-'));
    try {
      const binaryPath = path.join(root, '1cv8.app', 'Contents', 'MacOS', '1cv8');
      const iconPath = path.join(root, '1cv8s.app', 'Contents', 'Resources', '1cv8s.icns');
      fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
      fs.mkdirSync(path.dirname(iconPath), { recursive: true });
      fs.writeFileSync(binaryPath, '');
      fs.writeFileSync(iconPath, '');
      fs.chmodSync(binaryPath, 0o755);
      fs.chmodSync(iconPath, 0o644);

      assert.strictEqual(resolveV8ExecutablePath(root, 'darwin'), binaryPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Предпочитает 1cv8 перед 1cv8c внутри каталога версии', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-onec-priority-'));
    try {
      const thickClient = path.join(root, '1cv8');
      const binClient = path.join(root, 'bin', '1cv8');
      const macOsClient = path.join(root, 'Contents', 'MacOS', '1cv8');
      const thinClient = path.join(root, '1cv8c.app', 'Contents', 'MacOS', '1cv8c');
      fs.mkdirSync(path.dirname(binClient), { recursive: true });
      fs.mkdirSync(path.dirname(macOsClient), { recursive: true });
      fs.mkdirSync(path.dirname(thinClient), { recursive: true });
      fs.writeFileSync(thickClient, '');
      fs.writeFileSync(binClient, '');
      fs.writeFileSync(macOsClient, '');
      fs.writeFileSync(thinClient, '');
      fs.chmodSync(thickClient, 0o755);
      fs.chmodSync(binClient, 0o755);
      fs.chmodSync(macOsClient, 0o755);
      fs.chmodSync(thinClient, 0o755);

      const resolved = resolveV8ExecutablePath(root, 'darwin');
      assert.strictEqual(path.basename(resolved), '1cv8');
      assert.ok(!resolved.includes('1cv8c.app'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Строит macOS-путь к версии платформы из env.json', () => {
    assert.strictEqual(
      resolveV8PathHintFromVersion('8.5.1.1150', 'darwin'),
      '/opt/1cv8/8.5.1.1150'
    );
  });
});

suite('OnecPlatform: тонкий клиент 1cv8c', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-onec-thin-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(...segments: string[]): string {
    const file = path.join(root, ...segments);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  }

  test('win32: --path на каталог bin — берётся 1cv8c.exe рядом с 1cv8.exe', () => {
    touch('bin', '1cv8.exe');
    const thin = touch('bin', '1cv8c.exe');
    assert.strictEqual(resolveV8ThinClientExecutablePath(root, 'win32'), thin);
  });

  test('win32: --path на 1cv8.exe — тонкий клиент из того же каталога', () => {
    const designer = touch('1cv8.exe');
    const thin = touch('1cv8c.exe');
    assert.strictEqual(resolveV8ThinClientExecutablePath(designer, 'win32'), thin);
  });

  test('win32: явный путь к 1CV8C.EXE в кавычках принимается как есть (регистр не важен)', () => {
    const thin = touch('1CV8C.EXE');
    assert.strictEqual(resolveV8ThinClientExecutablePath(`"${thin}"`, 'win32'), thin);
  });

  test('win32: нет 1cv8c.exe — ошибка с именем тонкого клиента, без возврата к 1cv8.exe', () => {
    const designer = touch('1cv8.exe');
    assert.throws(
      () => resolveV8ThinClientExecutablePath(designer, 'win32'),
      (error: unknown) => error instanceof Error
        && error.message.includes('Не найден тонкий клиент 1cv8c.exe')
        && error.message.includes(designer)
    );
  });

  test('win32: явный путь к несуществующему 1cv8c.exe — ошибка резолвера платформы', () => {
    assert.throws(
      () => resolveV8ThinClientExecutablePath(path.join(root, '1cv8c.exe'), 'win32'),
      /Не найден исполняемый файл 1С/
    );
  });

  test('linux: 1cv8 и 1cv8c в каталоге версии — берётся 1cv8c', () => {
    touch('1cv8');
    const thin = touch('1cv8c');
    assert.strictEqual(resolveV8ThinClientExecutablePath(root, 'linux'), thin);
  });

  test('linux: в каталоге только 1cv8c — он же и возвращается', () => {
    const thin = touch('1cv8c');
    assert.strictEqual(resolveV8ThinClientExecutablePath(root, 'linux'), thin);
  });

  test('linux: нет 1cv8c — ошибка с unix-именем тонкого клиента', () => {
    touch('1cv8');
    assert.throws(() => resolveV8ThinClientExecutablePath(root, 'linux'), /Не найден тонкий клиент 1cv8c рядом/);
  });

  test('darwin: тонкий клиент — отдельный бандл 1cv8c.app рядом с 1cv8.app', () => {
    const designer = touch('1cv8.app', 'Contents', 'MacOS', '1cv8');
    const thin = touch('1cv8c.app', 'Contents', 'MacOS', '1cv8c');
    assert.strictEqual(resolveV8ThinClientExecutablePath(designer, 'darwin'), thin);
  });

  test('darwin: 1cv8 вне бандла — 1cv8c ищется в том же каталоге', () => {
    const designer = touch('1cv8');
    const thin = touch('1cv8c');
    assert.strictEqual(resolveV8ThinClientExecutablePath(designer, 'darwin'), thin);
  });

  test('darwin: бандл 1cv8.app без 1cv8c.app — ошибка', () => {
    const designer = touch('1cv8.app', 'Contents', 'MacOS', '1cv8');
    assert.throws(() => resolveV8ThinClientExecutablePath(designer, 'darwin'), /Не найден тонкий клиент 1cv8c/);
  });
});

suite('OnecPlatform: защита от стартера 1cestart.exe', () => {
  let root: string;
  let savedPath: string | undefined;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-onec-starter-'));
    savedPath = process.env.PATH;
  });

  teardown(() => {
    process.env.PATH = savedPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const name of ['1cestart.exe', '1CEStart.EXE']) {
    test(`явный путь к файлу ${name} — OnecStarterExecutableError, а не общая «Не удалось определить»`, () => {
      const file = path.join(root, name);
      fs.writeFileSync(file, '');
      assert.throws(
        () => resolveV8ExecutablePath(file, 'win32'),
        (error: unknown) => error instanceof OnecStarterExecutableError && error.executablePath.toLowerCase().endsWith('1cestart.exe')
      );
    });
  }

  test('явный путь в кавычках к стартеру — тоже отказ (кавычки снимаются до проверки)', () => {
    const file = path.join(root, '1cestart.exe');
    fs.writeFileSync(file, '');
    assert.throws(() => resolveV8ExecutablePath(`"${file}"`, 'win32'), OnecStarterExecutableError);
  });

  test('имя без разделителя «1cestart» и файл в PATH — отказ (ветка findExecutableInPath)', () => {
    const fileName = process.platform === 'win32' ? '1cestart.exe' : '1cestart';
    fs.writeFileSync(path.join(root, fileName), '');
    process.env.PATH = root;
    assert.throws(() => resolveV8ExecutablePath('1cestart', process.platform), OnecStarterExecutableError);
  });

  test('имя «1cestart.exe» с расширением и файл в PATH — отказ', () => {
    fs.writeFileSync(path.join(root, '1cestart.exe'), '');
    process.env.PATH = root;
    assert.throws(() => resolveV8ExecutablePath('1cestart.exe', process.platform), OnecStarterExecutableError);
  });

  test('win32: файл 1CV8.EXE принимается (имя сверяется без учёта регистра)', () => {
    const file = path.join(root, '1CV8.EXE');
    fs.writeFileSync(file, '');
    assert.strictEqual(path.resolve(resolveV8ExecutablePath(file, 'win32')).toLowerCase(), path.resolve(file).toLowerCase());
  });

  test('win32: каталог bin с 1cv8.exe — как прежде', () => {
    const exe = path.join(root, 'bin', '1cv8.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    assert.strictEqual(path.resolve(resolveV8ExecutablePath(root, 'win32')), path.resolve(exe));
  });

  test('win32: явный путь к 1cv8.exe — как прежде', () => {
    const exe = path.join(root, '1cv8.exe');
    fs.writeFileSync(exe, '');
    assert.strictEqual(path.resolve(resolveV8ExecutablePath(exe, 'win32')), path.resolve(exe));
  });
});
