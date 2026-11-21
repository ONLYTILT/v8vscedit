import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BslReadonlyGuard } from '../../ui/readonly/BslReadonlyGuard';
import type { RepositoryService } from '../../infra/repository/RepositoryService';
import type { SupportInfoService } from '../../infra/support/SupportInfoService';
import { removeTreeSync } from './support/tempTree';

const READONLY_COMMAND = 'workbench.action.files.setActiveEditorReadonlyInSession';

type ShowTextDocument = typeof vscode.window.showTextDocument;
type ExecuteCommand = typeof vscode.commands.executeCommand;

/**
 * Инварианты `BslReadonlyGuard`:
 *
 * 1. Guard сам редакторы не открывает. Переход из окна ссылок
 *    (`editor.action.goToReferences`) в заблокированный модуль открывал модуль в
 *    начале: guard в ответ на открытие делал собственный `showTextDocument` без
 *    `selection`, и он конкурировал с исходным открытием.
 * 2. Readonly ставится ровно тому документу, который заблокирован. Прежний
 *    `showTextDocument(..., { preserveFocus: true })` чужую группу активной не делал
 *    (активация RESTORE), и команда readonly применялась к другому активному файлу.
 * 3. Фоновый заблокированный документ получает readonly при активации — без
 *    перехвата фокуса (issue #4) и без 5-секундного окна прежнего наблюдателя.
 *
 * Закрытие и повторное открытие того же объекта документа даёт смена языка
 * (`setTextDocumentLanguage`: close и open одного объекта приходят до завершения
 * промиса — замерено): настоящее закрытие Extension Host делает лениво, его
 * можно ждать десятки секунд.
 */
