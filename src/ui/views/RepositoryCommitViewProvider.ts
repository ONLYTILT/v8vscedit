import * as vscode from 'vscode';
import { WebviewHtmlFactory } from './webview/WebviewHtmlFactory';

export interface RepositoryCommitFormData {
  readonly comment: string;
  readonly recursive: boolean;
  readonly keepLocked: boolean;
  readonly force: boolean;
}

type RepositoryCommitMessage =
  | { readonly type: 'command'; readonly command: 'submit'; readonly payload: RepositoryCommitFormData }
  | { readonly type: 'command'; readonly command: 'cancel' }
  | { readonly type: string; readonly command?: string };

/** Ответ формы: данные или отмена. */
export type RepositoryCommitAnswer = { readonly kind: 'submit'; readonly data: RepositoryCommitFormData } | { readonly kind: 'cancel' };

/**
 * Ответом формы считаются только команды submit/cancel; иное сообщение (`null`) форму не закрывает.
 * Служебное `{ type: 'ready' }`, которое
 * webview шлёт сразу после загрузки, раньше трактовалось как отмена: панель закрывалась в момент
 * открытия, и помещение молча прекращалось.
 */
export function resolveRepositoryCommitAnswer(message: RepositoryCommitMessage): RepositoryCommitAnswer | null {
  if (message.type !== 'command') {
    return null;
  }
  if (message.command === 'submit' && 'payload' in message) {
    return { kind: 'submit', data: message.payload };
  }
  return message.command === 'cancel' ? { kind: 'cancel' } : null;
}

/**
 * Провайдер панели помещения изменений в хранилище 1С.
 * Использует Vue-приложение для рендеринга формы.
 */
export class RepositoryCommitViewProvider implements vscode.Disposable {
  static readonly viewType = 'v8vsceditRepositoryCommitPanel';

  private panel: vscode.WebviewPanel | undefined;
  private resolvePromise: ((value: RepositoryCommitFormData | undefined) => void) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri
  ) {}

  /**
   * Показывает панель коммита в хранилище.
   * @returns Promise с данными формы или undefined при отмене.
   */
  show(
    targetLabel: string,
    initiallyLocked: boolean
  ): Promise<RepositoryCommitFormData | undefined> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return new Promise((resolve) => {
        this.resolvePromise = resolve;
      });
    }

    this.panel = vscode.window.createWebviewPanel(
      RepositoryCommitViewProvider.viewType,
      'Помещение в хранилище',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false }
    );

    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'ui')],
    };

    const factory = new WebviewHtmlFactory(this.extensionUri);
    this.panel.webview.html = factory.renderVueWebviewHtml({
      webview: this.panel.webview,
      title: 'Помещение в хранилище',
      entry: 'repository-commit',
      viewKind: 'repository-commit',
      initialState: {
        targetLabel,
        initiallyLocked,
      },
      csp: { allowStyles: true },
    });

    this.panel.webview.onDidReceiveMessage((message: RepositoryCommitMessage) => {
      this.handleMessage(message);
    });

    this.panel.onDidDispose(() => {
      this.resolvePromise?.(undefined);
      this.panel = undefined;
    });

    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private handleMessage(message: RepositoryCommitMessage): void {
    const answer = resolveRepositoryCommitAnswer(message);
    if (!answer) {
      return;
    }
    this.resolvePromise?.(answer.kind === 'submit' ? answer.data : undefined);
    this.panel?.dispose();
    this.panel = undefined;
  }
}
