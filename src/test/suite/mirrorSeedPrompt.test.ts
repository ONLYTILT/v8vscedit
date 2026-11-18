import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentMirrorSeedRequest } from '../../infra/agent/AgentOperationService';
import {
  disposeCachedAgentOperationServices,
  ensureAgentService,
  type CachedAgentService,
} from '../../ui/commands/ext/agent/AgentServiceRegistry';
import { runAgentConfigurationOperation, type RunAgentOptions } from '../../ui/commands/ext/agent/agentConfigurationOperation';
import { AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import { promptMirrorSeed } from '../../ui/commands/ext/agent/mirrorSeedPrompt';
import { runDecompileExtension, runDecompileMainConfiguration } from '../../ui/commands/ext/ExtensionCommandRunner';

/**
 * UI посева зеркала: модальный вопрос с тремя исходами (кнопки → 'seed'/'full', Esc → 'cancel'), его
 * проброс из UI-команд импорта (`runDecompileMainConfiguration`/`runDecompileExtension` и через них —
 * импорт после синхронизации с хранилищем) в хуки агентской операции. Диалог — вопрос с ответом
 * (как `showAgentQuestion`), а не уведомление: запрет №18 его не касается.
 */

type Fn = (...args: never[]) => unknown;
const win = vscode.window as unknown as Record<string, Fn>;

function stubWindow(name: string, impl: (...args: unknown[]) => unknown): () => void {
  const original = win[name];
  win[name] = impl;
  return () => { win[name] = original; };
}

const SEED_LABEL = 'Использовать выгрузку проекта';
const FULL_LABEL = 'Полная выгрузка';

function request(overrides: Partial<AgentMirrorSeedRequest> = {}): AgentMirrorSeedRequest {
  return {
    targetKind: 'cf',
    targetName: 'Бухгалтерия КОРП',
    projectDir: path.join(os.tmpdir(), 'project', 'src', 'cf'),
    formatVersion: '2.20',
    dumpInfoModifiedAt: new Date(2024, 4, 17, 10, 30),
    dumpInfoSize: 33_000_000,
    localEditsSinceBaseline: undefined,
    ...overrides,
  };
}

suite('promptMirrorSeed', () => {
  const restores: (() => void)[] = [];
  teardown(() => { restores.splice(0).forEach((restore) => restore()); });

  function stubWarning(answer: string | undefined): { calls: unknown[][] } {
    const calls: unknown[][] = [];
    restores.push(stubWindow('showWarningMessage', (...args) => { calls.push(args); return Promise.resolve(answer); }));
    return { calls };
  }

  /** Весь видимый текст вопроса: сообщение и, если оно вынесено в `detail`, подробности. */
  function textOf(call: unknown[]): string {
    const options = call[1] as { detail?: string } | undefined;
    return [String(call[0]), options?.detail ?? ''].join('\n');
  }

  test('кнопка «Использовать выгрузку проекта» → seed', async () => {
    stubWarning(SEED_LABEL);
    assert.strictEqual(await promptMirrorSeed(request()), 'seed');
  });

  test('кнопка «Полная выгрузка» → full', async () => {
    stubWarning(FULL_LABEL);
    assert.strictEqual(await promptMirrorSeed(request()), 'full');
  });

  test('закрытие диалога (Esc, undefined) → cancel', async () => {
    stubWarning(undefined);
    assert.strictEqual(await promptMirrorSeed(request()), 'cancel');
  });

  test('любой иной ответ (например, встроенная «Отмена») → cancel, а не молчаливый посев', async () => {
    stubWarning('Отмена');
    assert.strictEqual(await promptMirrorSeed(request()), 'cancel');
  });

  test('диалог модальный; ровно две кнопки в порядке «посев», «полная выгрузка»', async () => {
    const { calls } = stubWarning(undefined);
    await promptMirrorSeed(request());
    assert.strictEqual(calls.length, 1);
    assert.strictEqual((calls[0][1] as { modal?: boolean }).modal, true);
    assert.deepStrictEqual(calls[0].slice(2), [SEED_LABEL, FULL_LABEL]);
  });

  for (const [kind, name] of [['cf', 'Бухгалтерия КОРП'], ['cfe', 'Расширение «Доработки»']] as const) {
    test(`текст (${kind}): имя цели, дата файла версий, смысл выбора и предупреждение о ручных правках`, async () => {
      const { calls } = stubWarning(undefined);
      await promptMirrorSeed(request({ targetKind: kind, targetName: name, dumpInfoModifiedAt: new Date(2024, 4, 17, 10, 30) }));
      const text = textOf(calls[0]);
      assert.ok(text.includes(name), text);
      assert.ok(text.includes('2024'), `дата файла версий в тексте: ${text}`);
      assert.match(text, /пуст/i, 'сказано, что зеркало агента пусто');
      assert.match(text, /только объекты, изменённые в базе/i);
      assert.match(text, /ручн/i);
      assert.match(text, /НЕ будут/);
      assert.match(text, /базовую линию/, 'сказано, что правки войдут в базовую линию');
      assert.match(text, /до полной загрузки/, 'сказано, что расхождение останется до полной загрузки');
    });
  }

  test('число локальных правок: присутствует при известном localEditsSinceBaseline и отсутствует при undefined', async () => {
    const withEdits = stubWarning(undefined);
    await promptMirrorSeed(request({ localEditsSinceBaseline: 7 }));
    const textWith = textOf(withEdits.calls[0]);
    assert.match(textWith, /известно\s+7/, textWith);

    const without = stubWarning(undefined);
    await promptMirrorSeed(request({ localEditsSinceBaseline: undefined }));
    const textWithout = textOf(without.calls[0]);
    assert.doesNotMatch(textWithout, /известно/, textWithout);
  });
});

suite('Проброс confirmMirrorSeed в хуки агентской операции', function () {
  this.timeout(60_000);
  let tmp: string;
  let folder: vscode.WorkspaceFolder;
  let channel: vscode.OutputChannel;
  const restores: (() => void)[] = [];
  const captured: { hooks: Record<string, unknown>; target: Record<string, unknown> }[] = [];

  async function setOperationMode(value: string | undefined): Promise<void> {
    await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', value, vscode.ConfigurationTarget.Global);
  }

  setup(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-seed-prompt-'));
    folder = { uri: vscode.Uri.file(tmp), name: 'ws', index: 0 };
    channel = { appendLine: () => undefined, show: () => undefined } as unknown as vscode.OutputChannel;
    captured.length = 0;
    await disposeCachedAgentOperationServices();
    await setOperationMode('agent');
    // Шов реестра: запись с фейковым сервисом (внешний агент 1С недоступен), штатный ensureAgentService.
    const entry = {
      service: {
        importFromDatabase: (target: Record<string, unknown>, hooks: Record<string, unknown>) => {
          captured.push({ target, hooks });
          return Promise.resolve({ changedProjectFiles: [] });
        },
        dispose: () => Promise.resolve(),
      },
      sessions: { disposeAll: () => Promise.resolve() },
    } as unknown as CachedAgentService;
    await ensureAgentService(tmp, () => Promise.resolve(entry));
  });

  teardown(async () => {
    restores.splice(0).forEach((restore) => restore());
    await disposeCachedAgentOperationServices();
    await setOperationMode(undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('runDecompileMainConfiguration: importFromDatabase получает хук promptMirrorSeed', async () => {
    const ok = await runDecompileMainConfiguration('Основная', path.join(tmp, 'src', 'cf'), folder, channel);
    assert.strictEqual(ok, true);
    assert.strictEqual(captured.length, 1);
    assert.deepStrictEqual(captured[0].target, { kind: 'cf', name: 'Основная', rootPath: path.join(tmp, 'src', 'cf') });
    assert.strictEqual(captured[0].hooks.confirmMirrorSeed, promptMirrorSeed);
  });

  test('runDecompileExtension: importFromDatabase получает хук promptMirrorSeed', async () => {
    const ok = await runDecompileExtension('Расш', path.join(tmp, 'src', 'cfe', 'Расш'), folder, channel);
    assert.strictEqual(ok, true);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].target.kind, 'cfe');
    assert.strictEqual(captured[0].target.extensionName, 'Расш');
    assert.strictEqual(captured[0].hooks.confirmMirrorSeed, promptMirrorSeed);
  });

  test('runAgentConfigurationOperation: confirmMirrorSeed из опций попадает в хуки; без опции хука нет (импорт без диалога)', async () => {
    const base: RunAgentOptions = {
      progressTitle: 'Импорт', progressStartMessage: 'старт', successMessage: 'Готово', errorTitle: 'Сбой',
      showSuccessMessage: false, workspaceFolder: folder, outputChannel: channel, rootPath: tmp,
    };
    const custom = (): Promise<'full'> => Promise.resolve('full');
    const seen: unknown[] = [];
    await runAgentConfigurationOperation({ ...base, confirmMirrorSeed: custom }, (_service, hooks) => {
      seen.push((hooks as unknown as Record<string, unknown>).confirmMirrorSeed);
      return Promise.resolve();
    });
    await runAgentConfigurationOperation(base, (_service, hooks) => {
      seen.push((hooks as unknown as Record<string, unknown>).confirmMirrorSeed);
      return Promise.resolve();
    });
    assert.strictEqual(seen[0], custom);
    assert.strictEqual(seen[1], undefined);
  });

  test('отмена пользователем (Esc в вопросе о посеве → AgentSyncCancelledError): не ошибка — без тоста ошибки, информационное сообщение, результат false', async () => {
    const errors: unknown[][] = [];
    const infos: unknown[][] = [];
    restores.push(stubWindow('showErrorMessage', (...args) => { errors.push(args); return Promise.resolve(undefined); }));
    restores.push(stubWindow('showInformationMessage', (...args) => { infos.push(args); return Promise.resolve(undefined); }));
    const lines: string[] = [];
    const recording = { appendLine: (line: string) => { lines.push(line); }, show: () => undefined } as unknown as vscode.OutputChannel;

    const ok = await runAgentConfigurationOperation({
      progressTitle: 'Импорт', progressStartMessage: 'старт', successMessage: 'Готово', errorTitle: 'Ошибка импорта',
      showSuccessMessage: false, workspaceFolder: folder, outputChannel: recording, rootPath: tmp,
    }, () => Promise.reject(new AgentSyncCancelledError()));

    assert.strictEqual(ok, false);
    assert.deepStrictEqual(errors, [], 'тоста «Ошибка импорта…» нет');
    assert.strictEqual(infos.length, 1);
    assert.match(String(infos[0][0]), /отменена/);
    assert.ok(lines.some((line) => line.includes('Отменено')), lines.join(' | '));
    assert.ok(!lines.some((line) => line.includes('[agent][error]')), 'отмена не пишется как ошибка');
  });
});
