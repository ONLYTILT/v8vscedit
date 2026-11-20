/**
 * Список расширений базы для диалогов (подключение расширения, выбор цели CF/CFE). Перенесено из
 * `ExtensionCommandRunner.ts` (там — реэкспорт): в агентском режиме список даёт агент конфигуратора
 * (`properties get --all-extensions`), в batch — прежний внутренний CLI (`/DumpDBCfgList -AllExtensions`).
 */
import * as path from 'path';
import type * as vscode from 'vscode';
import { splitDumpableExtensions } from '../../../domain/agent';
import { describeError } from '../../../infra/agent';
import { readExtensionListFromDumpFile } from '../../../infra/environment';
import { runAgentExtensionList } from './agent/agentCfFileOperations';
import { getAgentExecutionMode, type AgentExecutionMode } from './agent/agentSettings';
import {
  buildConnectionCliArgs,
  resolveConnectionFromSettings,
  resolveProjectSettingsPath,
  type ConnectionParams,
} from './connectionSettings';
import { createWorkspaceTempDir, removeTempDir, runInternalCliCommand } from './ExtensionCommandRunner';

export type ExtensionListResult =
  | { readonly kind: 'ok'; readonly names: string[]; readonly skippedStubs: string[] }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** Текст отказа диалога: batch — прежний (про env.json и 8.3.11), agent — причина агента. */
export function describeExtensionListFailure(mode: AgentExecutionMode, reason: string): string {
  if (mode === 'agent') {
    return `Не удалось получить список расширений базы через агента конфигуратора: ${reason}`;
  }
  return 'Не удалось получить список расширений из базы. Проверьте подключение к базе (env.json) и версию платформы — ' +
    'список расширений доступен начиная с 8.3.11.';
}

/**
 * Расширения базы. Неприменённые заглушки (Э28) в `names` не попадают: импорт или выгрузка заглушки рискуют
 * уронить агента. Отказ — `unavailable` без собственного тоста: текст показывает диалог-потребитель.
 */
export async function listConnectedDatabaseExtensions(
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel
): Promise<ExtensionListResult> {
  if (getAgentExecutionMode() === 'agent') {
    const outcome = await runAgentExtensionList({ workspaceFolder, outputChannel });
    if (!outcome.ok) {
      return { kind: 'unavailable', reason: outcome.reason };
    }
    const { dumpable, stubs } = splitDumpableExtensions(outcome.value);
    for (const stub of stubs) {
      outputChannel.appendLine(`[agent] Расширение «${stub}» в базе не применено (заглушка прерванной загрузки) — пропущено`);
    }
    return { kind: 'ok', names: dumpable, skippedStubs: stubs };
  }

  let connection: ConnectionParams;
  try {
    connection = await resolveConnectionFromSettings(resolveProjectSettingsPath(workspaceFolder.uri.fsPath));
  } catch (error) {
    return { kind: 'unavailable', reason: describeError(error) };
  }
  /* c8 ignore start -- спавн node-CLI и реального Конфигуратора не юнит-тестируется в CI (правило CLAUDE.md №4); разбор списка — в infra/environment/ExtensionListParser */
  return listViaCli(workspaceFolder, outputChannel, connection);
}

async function listViaCli(
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  connection: ConnectionParams
): Promise<ExtensionListResult> {
  const tempRoot = createWorkspaceTempDir(workspaceFolder.uri.fsPath, 'list-ext-');
  const resultFile = path.join(tempRoot, 'extensions.txt');
  let reason = 'внутренний CLI завершился ошибкой';
  try {
    const ok = await runInternalCliCommand(
      {
        cliArgs: [
          'list-db-extensions',
          '-ProjectRoot',
          workspaceFolder.uri.fsPath,
          '-ResultFile',
          resultFile,
          ...buildConnectionCliArgs(connection),
        ],
        progressTitle: 'Получение списка расширений базы',
        progressStartMessage: 'Запрос списка расширений из базы...',
        successMessage: 'Список расширений базы получен.',
        errorTitle: 'Не удалось получить список расширений базы.',
        failureOperation: 'получении списка расширений базы',
        logPrefix: 'list-db-extensions',
        showSuccessMessage: false,
        showErrorMessage: false,
        onFailureReason: (failure) => { reason = failure; },
      },
      workspaceFolder,
      outputChannel
    );
    const names = ok ? readExtensionListFromDumpFile(resultFile) : undefined;
    return names === undefined ? { kind: 'unavailable', reason } : { kind: 'ok', names, skippedStubs: [] };
  } finally {
    removeTempDir(tempRoot, outputChannel);
  }
}
/* c8 ignore stop */
