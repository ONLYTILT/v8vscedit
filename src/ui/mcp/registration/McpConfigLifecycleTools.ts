/**
 * MCP-инструменты жизненного цикла конфигурации/расширения и мостов CFE.
 *
 * Домен «configLifecycle»: create_configuration, create_extension, cfe_borrow,
 * cfe_patch_method, cfe_diff, execute_command, update_database_configuration, load_configuration_changes.
 *
 * Долгие инструменты (обмен с базой через Конфигуратор, команды импорта/обновления) обёрнуты в
 * `gate.wrapLongRunning`: пульс держит поток вызова живым, исход попадает в `lastOperation`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as vscode from 'vscode';
import * as z from 'zod/v4';
import { runDumpConfigurationToCf, runLoadConfigurationFromCf } from '../../commands/ext/CfFileCommandRunner';
import { runDumpAllExtensionsToCfe, runLoadAllExtensionsFromCfe } from '../../commands/ext/CfeBatchCommandRunner';
import { CFE_MANIFEST_FILE_NAME, type CfeBatchReport } from '../../../infra/cfFile';
import { buildCfApplyTarget, resolveApplyTargetFromNode } from '../../commands/ext/CfFileTarget';
import {
  runApplyDatabaseConfigurationWithOutcome,
  runUpdateExtension,
  runUpdateMainConfiguration,
} from '../../commands/ext/ExtensionCommandRunner';
import {
  MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE,
  isConfigurationOperationRunning,
  runWithConfigurationOperationLockOrThrow,
} from '../../commands/ext/configurationOperationLock';
import { findChangedConfiguration, refreshRepositoryUi } from '../../commands/repository/repositoryPostSync';
import type { DatabaseLagTarget } from '../../../infra/database/DatabaseConfigLag';
import { settleCfFileLoadLag, settleCfeBatchLoadLag, type DatabaseLoadOutcome } from '../../commands/ext/databaseLoadPlan';
import { canonicalToLegacyModulePath, resolveConfigurationXmlByCanonical } from '../McpPathResolvers';
import type { McpRegistrationDeps } from './McpRegistrationDeps';

const ALLOWED_COMMANDS = new Set([
  'v8vscedit.refresh',
  'v8vscedit.importConfigurations',
  'v8vscedit.updateChangedConfigurations',
]);

/**
 * Команды, берущие общий замок сами. При занятом замке UI-команда показала бы тост «занято» и вернула
 * бы `undefined` — агент получил бы ложный «успех», а ожидание тоста держало бы MCP-вызов. Проверка
 * до запуска не атомарна с захватом замка командой (TOCTOU): гонка лишь вернёт прежнее поведение.
 */
const LOCKING_COMMANDS = new Set([
  'v8vscedit.importConfigurations',
  'v8vscedit.updateChangedConfigurations',
]);

