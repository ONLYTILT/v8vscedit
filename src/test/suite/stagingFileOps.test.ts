import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { moveStagingToTarget, type StagingFileOps } from '../../infra/fs/StagingFile';
import { printLogText } from '../../cli/core/onecCommon';
import { captureConsole, type ConsoleCapture } from './support/consoleCapture';

/**
 * Ветки `moveStagingToTarget`, недостижимые на одном томе: EXDEV и прочие сбои rename.
 * Операции — настоящий `fs`; подменяется только `renameSync`, который бросает ошибку
 * с нужным кодом (реальный кросс-томный rename в тесте не воспроизвести).
 */
function opsWithRenameError(code: string): StagingFileOps {
  return {
    existsSync: fs.existsSync,
    rmSync: fs.rmSync,
    copyFileSync: fs.copyFileSync,
    renameSync: () => {
      throw Object.assign(new Error(code), { code });
    },
  };
}

suite('moveStagingToTarget — швы ФС', () => {
  let dir: string;
  let staging: string;
  let target: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-staging-ops-'));
    staging = path.join(dir, 'staging.bin');
    target = path.join(dir, 'target.bin');
    fs.writeFileSync(staging, 'новое');
  });

  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('EXDEV: файл копируется на цель, staging удаляется, исключения нет', () => {
    fs.writeFileSync(target, 'старое');
    moveStagingToTarget(staging, target, opsWithRenameError('EXDEV'));
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'новое');
    assert.strictEqual(fs.existsSync(staging), false);
  });

  test('EXDEV при отсутствующей цели', () => {
    moveStagingToTarget(staging, target, opsWithRenameError('EXDEV'));
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'новое');
    assert.strictEqual(fs.existsSync(staging), false);
  });

  test('иной код ошибки rename пробрасывается, staging остаётся', () => {
    assert.throws(() => moveStagingToTarget(staging, target, opsWithRenameError('EPERM')), /EPERM/);
    assert.strictEqual(fs.existsSync(staging), true);
    assert.strictEqual(fs.existsSync(target), false);
  });

  test('базовый путь: цель существует — заменяется; цели нет — создаётся', () => {
    fs.writeFileSync(target, 'старое');
    moveStagingToTarget(staging, target);
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'новое');
    assert.strictEqual(fs.existsSync(staging), false);

    fs.rmSync(target);
    fs.writeFileSync(staging, 'ещё');
    moveStagingToTarget(staging, target);
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'ещё');
  });
});

suite('printLogText', () => {
  let capture: ConsoleCapture;

  setup(() => {
    capture = captureConsole();
  });

  teardown(() => {
    capture.restore();
  });

  test('пустой лог ничего не печатает', () => {
    printLogText('');
    assert.deepStrictEqual(capture.log, []);
  });

  test('непустой лог обрамляется маркерами', () => {
    printLogText('строка');
    assert.deepStrictEqual(capture.log, ['--- Log ---', 'строка', '--- End ---']);
  });
});
