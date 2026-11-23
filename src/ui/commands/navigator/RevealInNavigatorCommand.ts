import * as vscode from 'vscode';
import { resolveMetadataFileTarget } from '../../../infra/fs/MetadataFileTarget';
import { findMetadataNodeForTarget } from '../../tree/metadataFileNode';
import type { CommandServices } from '../_shared';

export const REVEAL_IN_NAVIGATOR_COMMAND = 'v8vscedit.revealInNavigator';

/** Признак контекста для `when` горячей клавиши и меню редактора: у активного файла есть узел в дереве. */
export const ACTIVE_FILE_IN_METADATA_CONTEXT = 'v8vscedit.activeFileInMetadata';

type RevealServices = Pick<CommandServices, 'treeProvider' | 'revealNodeInNavigator'>;

/**
 * «Показать в дереве метаданных»: из меню вкладки команда получает URI вкладки (она может
 * быть не активной), из меню текста и по горячей клавише — без аргумента, тогда берётся
 * активный редактор.
 */
export function registerRevealInNavigatorCommand(context: vscode.ExtensionContext, services: CommandServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(REVEAL_IN_NAVIGATOR_COMMAND, (uri?: vscode.Uri) =>
      revealFileInNavigator(services, uri ?? vscode.window.activeTextEditor?.document.uri)
    )
  );
}

/**
 * `false` — переход не выполнен. Файл вне выгрузки — сообщение: пункт меню вкладки виден у
 * любого `.bsl`/`.xml`, и молчание выглядело бы поломкой. Узел скрыт фильтром — молча:
 * пользователь сам включил фильтр, сбрасывать его без спроса нельзя.
 */
export async function revealFileInNavigator(services: RevealServices, uri: vscode.Uri | undefined): Promise<boolean> {
  const roots = services.treeProvider.getEntries().map((entry) => entry.rootPath);
  const target = uri?.scheme === 'file' ? resolveMetadataFileTarget(roots, uri.fsPath) : null;
  if (!target) {
    void vscode.window.showInformationMessage('Файл не относится к метаданным проекта.');
    return false;
  }
  const node = findMetadataNodeForTarget(services.treeProvider, target);
  return node ? services.revealNodeInNavigator(node) : false;
}