suite('BslReadonlyGuard — readonly при активации заблокированного документа', () => {
  let tmpDir: string;
  let lockedFile: string;
  let otherFile: string;
  let thirdFile: string;
  let logLines: string[];
  let supportLocks: boolean;
  let repositoryRestricted: boolean;
  let spy: Spies;

  const samePath = (a: string, b: string): boolean =>
    // VS Code отдаёт `fileName` со строчной буквой диска, `os.tmpdir()` — с прописной.
    path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  function createGuard(): BslReadonlyGuard {
    const supportService = {
      isLocked: (file: string) => supportLocks && samePath(file, lockedFile),
    } as unknown as SupportInfoService;
    const repositoryService = {
      isEditRestricted: (file: string) => repositoryRestricted && samePath(file, otherFile),
    } as unknown as RepositoryService;
    const log = { appendLine: (line: string) => logLines.push(line) } as unknown as vscode.OutputChannel;
    return new BslReadonlyGuard(supportService, repositoryService, log);
  }

  /** Открыть заблокированный документ в фоне: видим во второй колонке, активен — первый. */
  async function openLockedInBackground(): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(otherFile), { preview: false, viewColumn: vscode.ViewColumn.One });
    await vscode.window.showTextDocument(vscode.Uri.file(lockedFile), {
      preview: false,
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: true,
    });
    // Строка лога пишется синхронно перед постановкой в ожидание.
    await waitUntil(() => logLines.length > 0, 3000);
  }

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-readonly-guard-'));
    lockedFile = path.join(tmpDir, 'Module.bsl');
    otherFile = path.join(tmpDir, 'Other.bsl');
    thirdFile = path.join(tmpDir, 'Third.bsl');
    const lines = Array.from({ length: 60 }, (_, i) => `// строка ${String(i + 1)}`);
    lines[40] = 'Процедура Тест()';
    lines[41] = 'КонецПроцедуры';
    fs.writeFileSync(lockedFile, lines.join('\n') + '\n', 'utf-8');
    fs.writeFileSync(otherFile, 'Процедура Другая()\nКонецПроцедуры\n', 'utf-8');
    fs.writeFileSync(thirdFile, 'Процедура Третья()\nКонецПроцедуры\n', 'utf-8');
    logLines = [];
    supportLocks = true;
    repositoryRestricted = false;
    spy = installSpies();
  });

  teardown(async () => {
    spy.restore();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await removeTreeWhenReleased(tmpDir);
  });

  test('активный редактор, открытый с позицией (как из окна ссылок): readonly сразу, без переоткрытия, позиция сохранена', async function () {
    this.timeout(10_000);
    const target = new vscode.Selection(40, 10, 40, 10);
    const disposable = createGuard().register();
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(lockedFile), { preview: false, selection: target });
      await waitUntil(() => spy.readonlyActiveFiles.length > 0, 3000);
    } finally {
      disposable.dispose();
    }

    assert.strictEqual(spy.guardShowCalls, 0, 'guard не должен сам открывать редакторы — это сбивало позицию перехода');
    assert.deepStrictEqual(spy.readonlyActiveFiles.map((file) => samePath(file, lockedFile)), [true]);
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor?.selection.isEqual(target), 'курсор должен остаться на строке, куда вёл переход');
  });

  test('фоновый редактор: readonly не ставится чужому активному файлу, ставится при активации', async function () {
    this.timeout(10_000);
    const disposable = createGuard().register();
    try {
      await openLockedInBackground();
      // Активация другого документа — не повод ставить readonly.
      await vscode.window.showTextDocument(vscode.Uri.file(thirdFile), { preview: false, viewColumn: vscode.ViewColumn.One });
      assert.strictEqual(spy.readonlyActiveFiles.length, 0, 'пока заблокированный документ в фоне, readonly не применяется');

      // Пользователь переходит в заблокированный документ.
      await vscode.window.showTextDocument(vscode.Uri.file(lockedFile), { viewColumn: vscode.ViewColumn.Two });
      await waitUntil(() => spy.readonlyActiveFiles.length > 0, 3000);
    } finally {
      disposable.dispose();
    }

    assert.strictEqual(spy.guardShowCalls, 0, 'guard не должен сам активировать редактор (issue #4)');
    assert.deepStrictEqual(
      spy.readonlyActiveFiles.map((file) => samePath(file, lockedFile)),
      [true],
      'readonly применён ровно один раз и именно к заблокированному документу'
    );
  });

  test('документ, закрытый так и не став активным, перестаёт ожидаться', async function () {
    this.timeout(10_000);
    const disposable = createGuard().register();
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(lockedFile));
      await waitUntil(() => logLines.length > 0, 3000);

      // Снимаем блокировку и закрываем документ: повторное открытие его уже не возьмёт,
      // значит снять ожидание мог только close.
      supportLocks = false;
      await vscode.languages.setTextDocumentLanguage(doc, 'plaintext');

      await vscode.window.showTextDocument(doc, { preview: false });
      // Пропажа активного редактора (undefined) тоже не повод для readonly.
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    } finally {
      disposable.dispose();
    }
    assert.strictEqual(spy.readonlyActiveFiles.length, 0);
  });

  test('dispose регистрации снимает подписки: после него активация фонового документа readonly не ставит', async function () {
    this.timeout(10_000);
    const disposable = createGuard().register();
    try {
      await openLockedInBackground();
      disposable.dispose();
      await vscode.window.showTextDocument(vscode.Uri.file(lockedFile), { viewColumn: vscode.ViewColumn.Two });
    } finally {
      disposable.dispose();
    }
    assert.strictEqual(spy.readonlyActiveFiles.length, 0);
  });

  test('повторное открытие того же документа (смена языка) не переприменяет readonly', async function () {
    this.timeout(10_000);
    const disposable = createGuard().register();
    try {
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(lockedFile), { preview: false });
      await waitUntil(() => spy.readonlyActiveFiles.length > 0, 3000);
      await vscode.languages.setTextDocumentLanguage(editor.document, 'plaintext');
      await vscode.languages.setTextDocumentLanguage(editor.document, 'bsl');
    } finally {
      disposable.dispose();
    }
    assert.strictEqual(logLines.length, 3, 'guard видел исходное открытие и два повторных');
    assert.strictEqual(spy.readonlyActiveFiles.length, 1, 'readonly для одного документа не должен выполняться повторно');
  });

  test('блокировка хранилищем без блокировки поддержкой — тоже readonly', async function () {
    this.timeout(10_000);
    repositoryRestricted = true;
    const disposable = createGuard().register();
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(otherFile), { preview: false });
      await waitUntil(() => spy.readonlyActiveFiles.length > 0, 3000);
    } finally {
      disposable.dispose();
    }
    assert.ok(samePath(spy.readonlyActiveFiles[0], otherFile));
  });

  test('не file://, не .bsl и незаблокированный .bsl — guard не вмешивается', async function () {
    this.timeout(10_000);
    const txtFile = path.join(tmpDir, 'Module.txt');
    fs.writeFileSync(txtFile, 'текст\n', 'utf-8');
    const disposable = createGuard().register();
    try {
      // Пустой untitled не «грязный»: teardown закроет редакторы без диалога сохранения.
      await vscode.workspace.openTextDocument({ language: 'bsl' });
      await vscode.window.showTextDocument(vscode.Uri.file(txtFile), { preview: false });
      await vscode.window.showTextDocument(vscode.Uri.file(otherFile), { preview: false });
    } finally {
      disposable.dispose();
    }
    assert.deepStrictEqual(logLines, []);
    assert.strictEqual(spy.readonlyActiveFiles.length, 0);
  });
});