export function registerConfigLifecycleTools(server: McpServer, deps: McpRegistrationDeps): void {
  const { services, gate } = deps;

  server.registerTool(
    'v8vscedit_create_configuration',
    {
      title: 'Создать пустую конфигурацию',
      description: 'Создаёт scaffold CF: Configuration.xml и Languages/Русский.xml.',
      inputSchema: z.object({
        name: z.string(),
        synonym: z.string().optional(),
        outputDir: z.string(),
        version: z.string().optional(),
        vendor: z.string().optional(),
        compatibilityMode: z.string().optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    (args) => gate.wrap(() => {
      const result = services.configurationScaffoldService.createConfiguration(args);
      // Сервис бросает исключение при провале (перехват в wrap); дошли сюда — успех.
      gate.afterMutationIfSucceeded(result.changedFiles);
      return result;
    })
  );

  server.registerTool(
    'v8vscedit_create_extension',
    {
      title: 'Создать расширение',
      description: 'Создаёт scaffold CFE: Configuration.xml, язык и опциональную основную роль.',
      inputSchema: z.object({
        name: z.string(),
        synonym: z.string().optional(),
        namePrefix: z.string().optional(),
        outputDir: z.string(),
        purpose: z.enum(['Patch', 'Customization', 'AddOn']).optional(),
        version: z.string().optional(),
        vendor: z.string().optional(),
        compatibilityMode: z.string().optional(),
        configPath: z.string().optional(),
        noRole: z.boolean().optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    (args) => gate.wrap(() => {
      const result = services.configurationScaffoldService.createExtension(args);
      // Сервис бросает исключение при провале (перехват в wrap); дошли сюда — успех.
      gate.afterMutationIfSucceeded(result.changedFiles);
      return result;
    })
  );

  server.registerTool(
    'v8vscedit_dump_cf',
    {
      title: 'Выгрузить конфигурацию в CF-файл',
      description: [
        'Выгружает конфигурацию базы в бинарный файл через пакетный Конфигуратор (режим batch) или агента конфигуратора (режим agent; файлы передаются на сервер агента и обратно): основную конфигурацию в .cf,',
        'расширение — в .cfe (если задан extensionName).',
        'Файл появляется на целевом пути только при успешном завершении; overwrite разрешает заменить существующий файл.',
        'Для выгрузки ВСЕХ расширений базы одной операцией используйте v8vscedit_dump_all_cfe — этот инструмент работает с одним объектом за вызов.',
      ].join(' '),
      inputSchema: z.object({
        outputFile: z.string(),
        extensionName: z.string().optional(),
        overwrite: z.boolean().optional(),
      }),
      annotations: {
        // Выгрузка не меняет ни базу, ни файлы проекта; единственный побочный
        // эффект — создание указанного файла, защищённого guard'ом overwrite.
        destructiveHint: false,
      },
    },
    async ({ outputFile, extensionName, overwrite }, extra) => gate.wrapLongRunning('v8vscedit_dump_cf', extra, async () => {
      const dumped = await runWithConfigurationOperationLockOrThrow(() => runDumpConfigurationToCf({
        workspaceFolder: services.workspaceFolder,
        outputChannel: services.outputChannel,
        outputFile,
        extensionName,
        overwrite: overwrite ?? false,
        silent: true,
      }));
      if (!dumped.success) {
        throw new Error(dumped.failureReason ?? 'Выгрузка в файл не выполнена. Подробности — в журнале «1С Редактор».');
      }
      return { outputFile, extensionName: extensionName ?? '', overwrite: overwrite ?? false };
    })
  );

  server.registerTool(
    'v8vscedit_load_cf',
    {
      title: 'Загрузить конфигурацию из CF-файла',
      description: [
        'Загружает конфигурацию из бинарного файла в базу через пакетный Конфигуратор (режим batch) или агента конфигуратора (режим agent; файлы передаются на сервер агента и обратно): .cf — в основную конфигурацию,',
        '.cfe — в расширение (если задан extensionName; несуществующее расширение при этом создаётся в базе).',
        'В режиме agent загрузка в НОВОЕ расширение сразу применяет его к базе (иначе в базе остаётся неприменённая заглушка):',
        'тогда databaseConfigurationUpdated = true и createdInDatabase = true; extensionNameInDatabase — имя в базе, если оно взято из файла.',
        'Операция необратима и требует confirm: true.',
        'Конфигурация БАЗЫ при загрузке не обновляется — примените изменения отдельно через applyToDatabase: true.',
        'XML-выгрузка проекта после загрузки перестаёт соответствовать базе: выполните импорт конфигураций.',
      ].join(' '),
      inputSchema: z.object({
        inputFile: z.string(),
        extensionName: z.string().optional(),
        confirm: z.boolean(),
        applyToDatabase: z.boolean().optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ inputFile, extensionName, confirm, applyToDatabase }, extra) => {
      // Проверяем значение, а не только наличие поля: агент может прислать
      // confirm=false — неявного согласия по умолчанию у необратимой
      // операции быть не должно.
      if (!confirm) {
        return gate.toolError(new Error(
          'Загрузка из файла необратимо заменяет содержимое конфигурации в базе: '
          + 'текущее содержимое будет потеряно, а при сбое часть изменений всё равно может быть применена. '
          + 'Передайте confirm: true, чтобы подтвердить операцию.'
        ));
      }
      return gate.wrapLongRunning('v8vscedit_load_cf', extra, async () => runWithConfigurationOperationLockOrThrow(async () => {
        const loaded = await runLoadConfigurationFromCf({
          workspaceFolder: services.workspaceFolder,
          outputChannel: services.outputChannel,
          inputFile,
          extensionName,
          silent: true,
        });
        const applyTarget = buildCfApplyTarget(services.workspaceFolder.uri.fsPath, extensionName ?? '');
        if (!loaded.success) {
          // Сбой /LoadCfg оставляет побочные эффекты (часть изменений могла быть применена) — консервативно.
          services.databaseConfigLag.markBehind(applyTarget, 'cf-file-load');
          throw new Error(loaded.failureReason ?? (
            'Загрузка из файла не выполнена. Часть изменений могла быть применена — проверьте состояние базы. '
            + 'Подробности — в журнале «1С Редактор».'
          ));
        }
        const appliedAutomatically = loaded.appliedToDatabase === true;
        settleCfFileLoadLag(services.databaseConfigLag, applyTarget, appliedAutomatically);
        // Уже применённое агентом новое расширение повторно не применяется.
        const applyOutcome = applyToDatabase === true && !appliedAutomatically
          ? await runApplyDatabaseConfigurationWithOutcome(
              applyTarget,
              services.workspaceFolder,
              services.outputChannel,
              services.databaseConfigLag,
              false,
              true
            )
          : undefined;
        const applied = applyOutcome?.success === true;
        // Конфигурация проекта НЕ помечается изменённой: файлы проекта не
        // менялись, а пометка привела бы к тому, что «обновить изменённые
        // конфигурации» залило бы СТАРЫЕ файлы обратно в базу поверх
        // только что загруженного CF.
        return {
          inputFile,
          extensionName: extensionName ?? '',
          databaseConfigurationUpdated: applied || appliedAutomatically,
          databaseConfigurationBehind: services.databaseConfigLag.isBehind(applyTarget),
          projectSourcesOutdated: true,
          // Поля агентской ветки; в batch-ответе их нет (ключи без значения не публикуются).
          ...definedFields({
            createdInDatabase: loaded.createdInDatabase,
            extensionNameInDatabase: loaded.extensionNameInDatabase,
            // Предупреждения загрузки и применения (E11: имя в базе взято из файла) — агенту дословно.
            warnings: mergeWarnings(loaded.warnings, applyOutcome?.warnings),
          }),
        };
      }));
    }
  );

  server.registerTool(
    'v8vscedit_dump_all_cfe',
    {
      title: 'Выгрузить все расширения базы в CFE-файлы',
      description: [
        'Выгружает КАЖДОЕ подключённое к базе расширение в отдельный .cfe-файл каталога outputDir через пакетный Конфигуратор (режим batch) или агента конфигуратора (режим agent; файлы передаются на сервер агента и обратно).',
        'Список расширений берётся у самой базы; рядом с файлами пишется манифест cfe-dump.json,',
        'по которому загрузка восстанавливает исходные имена расширений (имя файла санитизируется необратимо).',
        'Отказ по отдельному расширению не останавливает операцию: такие расширения возвращаются в failed,',
        'их прежние файлы остаются нетронутыми. overwrite разрешает заменять уже существующие файлы каталога.',
      ].join(' '),
      inputSchema: z.object({
        outputDir: z.string(),
        overwrite: z.boolean().optional(),
      }),
      annotations: {
        // Выгрузка не меняет ни базу, ни файлы проекта.
        destructiveHint: false,
      },
    },
    async ({ outputDir, overwrite }, extra) => gate.wrapLongRunning('v8vscedit_dump_all_cfe', extra, async () => runWithConfigurationOperationLockOrThrow(async () => {
      const result = await runDumpAllExtensionsToCfe({
        workspaceFolder: services.workspaceFolder,
        outputChannel: services.outputChannel,
        outputDir,
        overwrite: overwrite ?? false,
        silent: true,
      });
      const report = assertBatchReport(result.report, 'Пакетная выгрузка расширений не выполнена.', result.failureReason);
      // Частичный отказ — УСПЕХ со списком failed: выгрузка базу не меняет, а
      // готовые бэкапы ценны сами по себе и исключение их бы скрыло.
      return {
        outputDir,
        overwrite: overwrite ?? false,
        manifestFile: CFE_MANIFEST_FILE_NAME,
        dumped: report.items.filter((item) => item.status === 'ok').map((item) => ({ extensionName: item.extensionName, fileName: item.fileName })),
        failed: report.items
          .filter((item) => item.status !== 'ok')
          .map((item) => ({ extensionName: item.extensionName, fileName: item.fileName, status: item.status, message: item.message })),
      };
    }))
  );

  server.registerTool(
    'v8vscedit_load_all_cfe',
    {
      title: 'Загрузить все расширения базы из CFE-файлов',
      description: [
        'Загружает в базу КАЖДОЕ расширение из .cfe-файлов каталога inputDir (имена восстанавливаются по манифесту cfe-dump.json)',
        'через пакетный Конфигуратор (режим batch) или агента конфигуратора (режим agent; файлы передаются на сервер агента и обратно).',
        'В режиме agent загрузка в НОВОЕ расширение сразу применяет его к базе (иначе в базе остаётся неприменённая заглушка):',
        'такие расширения возвращаются в appliedAutomatically и через applyToDatabase повторно не применяются.',
        'Операция необратима и требует confirm: true.',
        'При отказе на любом расширении загрузка ОСТАНАВЛИВАЕТСЯ: состояние сбойного расширения в базе неопределённо,',
        'остальные не трогаются. createMissing разрешает создавать в базе расширения, которых в ней ещё нет.',
        'Конфигурация БАЗЫ при загрузке не обновляется — примените изменения отдельно через applyToDatabase: true.',
        'XML-выгрузка проекта после загрузки перестаёт соответствовать базе: выполните импорт конфигураций.',
      ].join(' '),
      inputSchema: z.object({
        inputDir: z.string(),
        confirm: z.boolean(),
        createMissing: z.boolean().optional(),
        applyToDatabase: z.boolean().optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ inputDir, confirm, createMissing, applyToDatabase }, extra) => {
      // Проверяем значение, а не наличие поля: неявного согласия у необратимой
      // операции быть не должно.
      if (!confirm) {
        return gate.toolError(new Error(
          'Загрузка необратимо заменяет содержимое расширений в базе: текущее содержимое будет потеряно, '
          + 'а при сбое часть расширений всё равно окажется загруженной. '
          + 'Передайте confirm: true, чтобы подтвердить операцию.'
        ));
      }
      return gate.wrapLongRunning('v8vscedit_load_all_cfe', extra, async () => runWithConfigurationOperationLockOrThrow(async () => {
        const result = await runLoadAllExtensionsFromCfe({
          workspaceFolder: services.workspaceFolder,
          outputChannel: services.outputChannel,
          inputDir,
          createMissing: createMissing ?? false,
          silent: true,
        });
        const report = assertBatchReport(result.report, 'Пакетная загрузка расширений не выполнена.', result.failureReason);
        const lagTargetOf = (name: string): DatabaseLagTarget => buildCfApplyTarget(services.workspaceFolder.uri.fsPath, name);
        settleCfeBatchLoadLag(services.databaseConfigLag, report, lagTargetOf);
        if (report.failedAt) {
          // Частичный отказ загрузки — исключение, а не «успех со списком»:
          // база в промежуточном состоянии, и штатным итогом это не является.
          // В агентском режиме новые расширения ДО сбоя уже применены (update-db-cfg) — об этом сказать явно.
          const notes = appliedBeforeFailureNotes(report);
          throw new Error([
            `Загрузка остановлена на расширении "${report.failedAt.extensionName}" (файл ${report.failedAt.fileName}): `
            + 'состояние этого расширения в базе НЕОПРЕДЕЛЕНО (неудачная загрузка всё равно регистрирует расширение в базе). '
            + (notes.length === 0
              ? 'Расширения после него не загружались, конфигурация базы не обновлялась.'
              : 'Расширения после него не загружались.'),
            ...notes,
          ].join(' '));
        }

        const loaded = report.items.filter((item) => item.status === 'ok').map((item) => item.extensionName);
        const appliedAutomatically = report.items
          .filter((item) => item.status === 'ok' && item.appliedToDatabase === true)
          .map((item) => item.extensionName);
        const applied: string[] = [];
        const applyWarnings: string[] = [];
        if (applyToDatabase === true) {
          // Применение — по расширению на вызов через ТОТ ЖЕ путь, что у
          // одиночной загрузки: `/UpdateDBCfg -AllExtensions` применил бы и
          // расширения, которых мы не грузили.
          for (const extensionName of loaded.filter((name) => !appliedAutomatically.includes(name))) {
            const outcome = await runApplyDatabaseConfigurationWithOutcome(
              lagTargetOf(extensionName),
              services.workspaceFolder,
              services.outputChannel,
              services.databaseConfigLag,
              false,
              true
            );
            applyWarnings.push(...outcome.warnings);
            if (!outcome.success) {
              throw new Error(`Расширения загружены, но применение к базе не выполнено на "${extensionName}". Подробности — в журнале «1С Редактор».`);
            }
            applied.push(extensionName);
          }
        }
        // Конфигурация проекта НЕ помечается изменённой: файлы проекта не
        // менялись, а пометка заставила бы «обновить изменённые конфигурации»
        // залить СТАРЫЕ файлы обратно в базу поверх загруженного.
        return {
          inputDir,
          loaded,
          applied,
          notInDirectory: report.notInDirectory,
          ignoredFiles: report.ignoredFiles,
          // Имя расширения для этих файлов взято из ИМЕНИ ФАЙЛА, а не из
          // манифеста (`A_B.cfe` — это и `A:B`, и `A/B`): единственный признак,
          // что в базу могло уехать чужое поколение бэкапа.
          restoredByFileName: report.restoredByFileName,
          databaseConfigurationUpdated: applyToDatabase === true || appliedAutomatically.length > 0,
          databaseConfigurationBehind: loaded.some((name) => services.databaseConfigLag.isBehind(lagTargetOf(name))),
          projectSourcesOutdated: true,
          appliedAutomatically,
          ...definedFields({
            verificationWarnings: report.verificationWarnings,
            // Предупреждения сверки после применения существующих расширений (E11).
            warnings: applyWarnings.length > 0 ? applyWarnings : undefined,
          }),
        };
      }));
    }
  );

  server.registerTool(
    'v8vscedit_cfe_borrow',
    {
      title: 'Заимствовать объект в расширение',
      description: 'Заимствует объект, форму или дочерний элемент из CF в CFE через CfeBorrowService.',
      inputSchema: z.object({
        configRoot: z.string(),
        extensionRoot: z.string(),
        typeName: z.string(),
        objectName: z.string(),
        formName: z.string().optional(),
        childTag: z.string().optional(),
        childName: z.string().optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    ({ configRoot, extensionRoot, typeName, objectName, formName, childTag, childName }) => gate.wrap(() => {
      const result = formName
        ? services.cfeBorrowService.borrowForm(configRoot, extensionRoot, typeName, objectName, formName)
        : childTag && childName
          ? services.cfeBorrowService.borrowChild(configRoot, extensionRoot, typeName, objectName, childTag, childName)
          : services.cfeBorrowService.borrowObject(configRoot, extensionRoot, typeName, objectName);
      // CfeBorrowService сигналит провал исключением (перехват в wrap), а при
      // alreadyBorrowed возвращает пустой files — гейт по списку изменённых файлов.
      gate.afterMutationIfSucceeded(result.files);
      return result;
    })
  );

  server.registerTool(
    'v8vscedit_cfe_patch_method',
    {
      title: 'Добавить перехватчик метода CFE',
      description: [
        'Создаёт или дописывает BSL-модуль расширения перехватчиком &Перед/&После/&ИзменениеИКонтроль.',
        'path — канонический путь модуля расширения: Справочники.X.МодульОбъекта,',
        'Справочники.X.Форма.Y.МодульФормы, ОбщиеМодули.X. Модуль может пока отсутствовать.',
      ].join(' '),
      inputSchema: z.object({
        extensionPath: z.string(),
        path: z.string(),
        methodName: z.string(),
        interceptorType: z.enum(['Before', 'After', 'ModificationAndControl']),
        context: z.string().optional(),
        isFunction: z.boolean().optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    ({ path: canonical, ...rest }) => gate.wrap(() => {
      const modulePath = canonicalToLegacyModulePath(canonical);
      const result = services.cfePatchMethodService.addMethodInterceptor({ ...rest, modulePath });
      // Сервис бросает исключение при провале (перехват в wrap); дошли сюда — успех.
      gate.afterMutationIfSucceeded(result.changedFiles);
      return result;
    })
  );

  server.registerTool(
    'v8vscedit_cfe_diff',
    {
      title: 'Анализ расширения CFE',
      description: 'Возвращает состав расширения, заимствованные объекты, BSL-перехватчики и опционально проверку переноса #Вставка.',
      inputSchema: z.object({
        extensionPath: z.string(),
        configPath: z.string().optional(),
        mode: z.enum(['overview', 'transfer']).optional(),
      }),
    },
    (args) => gate.wrap(() => services.cfeDiffService.analyze(args))
  );

  server.registerTool(
    'v8vscedit_execute_command',
    {
      title: 'Выполнить команду расширения',
      description: 'Безопасный мост только для явно разрешённых команд расширения: refresh, importConfigurations, updateChangedConfigurations. updateChangedConfigurations следует настройке updateDatabaseAfterLoad (обновлять ли конфигурацию БД после загрузки); для явного выбора используйте v8vscedit_load_configuration_changes.',
      inputSchema: z.object({
        command: z.enum([...ALLOWED_COMMANDS] as [string, ...string[]]),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ command }, extra) => gate.wrapLongRunning('v8vscedit_execute_command', extra, async () => {
      if (LOCKING_COMMANDS.has(command) && isConfigurationOperationRunning()) {
        throw new Error(MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE);
      }
      const result = await vscode.commands.executeCommand(command);
      return { command, result: result ?? null };
    })
  );

  server.registerTool(
    'v8vscedit_update_database_configuration',
    {
      title: 'Обновить конфигурацию БД',
      description: 'Применяет основную конфигурацию базы к её структуре (/UpdateDBCfg) через пакетный Конфигуратор; может вызвать реструктуризацию данных базы и занять продолжительное время. Снимает признак «конфигурация БД не обновлена» (databaseConfigurationBehind). Файлы проекта в базу НЕ загружаются — для этого используйте v8vscedit_load_configuration_changes. Принимает канонический путь корня: Конфигурация или Расширение.',
      inputSchema: z.object({
        path: z.string(),
        configuration: z.string().optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    // Без confirm — паритет с «Обновить БД» в UI. gate.afterMutation не вызывается: файлы проекта не
    // менялись, а пометка «изменено» заставила бы «Обновить БД» залить их поверх базы (как у load_cf).
    ({ path, configuration }, extra) => gate.wrapLongRunning('v8vscedit_update_database_configuration', extra, async () => {
      // Текст отказа для не-корня — тот же, что у остальных инструментов корня конфигурации.
      resolveConfigurationXmlByCanonical(deps.paths, path, configuration);
      const target = resolveApplyTargetFromNode(deps.paths.resolveNode(path, configuration));
      /* c8 ignore next 3 -- защитная ветка: корень с Configuration.xml проверен выше */
      if (!target) {
        throw new Error(`Путь "${path}" должен указывать на корень конфигурации или расширения.`);
      }
      return runWithConfigurationOperationLockOrThrow(async () => {
        const updated = await runApplyDatabaseConfigurationWithOutcome(
          target, services.workspaceFolder, services.outputChannel, services.databaseConfigLag, false, true
        );
        if (!updated.success) {
          throw new Error('Обновление конфигурации БД не выполнено. Подробности — в журнале «1С Редактор».');
        }
        const repositoryTarget = services.repositoryService.resolveTargetByConfigRoot(target.rootPath);
        const unloadedChangedFilesCount = repositoryTarget
          ? (await findChangedConfiguration(services, repositoryTarget))?.changedFilesCount ?? 0
          : 0;
        return {
          path,
          kind: target.kind,
          name: target.name,
          databaseConfigurationUpdated: true,
          unloadedChangedFilesCount,
          databaseConfigurationBehind: services.databaseConfigLag.isBehind(target),
          ...(unloadedChangedFilesCount > 0
            ? { note: '/UpdateDBCfg не загружает файлы проекта: правки применятся только после v8vscedit_load_configuration_changes' }
            : {}),
          // Предупреждения сверки после применения расширения (E11: имя в базе взято из файла).
          ...definedFields({ warnings: mergeWarnings(updated.warnings) }),
        };
      });
    })
  );

  server.registerTool(
    'v8vscedit_load_configuration_changes',
    {
      title: 'Загрузить изменения в базу',
      description: 'Загружает изменённые файлы проекта корня конфигурации или расширения в основную конфигурацию базы (тот же путь, что команды «Обновить в базе» и «Загрузить в базу без обновления БД»). updateDatabase обязателен: true — после загрузки обновить конфигурацию БД (/UpdateDBCfg, возможна долгая реструктуризация данных); false — только основная конфигурация (для помещения в хранилище этого достаточно), конфигурация БД отмечается как не обновлённая (databaseConfigurationBehind) до v8vscedit_update_database_configuration. Если изменений нет, а конфигурация БД отстаёт, при updateDatabase: true выполняется только обновление БД. Принимает канонический путь корня: Конфигурация или Расширение.',
      inputSchema: z.object({
        path: z.string(),
        configuration: z.string().optional(),
        // Без умолчания: минуты реструктуризации — решение вызывающего агента, а не настройки.
        updateDatabase: z.boolean(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    // gate.afterMutation не вызывается: файлы проекта не менялись (как у update_database_configuration).
    ({ path, configuration, updateDatabase }, extra) => gate.wrapLongRunning('v8vscedit_load_configuration_changes', extra, async () => {
      resolveConfigurationXmlByCanonical(deps.paths, path, configuration);
      const target = resolveApplyTargetFromNode(deps.paths.resolveNode(path, configuration));
      /* c8 ignore next 3 -- защитная ветка: корень с Configuration.xml проверен выше */
      if (!target) {
        throw new Error(`Путь "${path}" должен указывать на корень конфигурации или расширения.`);
      }
      return runWithConfigurationOperationLockOrThrow(async () => {
        let outcome: DatabaseLoadOutcome = { databaseUpdated: false, warnings: [] };
        const options = {
          updateDatabase,
          lag: services.databaseConfigLag,
          silent: true,
          onOutcome: (reported: DatabaseLoadOutcome) => { outcome = reported; },
        };
        const loaded = target.kind === 'cfe'
          // У корня расширения имя цели и есть имя расширения (resolveApplyTargetFromNode).
          ? await runUpdateExtension(
              target.name, target.rootPath, services.workspaceFolder, services.outputChannel, false, undefined, options
            )
          : await runUpdateMainConfiguration(
              target.name, target.rootPath, services.workspaceFolder, services.outputChannel, false, undefined, options
            );
        if (!loaded) {
          throw new Error('Загрузка изменений в базу не выполнена. Подробности — в журнале «1С Редактор».');
        }
        services.markConfigurationsClean([target.rootPath]);
        refreshRepositoryUi(services);
        return {
          path,
          kind: target.kind,
          name: target.name,
          updateDatabase,
          // Фактически: при updateDatabase: true без изменений и без отставания UpdateDBCfg не выполняется.
          databaseConfigurationUpdated: outcome.databaseUpdated,
          databaseConfigurationBehind: services.databaseConfigLag.isBehind(target),
          // Предупреждения сверки после применения расширения (E11: имя в базе взято из файла).
          ...definedFields({ warnings: mergeWarnings(outcome.warnings) }),
        };
      });
    })
  );
}

/**
 * Отчёт прогона пакетной операции.
 *
 * Три случая — не итог, а отказ, и молчать о них нельзя: отчёта нет вовсе (CLI
 * не дошёл до его записи — например, платформа недоступна), отказ ДО старта
 * (`errors`: ни одного спавна Конфигуратора не было) и прерывание сигналом
 * (обработаны не все расширения). «Успехом с пустым результатом» агент принял
 * бы любой из них за штатный итог.
 */
function assertBatchReport(report: CfeBatchReport | undefined, failureMessage: string, failureReason?: string): CfeBatchReport {
  // Агентская операция без отчёта несёт причину: агент MCP получает её дословно.
  if (!report && failureReason !== undefined) {
    throw new Error(`${failureMessage} ${failureReason}`);
  }
  if (!report) {
    throw new Error(`${failureMessage} Подробности — в журнале «1С Редактор».`);
  }
  const errors = report.errors ?? [];
  // Потеря связи с агентом (`abortReason`) — тоже не итог: обработаны не все расширения.
  const abort = report.abortReason === undefined ? [] : [report.abortReason];
  if (errors.length > 0 || report.interrupted || abort.length > 0) {
    // Загрузка через агента до обрыва уже могла применить новые расширения — об этом сказать явно.
    const applied = report.operation === 'load' ? appliedBeforeFailureNotes(report) : [];
    throw new Error([failureMessage, ...errors, ...abort, ...applied, 'Подробности — в журнале «1С Редактор».'].join(' '));
  }
  return report;
}

/** Непустые списки предупреждений; `undefined` — предупреждений нет (ответ не получает ключа `warnings`). */
function mergeWarnings(...lists: (readonly string[] | undefined)[]): string[] | undefined {
  let merged: string[] | undefined;
  for (const list of lists) {
    if (list !== undefined && list.length > 0) {
      merged = [...(merged ?? []), ...list];
    }
  }
  return merged;
}

/**
 * Что уже изменено в базе до сбоя пакетной загрузки (агентская ветка): новые расширения применены сразу, плюс
 * предупреждения сверки. Пусто — в базе применено ничего не было (batch или сбой на первом новом).
 */
function appliedBeforeFailureNotes(report: CfeBatchReport): string[] {
  const applied = report.items
    .filter((item) => item.status === 'ok' && item.appliedToDatabase === true)
    .map((item) => item.extensionName);
  return [
    ...(applied.length > 0 ? [`Уже созданы в базе и применены (update-db-cfg выполнен): ${applied.join(', ')}.`] : []),
    ...(report.verificationWarnings ?? []),
  ];
}

/** Только заданные поля: batch-ответ не получает ключей агентской ветки со значением `undefined`. */
function definedFields(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
