import * as vscode from 'vscode';
import { inspectTemplateDescriptor } from '../../../infra/xml/TemplateXml';
import { resolveTemplateBodyFromNode, resolveTemplateNodeParts, type ExpectedTemplateType } from '../../tree/templateNodePaths';
import type { MetadataNode } from '../../tree/TreeNode';
import type { CommandServices } from '../_shared';

export function registerTemplateToolsCommands(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('v8vscedit.mxl.info', async (node: MetadataNode | undefined) => {
      await showMxlInfo(node, services);
    }),
    vscode.commands.registerCommand('v8vscedit.mxl.validate', async (node: MetadataNode | undefined) => {
      await validateMxl(node, services);
    }),
    vscode.commands.registerCommand('v8vscedit.skd.info', async (node: MetadataNode | undefined) => {
      await showSkdInfo(node, services);
    }),
    vscode.commands.registerCommand('v8vscedit.skd.validate', async (node: MetadataNode | undefined) => {
      await validateSkd(node, services);
    })
  );
}

async function showMxlInfo(node: MetadataNode | undefined, services: CommandServices): Promise<void> {
  if (!isTemplateNode(node)) {
    await vscode.window.showWarningMessage('Выберите макет табличного документа.');
    return;
  }
  await runOnTemplateBody(node, 'SpreadsheetDocument', async (templatePath) => {
    const result = services.mxlTemplateService.info({ templatePath, withText: true, limit: 1000 });
    await openReport(`MXL: ${result.name}`, result.lines.join('\n'));
  });
}

async function validateMxl(node: MetadataNode | undefined, services: CommandServices): Promise<void> {
  if (!isTemplateNode(node)) {
    await vscode.window.showWarningMessage('Выберите макет табличного документа.');
    return;
  }
  await runOnTemplateBody(node, 'SpreadsheetDocument', async (templatePath) => {
    const result = services.mxlTemplateService.validate({ templatePath, detailed: true, maxErrors: 100 });
    await openReport(`Валидация MXL: ${String(result.errors)} ошибок`, result.lines.join('\n'));
  });
}

async function showSkdInfo(node: MetadataNode | undefined, services: CommandServices): Promise<void> {
  if (!isTemplateNode(node)) {
    await vscode.window.showWarningMessage('Выберите макет СКД.');
    return;
  }
  await runOnTemplateBody(node, 'DataCompositionSchema', async (templatePath) => {
    const result = services.dataCompositionSchemaService.info({ templatePath, mode: 'full', limit: 1000 });
    await openReport('СКД: структура', result.lines.join('\n'));
  });
}

async function validateSkd(node: MetadataNode | undefined, services: CommandServices): Promise<void> {
  if (!isTemplateNode(node)) {
    await vscode.window.showWarningMessage('Выберите макет СКД.');
    return;
  }
  await runOnTemplateBody(node, 'DataCompositionSchema', async (templatePath) => {
    const result = services.dataCompositionSchemaService.validate({ templatePath, detailed: true, maxErrors: 100 });
    await openReport(`Валидация СКД: ${String(result.errors)} ошибок`, result.lines.join('\n'));
  });
}

async function openReport(title: string, content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: 'plaintext',
    content: `${title}\n${'='.repeat(title.length)}\n\n${content}\n`,
  });
  await vscode.window.showTextDocument(doc);
}

function isTemplateNode(node: MetadataNode | undefined): node is MetadataNode {
  return node?.nodeKind === 'Template' || node?.nodeKind === 'CommonTemplate';
}

/**
 * Тело макета — той же деривацией, что у MCP (`templateNodePaths`); ошибки адаптера
 * и сервиса (чужой тип, нет тела) — предупреждение, а не необработанное исключение.
 */
async function runOnTemplateBody(
  node: MetadataNode,
  expected: ExpectedTemplateType,
  action: (templatePath: string) => Promise<void>,
): Promise<void> {
  try {
    await action(resolveTemplateBodyFromNode(node, node.textLabel, expected, 'read'));
  } catch (error) {
    // Адаптер и сервисы макетов бросают только Error — ветка «не Error» была бы мёртвой.
    await vscode.window.showWarningMessage((error as Error).message);
  }
}

function readNodeTemplateType(node: MetadataNode): string | null {
  try {
    return inspectTemplateDescriptor(resolveTemplateNodeParts(node, node.textLabel).descriptorPath).type;
  } catch {
    return null;
  }
}

export function isMxlTemplateNode(node: MetadataNode): boolean {
  return readNodeTemplateType(node) === 'SpreadsheetDocument';
}

export function isSkdTemplateNode(node: MetadataNode): boolean {
  return readNodeTemplateType(node) === 'DataCompositionSchema';
}
