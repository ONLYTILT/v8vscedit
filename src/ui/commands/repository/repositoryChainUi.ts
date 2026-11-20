import * as vscode from 'vscode';
import { showRepositoryCliFailure } from './RepositoryCommandRunner';
import { RepositoryStepFailedError } from './repositoryChains';

/**
 * Показ исхода цепочек хранилища (`repositoryChains`) в UI-командах. Цепочки сами тостов не
 * показывают (их же вызывает MCP), поэтому сообщения — здесь, с прежними текстами раннера.
 * Всё без await (запрет №18): показ идёт внутри секции общего замка.
 */

export function showRepositoryChainWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    void vscode.window.showWarningMessage(warning);
  }
}

/**
 * Сбой цепочки: отказ шага синхронизации уже показан его раннером — второго сообщения нет; отказ
 * операции хранилища — прежнее уведомление раннера; прочее пробрасывается вызывающему.
 */
export function showRepositoryChainFailure(error: unknown): void {
  if (error instanceof RepositoryStepFailedError) {
    return;
  }
  showRepositoryCliFailure(error);
}
