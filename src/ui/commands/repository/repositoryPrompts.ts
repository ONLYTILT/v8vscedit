import * as vscode from 'vscode';
import type { RepositoryReportFlag, RepositoryReportFormat } from './repositoryOperationBuilders';

/**
 * Диалоги команд хранилища (QuickPick/InputBox). Вынесены из RepositoryCommands, чтобы
 * регистратор команд остался сценарием «диалоги → замок → запуск», а не росшим God-файлом.
 */

interface BooleanPickItem extends vscode.QuickPickItem {
  value: boolean;
}

interface ReportFlagItem extends vscode.QuickPickItem {
  flag: RepositoryReportFlag;
}

interface RightsPickItem extends vscode.QuickPickItem {
  value: 'ReadOnly' | 'LockObjects' | 'ManageConfigurationVersions' | 'Administration';
}

export async function askRecursiveMode(title: string, nodeLabel: string): Promise<boolean | undefined> {
  return pickBoolean(
    title,
    `Как выполнить операцию для "${nodeLabel}"?`,
    'Рекурсивно',
    'Только выбранный объект'
  );
}

export async function pickBoolean(
  title: string,
  placeHolder: string,
  trueLabel: string,
  falseLabel: string
): Promise<boolean | undefined> {
  const items: BooleanPickItem[] = [
    { label: trueLabel, value: true },
    { label: falseLabel, value: false },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder,
    ignoreFocusOut: true,
  });
  return picked?.value;
}

export async function pickRights(): Promise<RightsPickItem['value'] | undefined> {
  const items: RightsPickItem[] = [
    {
      label: 'Administration',
      description: 'Полный административный доступ к хранилищу',
      value: 'Administration',
    },
    {
      label: 'ManageConfigurationVersions',
      description: 'Управление версиями и метками',
      value: 'ManageConfigurationVersions',
    },
    {
      label: 'LockObjects',
      description: 'Захват, освобождение и помещение объектов',
      value: 'LockObjects',
    },
    {
      label: 'ReadOnly',
      description: 'Только чтение истории и версий',
      value: 'ReadOnly',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Права пользователя хранилища',
    placeHolder: 'Выберите набор прав',
    ignoreFocusOut: true,
  });
  return picked?.value;
}

export async function pickReportFormat(): Promise<RepositoryReportFormat | undefined> {
  const picked = await vscode.window.showQuickPick([
    { label: 'txt', description: 'Текстовый отчёт' },
    { label: 'mxl', description: 'Табличный документ 1С' },
  ], {
    title: 'Формат отчёта по хранилищу',
    placeHolder: 'Выберите формат файла отчёта',
    ignoreFocusOut: true,
  });

  if (picked?.label === 'txt' || picked?.label === 'mxl') {
    return picked.label;
  }
  return undefined;
}

export async function pickReportFlags(): Promise<ReportFlagItem['flag'][] | undefined> {
  const items: ReportFlagItem[] = [
    {
      label: 'Группировать по объектам',
      description: 'Параметр GroupByObject',
      flag: 'GroupByObject',
    },
    {
      label: 'Группировать по комментариям',
      description: 'Параметр GroupByComment',
      flag: 'GroupByComment',
    },
    {
      label: 'Исключить версии с метками',
      description: 'Параметр DoNotIncludeVersionsWithLabels',
      flag: 'DoNotIncludeVersionsWithLabels',
    },
    {
      label: 'Включить только версии с метками',
      description: 'Параметр IncludeOnlyVersionsWithLabels',
      flag: 'IncludeOnlyVersionsWithLabels',
    },
    {
      label: 'Включать строки комментариев с //',
      description: 'Параметр IncludeCommentLinesWithDoubleSlash',
      flag: 'IncludeCommentLinesWithDoubleSlash',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Дополнительные параметры отчёта',
    placeHolder: 'Можно выбрать несколько флагов или не выбирать ни одного',
    canPickMany: true,
    ignoreFocusOut: true,
  });
  return picked?.map((item) => item.flag);
}

export async function promptRequiredText(title: string, prompt: string, password = false): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title,
    prompt,
    password,
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() ? undefined : 'Значение обязательно'),
  });
  return value?.trim();
}

export async function promptOptionalText(title: string, prompt: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt,
    ignoreFocusOut: true,
  });
}
