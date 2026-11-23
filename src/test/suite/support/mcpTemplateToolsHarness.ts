import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as vscode from 'vscode';
import type { ConfigEntry } from '../../../domain/Configuration';
import type { SupportInfoService, SupportMode } from '../../../infra/support/SupportInfoService';
import {
  ConfigurationScaffoldService,
  DataCompositionSchemaService,
  MetadataXmlCreator,
  MxlTemplateService,
} from '../../../infra/xml';
import type { SkdDefinition } from '../../../infra/xml/DataCompositionSchemaService';
import type { MxlDefinition } from '../../../infra/xml/MxlTemplateService';
import { registerTemplateToolsCommands } from '../../../ui/commands/template/TemplateToolsCommands';
import { McpMetadataPathService } from '../../../ui/mcp/McpMetadataPathService';
import { McpMutationGate } from '../../../ui/mcp/registration/McpMutationGate';
import type { McpCommandServices, McpRegistrationDeps } from '../../../ui/mcp/registration/McpRegistrationDeps';
import { registerTemplateTools } from '../../../ui/mcp/registration/McpTemplateTools';
import { MetadataTreeProvider } from '../../../ui/tree/MetadataTreeProvider';
import type { MetadataNode } from '../../../ui/tree/TreeNode';
import { removeTreeSync } from './tempTree';

/**
 * Обвязка проверки MCP-инструментов и команд навигатора для макетов на РЕАЛЬНОМ дереве.
 *
 * Образец — `mcpFormToolsHarness`: дерево строит настоящий `MetadataTreeProvider`, пути
 * резолвит настоящий `McpMetadataPathService`, так что узел макета — ровно тот, что видит
 * агент (у макета объекта `xmlPath` — дескриптор `Templates/<Имя>.xml`, а при его
 * отсутствии — XML владельца; у общего макета — дескриптор `CommonTemplates/<Имя>.xml`).
 * Подменено только то, чего нет вне живой платформы: сервис поддержки и хранилище.
 */

export const REPO_ROOT = path.resolve(__dirname, '../../../../');

export type TemplateKindName = 'SpreadsheetDocument' | 'DataCompositionSchema' | 'TextDocument';

export interface TemplatePostMutationLog {
  readonly suppress: string[][];
  readonly markChanged: string[][];
  refreshActionsView: number;
}

export interface TemplateMcpHarnessOptions {
  readonly supportMode?: SupportMode;
  readonly repositoryRestricted?: boolean;
}

export interface TemplateMcpHarness {
  readonly treeProvider: MetadataTreeProvider;
  readonly paths: McpMetadataPathService;
  readonly services: McpCommandServices;
  readonly postMutation: TemplatePostMutationLog;
  readonly supportQueries: string[];
  readonly repositoryQueries: string[];
  call(tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
  dispose(): void;
}

export function createTemplateMcpHarnessOverEntry(
  entry: ConfigEntry,
  options: TemplateMcpHarnessOptions = {},
): TemplateMcpHarness {
  const cacheRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-mcp-template-cache-')));
  const treeProvider = new MetadataTreeProvider([entry], vscode.Uri.file(REPO_ROOT), cacheRoot);
  const paths = new McpMetadataPathService(treeProvider);

  const postMutation: TemplatePostMutationLog = { suppress: [], markChanged: [], refreshActionsView: 0 };
  const supportQueries: string[] = [];
  const repositoryQueries: string[] = [];
  const supportMode = options.supportMode;
  const services = {
    treeProvider,
    mxlTemplateService: new MxlTemplateService(),
    dataCompositionSchemaService: new DataCompositionSchemaService(),
    supportService: supportMode === undefined
      ? undefined
      : {
        getSupportMode: (filePath: string) => {
          supportQueries.push(filePath);
          return supportMode;
        },
      } as unknown as SupportInfoService,
    repositoryService: {
      isEditRestricted: (filePath: string) => {
        repositoryQueries.push(filePath);
        return options.repositoryRestricted === true;
      },
      resolveTargetByXmlPath: (filePath: string) => (options.repositoryRestricted === undefined ? undefined : { xmlPath: filePath }),
      isMetadataEditRestricted: (_target: unknown, filePath: string) => {
        repositoryQueries.push(filePath);
        return options.repositoryRestricted === true;
      },
    },
    suppressConfigurationReloadForFiles: (files: string[]) => { postMutation.suppress.push([...files]); },
    markChangedConfigurationByFiles: (files: string[]) => { postMutation.markChanged.push([...files]); },
    refreshActionsView: () => { postMutation.refreshActionsView += 1; },
    outputChannel: { appendLine: () => undefined },
  } as unknown as McpCommandServices;

  const gate = new McpMutationGate(services);
  const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => unknown) => {
      handlers.set(name, handler);
    },
  };
  registerTemplateTools(server as never, { services, paths, gate } as unknown as McpRegistrationDeps);

  return {
    treeProvider,
    paths,
    services,
    postMutation,
    supportQueries,
    repositoryQueries,
    call: async (tool, args) => {
      const handler = handlers.get(tool);
      if (!handler) {
        throw new Error(`MCP-инструмент ${tool} не зарегистрирован в registerTemplateTools`);
      }
      return await Promise.resolve(handler(args)) as CallToolResult;
    },
    dispose: () => {
      treeProvider.dispose();
      removeTreeSync(cacheRoot);
    },
  };
}

