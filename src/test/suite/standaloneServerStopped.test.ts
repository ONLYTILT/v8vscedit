/**
 * `runWithStandaloneServerStopped` (ExtensionCommands.ts): остановка автономного сервера на время операции и
 * перезапуск после успеха. Параметр `interaction`: в unattended тосты о неудачном перезапуске не показываются,
 * их тексты уходят в `onWarning` (MCP получает их в ответе). Автономный сервер — внешний процесс, подменяется
 * фейком `standaloneServerService`; журнал и статус — настоящие функции.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { CommandServices } from '../../ui/commands/_shared';
import { runWithStandaloneServerStopped } from '../../ui/commands/ext/ExtensionCommands';

type Fn = (...args: never[]) => unknown;
const win = vscode.window as unknown as Record<string, Fn>;

interface Health { configured: boolean; state: string }
interface Fake {
  health: Health;
  startResult: { state: string; message: string };
  startError?: Error;
  stops: number;
  starts: number;
  lines: string[];
  warnings: string[];
  errors: string[];
}

suite('runWithStandaloneServerStopped', () => {
  let fake: Fake;
  let services: CommandServices;
  const originals = new Map<string, Fn>();

  setup(() => {
    fake = {
      health: { configured: true, state: 'running' },
      startResult: { state: 'running', message: 'ok' },
      stops: 0, starts: 0, lines: [], warnings: [], errors: [],
    };
    services = {
      outputChannel: { appendLine: (line: string) => { fake.lines.push(line); }, show: () => undefined },
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ ...fake.health, pid: 1 }),
        stop: () => { fake.stops += 1; return Promise.resolve(); },
        start: () => {
          fake.starts += 1;
          return fake.startError ? Promise.reject(fake.startError) : Promise.resolve(fake.startResult);
        },
      },
      refreshActionsView: () => undefined,
      setTreeProcessingState: () => undefined,
    } as unknown as CommandServices;
    for (const name of ['showWarningMessage', 'showErrorMessage'] as const) {
      originals.set(name, win[name]);
    }
    win.showWarningMessage = (message: string) => { fake.warnings.push(message); return Promise.resolve(undefined); };
    win.showErrorMessage = (message: string) => { fake.errors.push(message); return Promise.resolve(undefined); };
  });
  teardown(() => {
    for (const [name, fn] of originals) { win[name] = fn; }
  });

  for (const interaction of ['interactive', 'unattended'] as const) {
    suite(interaction, () => {
      const run = (operation: () => Promise<boolean>, onWarning?: (text: string) => void): Promise<boolean> =>
        runWithStandaloneServerStopped(services, 'Импорт', operation, interaction, onWarning);

      test('сервер не настроен → операция без остановки и запуска', async () => {
        fake.health = { configured: false, state: 'running' };
        assert.strictEqual(await run(() => Promise.resolve(true)), true);
        assert.deepStrictEqual([fake.stops, fake.starts], [0, 0]);
      });

      test('сервер не запущен (stopped) → операция без остановки', async () => {
        fake.health = { configured: true, state: 'stopped' };
        assert.strictEqual(await run(() => Promise.resolve(true)), true);
        assert.deepStrictEqual([fake.stops, fake.starts], [0, 0]);
      });

      test('running: stop → операция true → start → running; ни тостов, ни предупреждений', async () => {
        const warnings: string[] = [];
        assert.strictEqual(await run(() => Promise.resolve(true), (text) => { warnings.push(text); }), true);
        assert.deepStrictEqual([fake.stops, fake.starts], [1, 1]);
        assert.deepStrictEqual([fake.warnings, fake.errors, warnings], [[], [], []]);
      });

      test('unresponsive тоже останавливается', async () => {
        fake.health = { configured: true, state: 'unresponsive' };
        assert.strictEqual(await run(() => Promise.resolve(true)), true);
        assert.deepStrictEqual([fake.stops, fake.starts], [1, 1]);
      });

      test('start вернул state не running: interactive — showWarningMessage; unattended — onWarning без тоста', async () => {
        fake.startResult = { state: 'stopped', message: 'порт занят' };
        const warnings: string[] = [];
        assert.strictEqual(await run(() => Promise.resolve(true), (text) => { warnings.push(text); }), true);
        if (interaction === 'interactive') {
          assert.strictEqual(fake.warnings.length, 1);
          assert.ok(fake.warnings[0].includes('порт занят'), fake.warnings[0]);
          assert.deepStrictEqual(warnings, []);
        } else {
          assert.deepStrictEqual(fake.warnings, []);
          assert.strictEqual(warnings.length, 1);
          assert.ok(warnings[0].includes('порт занят'), warnings[0]);
        }
        assert.deepStrictEqual(fake.errors, []);
      });

      test('start бросил: interactive — showErrorMessage; unattended — onWarning без тоста; операция всё равно true', async () => {
        fake.startError = new Error('не запустился');
        const warnings: string[] = [];
        assert.strictEqual(await run(() => Promise.resolve(true), (text) => { warnings.push(text); }), true);
        if (interaction === 'interactive') {
          assert.strictEqual(fake.errors.length, 1);
          assert.ok(fake.errors[0].includes('не запустился'), fake.errors[0]);
          assert.deepStrictEqual(warnings, []);
        } else {
          assert.deepStrictEqual(fake.errors, []);
          assert.strictEqual(warnings.length, 1);
          assert.ok(warnings[0].includes('не запустился'), warnings[0]);
        }
        assert.deepStrictEqual(fake.warnings, []);
      });

      test('операция неуспешна (false): предупреждение об остановленном сервере — только в unattended', async () => {
        const warnings: string[] = [];
        assert.strictEqual(await run(() => Promise.resolve(false), (text) => { warnings.push(text); }), false);
        assert.deepStrictEqual(
          warnings,
          interaction === 'unattended'
            ? ['Автономный сервер остановлен и не перезапущен: операция "Импорт" завершилась с ошибкой.']
            : []
        );
      });

      test('операция бросила: исключение пробрасывается, предупреждение об остановленном сервере — только в unattended', async () => {
        const warnings: string[] = [];
        await assert.rejects(
          () => run(() => Promise.reject(new Error('сбой операции')), (text) => { warnings.push(text); }),
          /сбой операции/
        );
        assert.strictEqual(fake.starts, 0);
        assert.deepStrictEqual(
          warnings,
          interaction === 'unattended'
            ? ['Автономный сервер остановлен и не перезапущен: операция "Импорт" завершилась с ошибкой.']
            : []
        );
      });

      test('операция вернула false → сервер не запускается, тостов нет', async () => {
        assert.strictEqual(await run(() => Promise.resolve(false)), false);
        assert.deepStrictEqual([fake.stops, fake.starts], [1, 0]);
        assert.deepStrictEqual([fake.warnings, fake.errors], [[], []]);
      });
    });
  }

  test('без указания interaction — прежнее поведение (interactive): предупреждение показывается тостом', async () => {
    fake.startResult = { state: 'stopped', message: 'порт занят' };
    assert.strictEqual(await runWithStandaloneServerStopped(services, 'Импорт', () => Promise.resolve(true)), true);
    assert.strictEqual(fake.warnings.length, 1);
  });
});
