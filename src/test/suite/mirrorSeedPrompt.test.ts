import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentFullDumpRequest, AgentMirrorSeedRequest, AgentOrphanFilesRequest } from '../../infra/agent/AgentOperationService';
import {
  disposeCachedAgentOperationServices,
  ensureAgentService,
  type CachedAgentService,
} from '../../ui/commands/ext/agent/AgentServiceRegistry';
import { runAgentConfigurationOperation, type RunAgentOptions } from '../../ui/commands/ext/agent/agentConfigurationOperation';
import { AgentFullDumpDeclinedError, AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import { promptFullDump } from '../../ui/commands/ext/agent/fullDumpPrompt';
import { promptMirrorSeed } from '../../ui/commands/ext/agent/mirrorSeedPrompt';
import { promptOrphanRemoval } from '../../ui/commands/ext/agent/orphanFilesPrompt';
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
    reason: 'mirror-empty',
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

/**
 * Причина вопроса (`request.reason`): `mirror-empty` — зеркало пусто (прежний текст, вторая кнопка «Полная
 * выгрузка»); `project-replaced` — выгрузку проекта заменили извне (plan-archive-avoid.md §3.7), вторая
 * кнопка «Обычный импорт» (→ `full`: прежний путь без посева). Исходы одинаковы: seed/full/cancel.
 */
suite('promptMirrorSeed: тексты по причине (reason)', () => {
  const restores: (() => void)[] = [];
  teardown(() => { restores.splice(0).forEach((restore) => restore()); });

  const FIRST_LABEL = 'Использовать выгрузку проекта';
  const table = [
    {
      reason: 'mirror-empty' as const,
      secondLabel: 'Полная выгрузка',
      message: /Зеркало выгрузки агента для «Бухгалтерия КОРП» пусто/,
    },
    {
      reason: 'project-replaced' as const,
      secondLabel: 'Обычный импорт',
      message: /Выгрузка проекта для «Бухгалтерия КОРП» заменена \(файл версий изменился после последней синхронизации\)\. Взять её за основу зеркала агента\?/,
    },
  ];

  function stubWarning(answer: string | undefined): { calls: unknown[][] } {
    const calls: unknown[][] = [];
    restores.push(stubWindow('showWarningMessage', (...args) => { calls.push(args); return Promise.resolve(answer); }));
    return { calls };
  }

  for (const { reason, secondLabel, message } of table) {
    suite(reason, () => {
      test(`сообщение соответствует причине; модальный диалог с кнопками «${FIRST_LABEL}» и «${secondLabel}»`, async () => {
        const { calls } = stubWarning(undefined);
        await promptMirrorSeed(request({ reason }));
        assert.match(String(calls[0][0]), message);
        assert.strictEqual((calls[0][1] as { modal?: boolean }).modal, true);
        assert.deepStrictEqual(calls[0].slice(2), [FIRST_LABEL, secondLabel]);
      });

      for (const [answer, expected] of [[FIRST_LABEL, 'seed'], [secondLabel, 'full'], [undefined, 'cancel'], ['Отмена', 'cancel']] as const) {
        test(`ответ ${String(answer)} → ${expected}`, async () => {
          stubWarning(answer);
          assert.strictEqual(await promptMirrorSeed(request({ reason })), expected);
        });
      }

      test('detail содержит каталог выгрузки проекта и предупреждение о ручных правках', async () => {
        const { calls } = stubWarning(undefined);
        const req = request({ reason, localEditsSinceBaseline: 4 });
        await promptMirrorSeed(req);
        const detail = (calls[0][1] as { detail?: string }).detail ?? '';
        assert.ok(detail.includes(req.projectDir), detail);
        assert.match(detail, /НЕ будут/);
        assert.match(detail, /известно\s+4/);
      });
    });
  }

  test('при project-replaced в сообщении нет слов о ПУСТОМ зеркале (текст причины не перепутан)', async () => {
    const { calls } = stubWarning(undefined);
    await promptMirrorSeed(request({ reason: 'project-replaced' }));
    assert.doesNotMatch(String(calls[0][0]), /пуст/);
  });
});

suite('Проброс confirmMirrorSeed в хуки агентской операции', function () {
  this.timeout(60_000);
  let tmp: string;
  let folder: vscode.WorkspaceFolder;
  let channel: vscode.OutputChannel;
  const restores: (() => void)[] = [];
  const captured: { hooks: Record<string, unknown>; target: Record<string, unknown> }[] = [];

  const seedRequest = (): AgentMirrorSeedRequest => request();
  const fullDumpRequest = (): AgentFullDumpRequest => ({
    targetKind: 'cf', targetName: 'Основная', projectDir: path.join(os.tmpdir(), 'p'), operation: 'import',
    reason: 'full-dump', reasonText: 'причина', download: true,
  });
  const orphansRequest = (): AgentOrphanFilesRequest => ({ targetName: 'Основная', owners: ['Catalog.А'], files: ['Catalogs/А.xml'] });

  /**
   * Хук операции обёрнут (журнал ожидания ответа), поэтому тождество с диалогом проверяется поведением: при
   * одном и том же ответе пользователя (Esc) обёртка возвращает то же решение, что сам диалог, и показывает
   * тот же диалог — тот же текст вопроса.
   */
  async function assertWrapsPrompt(
    name: 'confirmMirrorSeed' | 'confirmFullDump' | 'confirmOrphanRemoval',
    req: unknown,
    prompt: (request: never) => Promise<unknown>
  ): Promise<void> {
    const shown: unknown[][] = [];
    restores.push(stubWindow('showWarningMessage', (...args) => { shown.push(args); return Promise.resolve(undefined); }));
    const wrapped = captured[0].hooks[name] as (request: unknown) => Promise<unknown>;
    assert.strictEqual(typeof wrapped, 'function', name);
    const viaHook = await wrapped(req);
    const direct = await (prompt as (request: unknown) => Promise<unknown>)(req);
    assert.deepStrictEqual(viaHook, direct);
    assert.strictEqual(shown.length, 2, 'диалог показан и через хук, и напрямую');
    assert.strictEqual(shown[0][0], shown[1][0], 'тот же текст вопроса');
  }

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
    await assertWrapsPrompt('confirmMirrorSeed', seedRequest(), promptMirrorSeed);
  });

  test('runDecompileExtension: importFromDatabase получает хук promptMirrorSeed', async () => {
    const ok = await runDecompileExtension('Расш', path.join(tmp, 'src', 'cfe', 'Расш'), folder, channel);
    assert.strictEqual(ok, true);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].target.kind, 'cfe');
    assert.strictEqual(captured[0].target.extensionName, 'Расш');
    await assertWrapsPrompt('confirmMirrorSeed', seedRequest(), promptMirrorSeed);
  });

  test('runAgentConfigurationOperation: confirmMirrorSeed из опций попадает в хуки; без опции хука нет (импорт без диалога)', async () => {
    const base: RunAgentOptions = {
      progressTitle: 'Импорт', progressStartMessage: 'старт', successMessage: 'Готово', errorTitle: 'Сбой',
      showSuccessMessage: false, workspaceFolder: folder, outputChannel: channel, rootPath: tmp,
    };
    const received: unknown[] = [];
    const custom = (req: AgentMirrorSeedRequest): Promise<'full'> => { received.push(req); return Promise.resolve('full'); };
    const answers: unknown[] = [];
    const seen: unknown[] = [];
    await runAgentConfigurationOperation({ ...base, confirmMirrorSeed: custom }, async (_service, hooks) => {
      // Хук обёрнут (журнал ожидания), но вызывает именно переданный и возвращает его ответ.
      answers.push(await hooks.confirmMirrorSeed?.(request()));
    });
    await runAgentConfigurationOperation(base, (_service, hooks) => {
      seen.push((hooks as unknown as Record<string, unknown>).confirmMirrorSeed);
      return Promise.resolve();
    });
    assert.deepStrictEqual(answers, ['full']);
    assert.strictEqual(received.length, 1);
    assert.strictEqual((received[0] as AgentMirrorSeedRequest).targetName, request().targetName);
    assert.strictEqual(seen[0], undefined);
  });

  test('runDecompileMainConfiguration: importFromDatabase получает хуки promptFullDump и promptOrphanRemoval', async () => {
    const ok = await runDecompileMainConfiguration('Основная', path.join(tmp, 'src', 'cf'), folder, channel);
    assert.strictEqual(ok, true);
    await assertWrapsPrompt('confirmFullDump', fullDumpRequest(), promptFullDump);
    await assertWrapsPrompt('confirmOrphanRemoval', orphansRequest(), promptOrphanRemoval);
  });

  test('runDecompileExtension: importFromDatabase получает хуки promptFullDump и promptOrphanRemoval', async () => {
    const ok = await runDecompileExtension('Расш', path.join(tmp, 'src', 'cfe', 'Расш'), folder, channel);
    assert.strictEqual(ok, true);
    await assertWrapsPrompt('confirmFullDump', fullDumpRequest(), promptFullDump);
    await assertWrapsPrompt('confirmOrphanRemoval', orphansRequest(), promptOrphanRemoval);
  });

  test('runAgentConfigurationOperation: confirmFullDump/confirmOrphanRemoval из опций попадают в хуки; без опций хуков нет', async () => {
    const base: RunAgentOptions = {
      progressTitle: 'Импорт', progressStartMessage: 'старт', successMessage: 'Готово', errorTitle: 'Сбой',
      showSuccessMessage: false, workspaceFolder: folder, outputChannel: channel, rootPath: tmp,
    };
    const calls: string[] = [];
    const fullDump = (): Promise<'dump'> => { calls.push('fullDump'); return Promise.resolve('dump'); };
    const orphans = (): Promise<boolean> => { calls.push('orphans'); return Promise.resolve(true); };
    const answers: unknown[] = [];
    await runAgentConfigurationOperation({ ...base, confirmFullDump: fullDump, confirmOrphanRemoval: orphans }, async (_service, hooks) => {
      answers.push(await hooks.confirmFullDump?.(fullDumpRequest()), await hooks.confirmOrphanRemoval?.(orphansRequest()));
    });
    const seen: Record<string, unknown>[] = [];
    await runAgentConfigurationOperation(base, (_service, hooks) => { seen.push(hooks as unknown as Record<string, unknown>); return Promise.resolve(); });
    assert.deepStrictEqual(calls, ['fullDump', 'orphans']);
    assert.deepStrictEqual(answers, ['dump', true]);
    assert.strictEqual(seen[0].confirmFullDump, undefined);
    assert.strictEqual(seen[0].confirmOrphanRemoval, undefined);
  });

  test('отказ от полной выгрузки (AgentFullDumpDeclinedError): информационное сообщение с инструкцией, без тоста ошибки и диагностики, возврат false', async () => {
    const errors: unknown[][] = [];
    const infos: unknown[][] = [];
    restores.push(stubWindow('showErrorMessage', (...args) => { errors.push(args); return Promise.resolve(undefined); }));
    restores.push(stubWindow('showInformationMessage', (...args) => { infos.push(args); return Promise.resolve(undefined); }));
    const lines: string[] = [];
    const recording = { appendLine: (line: string) => { lines.push(line); }, show: () => undefined } as unknown as vscode.OutputChannel;
    const declined = new AgentFullDumpDeclinedError();

    const ok = await runAgentConfigurationOperation({
      progressTitle: 'Импорт', progressStartMessage: 'старт', successMessage: 'Готово', errorTitle: 'Ошибка импорта',
      showSuccessMessage: false, workspaceFolder: folder, outputChannel: recording, rootPath: tmp,
    }, () => Promise.reject(declined));

    assert.strictEqual(ok, false);
    assert.deepStrictEqual(errors, [], 'тоста ошибки нет');
    assert.strictEqual(infos.length, 1);
    assert.strictEqual(infos[0][0], declined.message, 'показан текст самой ошибки с инструкцией ручной выгрузки');
    assert.match(infos[0][0], /вручную/);
    assert.ok(lines.some((line) => line.includes(declined.message)), `в журнале текст ошибки: ${lines.join(' | ')}`);
    assert.ok(!lines.some((line) => line.includes('[agent][error]')), 'отказ не пишется как ошибка');
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