/** DSL табличного документа: две области, чтобы `info`/`decompile` было что отдавать. */
export const MXL_DEFINITION: MxlDefinition = {
  columns: 2,
  page: 'A4-portrait',
  columnWidths: { '1-2': '1x' },
  fonts: { default: { face: 'Arial', size: 10 } },
  styles: { cell: { border: 'all' } },
  areas: [
    { name: 'Шапка', rows: [{ cells: [{ col: 1, span: 2, style: 'cell', text: 'Заголовок [Номер]' }] }] },
    { name: 'Строка', rows: [{ cells: [{ col: 1, style: 'cell', param: 'Товар' }, { col: 2, style: 'cell', param: 'Количество' }] }] },
  ],
};

/** DSL СКД: один набор и параметр. */
export const SKD_DEFINITION: SkdDefinition = {
  dataSets: [
    {
      name: 'Продажи',
      query: 'ВЫБРАТЬ Товары.Ссылка КАК Номенклатура ИЗ Справочник.Товары КАК Товары',
      fields: ['Номенклатура [Номенклатура]: CatalogRef.Товары @dimension'],
    },
  ],
  parameters: ['Период [Период]: StandardPeriod @autoDates'],
};

/** Один макет фикстуры: вид узла, тип, канонический путь и все файлы, по которым строятся ожидания. */
export interface TemplateFixtureItem {
  readonly label: string;
  readonly nodeKind: 'Template' | 'CommonTemplate';
  readonly templateType: TemplateKindName;
  readonly name: string;
  readonly canonical: string;
  /** `Templates/<Имя>.xml` либо `CommonTemplates/<Имя>.xml`. */
  readonly descriptor: string;
  /** `<…>/<Имя>/Ext/Template.xml`. */
  readonly body: string;
  /** Файлы, которые инструмент над ТЕЛОМ макета не вправе тронуть ни на байт. */
  readonly untouched: readonly string[];
}

export interface TemplateFixtureExport {
  readonly configRoot: string;
  readonly configName: string;
  readonly catalogName: string;
  readonly catalogXml: string;
  readonly items: readonly TemplateFixtureItem[];
  item(nodeKind: 'Template' | 'CommonTemplate', templateType: TemplateKindName): TemplateFixtureItem;
}

function requireOk(label: string, result: { readonly success: boolean; readonly errors: readonly string[] }): void {
  if (!result.success) {
    throw new Error(`Подготовка фикстуры: ${label} не удалось: ${result.errors.join('; ')}`);
  }
}

const TEMPLATE_NAMES: Record<TemplateKindName, { owner: string; common: string }> = {
  SpreadsheetDocument: { owner: 'МакетПечать', common: 'ОбщийМакетПечать' },
  DataCompositionSchema: { owner: 'МакетСхема', common: 'ОбщаяСхема' },
  TextDocument: { owner: 'МакетТекст', common: 'ОбщийТекст' },
};

/**
 * Создаёт во временном каталоге настоящую выгрузку: справочник с тремя макетами
 * (табличный документ, СКД, текст) и столько же общих макетов. Содержимое MXL/СКД заполнено
 * компиляцией ПО ЯВНОМУ ПУТИ ТЕЛА — подготовка не должна зависеть от поведения, которое
 * проверяют тесты.
 */