interface Spies {
  /** Вызовы `showTextDocument` с `TextDocument` — тест передаёт `Uri`, значит это guard. */
  readonly guardShowCalls: number;
  /** Путь активного редактора в момент каждой readonly-команды — кому она применилась. */
  readonly readonlyActiveFiles: readonly string[];
  restore(): void;
}

/**
 * Шпионы поверх реального API: вызовы делегируются оригиналу, фиксируются только
 * аргументы — проверяется код расширения, а не подменённая семантика VS Code.
 */
function installSpies(): Spies {
  const window = vscode.window as { showTextDocument: ShowTextDocument };
  const commands = vscode.commands as { executeCommand: ExecuteCommand };
  const originalShow = window.showTextDocument;
  const originalExecute = commands.executeCommand;
  const state = { guardShowCalls: 0, readonlyActiveFiles: [] as string[] };

  window.showTextDocument = ((target: vscode.TextDocument | vscode.Uri, options?: vscode.TextDocumentShowOptions) => {
    if (!(target instanceof vscode.Uri)) {
      state.guardShowCalls += 1;
    }
    return (originalShow as (t: unknown, o?: unknown) => Thenable<vscode.TextEditor>)(target, options);
  }) as ShowTextDocument;

  commands.executeCommand = ((command: string, ...rest: unknown[]) => {
    if (command === READONLY_COMMAND) {
      state.readonlyActiveFiles.push(vscode.window.activeTextEditor?.document.fileName ?? '');
    }
    return (originalExecute as (c: string, ...r: unknown[]) => Thenable<unknown>)(command, ...rest);
  }) as ExecuteCommand;

  return {
    get guardShowCalls() {
      return state.guardShowCalls;
    },
    get readonlyActiveFiles() {
      return state.readonlyActiveFiles;
    },
    restore() {
      window.showTextDocument = originalShow;
      commands.executeCommand = originalExecute;
    },
  };
}

/**
 * На Windows VS Code отпускает каталог открытых файлов не сразу после
 * `closeAllEditors` (воспроизводится после редакторов в двух колонках: `EBUSY` на
 * `rmdir`). Повтор ограничен по времени — вечно занятый каталог остаётся ошибкой.
 */
async function removeTreeWhenReleased(target: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      removeTreeSync(target);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Условие не выполнено за отведённое время ожидания');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
