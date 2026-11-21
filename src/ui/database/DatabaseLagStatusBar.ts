import * as vscode from 'vscode';
import type { DatabaseConfigLagStore } from '../../infra/database/DatabaseConfigLag';
import { describeDatabaseLag } from './databaseLagPresentation';

/**
 * Постоянный индикатор «БД не обновлена»: виден, только пока есть отстающие цели (образец — постоянный
 * `BslAnalyzerStatusBar`, а не транзиентный статус хранилища с таймером скрытия). Клик —
 * `v8vscedit.databaseLag.showActions`; контекст-ключ `v8vscedit.databaseConfigurationBehind` — для when/enablement.
 * Текст, tooltip и видимость считает чистый `describeDatabaseLag`; здесь — только перенос в `StatusBarItem`.
 */
export class DatabaseLagStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: { dispose(): void };

  constructor(private readonly store: Pick<DatabaseConfigLagStore, 'list' | 'onDidChange'>) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.item.name = '1С: конфигурация БД не обновлена';
    this.item.command = 'v8vscedit.databaseLag.showActions';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.subscription = store.onDidChange(() => { this.render(); });
    this.render();
  }

  private render(): void {
    const view = describeDatabaseLag(this.store.list(), new Date());
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    if (view.visible) {
      this.item.show();
    } else {
      this.item.hide();
    }
    void vscode.commands.executeCommand('setContext', 'v8vscedit.databaseConfigurationBehind', view.visible);
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