export function createTemplateFixtureExport(): TemplateFixtureExport {
  const configRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-mcp-template-')));
  const configName = 'Тест';
  const catalogName = 'Товары';
  new ConfigurationScaffoldService().createConfiguration({ name: configName, outputDir: configRoot });

  const creator = new MetadataXmlCreator();
  const catalogXml = path.join(configRoot, 'Catalogs', `${catalogName}.xml`);
  requireOk('справочник', creator.addRootObject({ configRoot, kind: 'Catalog', name: catalogName }));

  const items: TemplateFixtureItem[] = [];
  for (const templateType of Object.keys(TEMPLATE_NAMES) as TemplateKindName[]) {
    const names = TEMPLATE_NAMES[templateType];
    requireOk(`макет объекта ${templateType}`, creator.addChildElement({
      ownerObjectXmlPath: catalogXml, childTag: 'Template', name: names.owner, templateType,
    }));
    requireOk(`общий макет ${templateType}`, creator.addRootObject({
      configRoot, kind: 'CommonTemplate', name: names.common, templateType,
    }));
    const ownerDir = path.join(configRoot, 'Catalogs', catalogName, 'Templates');
    const ownerDescriptor = path.join(ownerDir, `${names.owner}.xml`);
    const commonDescriptor = path.join(configRoot, 'CommonTemplates', `${names.common}.xml`);
    items.push({
      label: `макет объекта (${templateType})`,
      nodeKind: 'Template',
      templateType,
      name: names.owner,
      canonical: `Справочники.${catalogName}.Макет.${names.owner}`,
      descriptor: ownerDescriptor,
      body: path.join(ownerDir, names.owner, 'Ext', 'Template.xml'),
      untouched: [catalogXml, ownerDescriptor],
    }, {
      label: `общий макет (${templateType})`,
      nodeKind: 'CommonTemplate',
      templateType,
      name: names.common,
      canonical: `ОбщиеМакеты.${names.common}`,
      descriptor: commonDescriptor,
      body: path.join(configRoot, 'CommonTemplates', names.common, 'Ext', 'Template.xml'),
      untouched: [commonDescriptor],
    });
  }

  const mxl = new MxlTemplateService();
  const skd = new DataCompositionSchemaService();
  for (const item of items) {
    if (item.templateType === 'SpreadsheetDocument') {
      mxl.compile({ outputPath: item.body, definition: MXL_DEFINITION });
    } else if (item.templateType === 'DataCompositionSchema') {
      skd.compile({ outputPath: item.body, definition: SKD_DEFINITION });
    }
  }

  return {
    configRoot,
    configName,
    catalogName,
    catalogXml,
    items,
    item: (nodeKind, templateType) => {
      const found = items.find((candidate) => candidate.nodeKind === nodeKind && candidate.templateType === templateType);
      if (!found) {
        throw new Error(`В фикстуре нет макета ${nodeKind}/${templateType}`);
      }
      return found;
    },
  };
}

export interface TemplateMcpFixture extends TemplateFixtureExport {
  readonly harness: TemplateMcpHarness;
  dispose(): void;
}

export function createTemplateMcpFixture(options: TemplateMcpHarnessOptions = {}): TemplateMcpFixture {
  const exportInfo = createTemplateFixtureExport();
  const harness = createTemplateMcpHarnessOverEntry({ rootPath: exportInfo.configRoot, kind: 'cf' }, options);
  return {
    ...exportInfo,
    harness,
    dispose: () => {
      harness.dispose();
      removeTreeSync(exportInfo.configRoot);
    },
  };
}

/** Команды навигатора `v8vscedit.mxl.*`/`v8vscedit.skd.*` поверх ТЕХ ЖЕ сервисов, что и MCP-инструменты стенда. */
export interface TemplateCommandsStand {
  readonly registered: readonly string[];
  run(command: string, node?: MetadataNode): Promise<void>;
}

export function createTemplateCommandsStand(harness: TemplateMcpHarness): TemplateCommandsStand {
  const handlers = new Map<string, (node?: MetadataNode) => unknown>();
  const commandsRef = vscode.commands as { registerCommand: typeof vscode.commands.registerCommand };
  const original = commandsRef.registerCommand;
  // Настоящая регистрация упала бы на конфликте идентификаторов с активным расширением, а
  // проверять нужно поведение обработчика, а не сам факт регистрации.
  commandsRef.registerCommand = ((command: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(command, (node) => handler(node));
    return { dispose: () => undefined };
  }) as typeof vscode.commands.registerCommand;
  try {
    registerTemplateToolsCommands(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      harness.services,
    );
  } finally {
    commandsRef.registerCommand = original;
  }
  return {
    registered: [...handlers.keys()],
    run: async (command, node) => {
      const handler = handlers.get(command);
      if (!handler) {
        throw new Error(`Команда ${command} не зарегистрирована registerTemplateToolsCommands`);
      }
      await Promise.resolve(handler(node));
    },
  };
}
