import * as path from 'path';
import * as vscode from 'vscode';
import type { RepositoryService } from '../../infra/repository/RepositoryService';
import type { SupportInfoService } from '../../infra/support/SupportInfoService';

const READONLY_COMMAND = 'workbench.action.files.setActiveEditorReadonlyInSession';

/**
 * Переводит file:// BSL-файлы в readonly, если редактирование запрещено
 * поддержкой или объект не захвачен в хранилище.
 *
 * Guard НИКОГДА не открывает и не активирует редакторы сам. Платформенная команда
 * readonly работает только с активным редактором, поэтому статус ставится в тот
 * момент, когда заблокированный документ становится активным (сразу — если он
 * уже активен). Вручную в редакторе документ не поправить, не сделав его активным,
 * значит окна, в котором файл редактируем, нет (программные правки — rename от
 * LSP, «Заменить всё» — guard не закрывает и не закрывал). Прежняя схема «сделать
 * активным через `showTextDocument`» ломалась трижды:
 * - повторное открытие без `selection` конкурировало с исходным и сбрасывало
 *   позицию — переход из окна ссылок (`editor.action.goToReferences`) в
 *   заблокированный модуль открывал его в начале, а не на строке вызова;
 * - с `preserveFocus: true` (нужен, чтобы не отбирать фокус у webview, issue #4)
 *   VS Code открывает редактор с активацией RESTORE и чужую группу активной НЕ
 *   делает — readonly применялся к другому, активному файлу;
 * - запасной наблюдатель жил 5 с: документ, загруженный предпросмотром окна ссылок
 *   и открытый позже, readonly не получал вовсе.
 */
export class BslReadonlyGuard {
  // Документы, которым readonly уже поставлен. Нужен потому, что тот же объект
  // `TextDocument` открывается повторно: смена языка документа шлёт close и open
  // ОДНОГО объекта (замерено). `WeakSet` по идентичности: после настоящего закрытия
  // и нового открытия файла объект новый, и статус применится к нему заново.
  private readonly appliedTo = new WeakSet<vscode.TextDocument>();
  // Заблокированные документы, ещё не ставшие активными. Одна общая пара подписок
  // в `register()`, а не пара на документ: предпросмотр окна ссылок поднимает модели
  // всех найденных файлов, и в конфигурации на поддержке это сотни документов.
  private readonly pending = new Set<vscode.TextDocument>();

  constructor(
    private readonly supportService: SupportInfoService,
    private readonly repositoryService: RepositoryService,
    private readonly log: vscode.OutputChannel
  ) {}

  /** Подписывается на открытия BSL-файлов и помечает заблокированные readonly в текущей сессии. */
  register(): vscode.Disposable {
    const subscriptions = [
      vscode.workspace.onDidOpenTextDocument(async (doc) => {
        if (!this.isLocked(doc)) {
          return;
        }
        this.log.appendLine(`[readonly] Блокировка file:// BSL: ${path.basename(doc.fileName)}`);
        await this.applyReadonly(doc);
      }),
      vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (editor && this.pending.delete(editor.document)) {
          await this.applyReadonly(editor.document);
        }
      }),
      // Документ закрыт, так и не став активным (предпросмотр, hover), — ждать нечего.
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.pending.delete(doc);
      }),
    ];
    return new vscode.Disposable(() => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      this.pending.clear();
    });
  }

  private isLocked(doc: vscode.TextDocument): boolean {
    if (doc.uri.scheme !== 'file' || !doc.fileName.toLowerCase().endsWith('.bsl')) {
      return false;
    }
    return this.supportService.isLocked(doc.fileName) || this.repositoryService.isEditRestricted(doc.fileName);
  }

  /** Ставит readonly сейчас, если документ активен, иначе — при его активации. */
  private async applyReadonly(document: vscode.TextDocument): Promise<void> {
    if (this.appliedTo.has(document)) {
      return;
    }
    if (vscode.window.activeTextEditor?.document !== document) {
      this.pending.add(document);
      return;
    }
    // Отметка до `await`: повторный вызов, пришедший во время команды, не дублирует её.
    this.appliedTo.add(document);
    await vscode.commands.executeCommand(READONLY_COMMAND);
  }
}
