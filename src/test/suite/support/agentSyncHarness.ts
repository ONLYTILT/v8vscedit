/**
 * Стенд движка синхронизации (Э7): настоящий AgentSyncEngine поверх настоящего хранилища файлов
 * (локального или SFTP на in-process ssh2.Server) и эмулятора команд агента.
 *
 * Корень персонального каталога пользователя (`userRoot`) один на всех: M лежит в
 * `userRoot/workspace/<projectId>/cf` (для расширения — `cfe/<имя>`), обмен — в `userRoot/exchange`,
 * списки — в `userRoot/lists`. Локальный каталог обмена потокового архива — `localExchangeRoot`
 * (под тем же временным корнем теста, а не в профиле пользователя). Подменяется ТОЛЬКО агент 1С.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentConnectPolicyOptions } from '../../../domain/agent';
import type { AgentCommandExecutor } from '../../../infra/agent/AgentInfoBaseSession';
import type { AgentConfigurationOperationTarget, AgentOperationHooks } from '../../../infra/agent/AgentOperationService';
import { AgentWorkspaceService, buildAgentProjectId } from '../../../infra/agent/AgentWorkspaceService';
import type { AgentFileStore } from '../../../infra/agent/files/AgentFileStore';
import { LocalAgentFileStore } from '../../../infra/agent/files/LocalAgentFileStore';
import { connectSftpAgentFileStore } from '../../../infra/agent/files/SftpAgentFileStore';
import { AgentSyncEngine } from '../../../infra/agent/sync/AgentSyncEngine';
import {
  loadSyncManifest,
  resolveSyncManifestPath,
  saveSyncManifest,
  type SyncManifest,
  type SyncMirrorCoverage,
  type SyncMirrorState,
} from '../../../infra/agent/sync/SyncManifest';
import { buildScopeKey } from '../../../infra/cache/HashCache';
import { AgentConfigEmulator } from './agentConfigEmulator';
import { AgentSshTestServer } from './agentSshTestServer';
import type { SftpTestBackend } from './agentSftpTestBackend';

export type HarnessKind = 'sftp' | 'local';
export type HarnessTargetKind = 'cf' | 'cfe';

/** Имя расширения цели `cfe` в стенде. */
export const HARNESS_EXTENSION_NAME = 'Расш';

export interface HarnessOptions {
  readonly archiveThresholdFiles?: number;
  readonly transferConcurrency?: number;
  /** Обёртка над хранилищем (счётчики, отмена по числу операций). */
  readonly wrapStore?: (store: AgentFileStore) => AgentFileStore;
  /** Цель: основная конфигурация (по умолчанию) или расширение `Расш`. */
  readonly targetKind?: HarnessTargetKind;
}

export interface SyncHarness {
  readonly kind: HarnessKind;
  readonly targetKind: HarnessTargetKind;
  readonly projectRoot: string;
  /** P: каталог выгрузки в проекте. */
  readonly configRoot: string;
  readonly userRoot: string;
  /** Локальный каталог обмена потокового архива (`<base>/local-exchange`). */
  readonly localExchangeRoot: string;
  /** M относительно персонального корня. */
  readonly mirrorDir: string;
  /** M на диске. */
  readonly mirrorAbs: string;
  readonly emulator: AgentConfigEmulator;
  readonly engine: AgentSyncEngine;
  readonly exec: AgentCommandExecutor;
  readonly target: AgentConfigurationOperationTarget;
  readonly store: AgentFileStore;
  readonly sftp: SftpTestBackend | undefined;
  /** Сколько раз стенд создавал имя операции: имена `exchange/<op>` предсказуемы (`cf-1`, `cf-2`, …). */
  readonly clock: { now: () => number };
  seedDb(): void;
  /** Импорт цели стенда; `hooks` пробрасываются как есть (в т.ч. `confirmMirrorSeed`). */
  importTarget(hooks?: AgentOperationHooks): ReturnType<AgentSyncEngine['importTarget']>;
  loadTarget(mode: 'full' | 'changed', hooks?: AgentOperationHooks): ReturnType<AgentSyncEngine['loadTarget']>;
  manifest(): SyncManifest;
  /** Записывает манифест; полнота M по умолчанию не задаётся (поле отсутствует ⇒ `full`). */
  saveManifest(mirrorState: SyncMirrorState, files?: Record<string, string>, mirrorCoverage?: SyncMirrorCoverage): void;
  /**
   * Делает M ПОЛНЫМ: M очищается и заполняется полной выгрузкой базы (с ConfigDumpInfo.xml), а в манифесте
   * фиксируется `mirrorCoverage: 'full'` (B и состояние M сохраняются). Так в тестах получается контрольный
   * режим `full` без прохода через загрузку с `full-dump`.
   */
  makeMirrorFull(): void;
  /** Содержимое P: путь → текст (для проверки целиком). */
  snapshotP(): Record<string, string>;
  readP(rel: string): string;
  writeP(rel: string, content: string | Buffer): void;
  removeP(rel: string): void;
  existsP(rel: string): boolean;
  readM(rel: string): string;
  /** Все файлы M: путь → байты (для проверки «M не тронут» побайтно, в т.ч. двоичных). */
  snapshotM(): Record<string, string>;
  /** Сырой текст файла манифеста B (или `undefined`): проверка «манифест не тронут» побайтно. */
  rawManifestText(): string | undefined;
  /** Файлы M (относительные POSIX-пути, без каталогов), отсортированы. */
  listM(): string[];
  /** Остатки серверного каталога обмена (`userRoot/exchange`). */
  serverExchangeLeftovers(): string[];
  /** Остатки локального каталога обмена (`localExchangeRoot`). */
  localExchangeLeftovers(): string[];
  dispose(): Promise<void>;
}

/** Стандартная «база»: владельцы верхнего уровня и их файлы. */
export const STANDARD_DB: Record<string, Record<string, string>> = {
  'Configuration.Конфигурация': { 'Configuration.xml': '<Configuration v="1"/>' },
  'Catalog.Товары': {
    'Catalogs/Товары.xml': '<Catalog>Товары</Catalog>',
    'Catalogs/Товары/Ext/ObjectModule.bsl': 'Процедура Товары() КонецПроцедуры',
  },
  'Catalog.Клиенты': { 'Catalogs/Клиенты.xml': '<Catalog>Клиенты</Catalog>' },
  'Document.Заказ': {
    'Documents/Заказ.xml': '<Document>Заказ</Document>',
    'Documents/Заказ/Ext/ObjectModule.bsl': 'Процедура Заказ() КонецПроцедуры',
    'Documents/Заказ/Forms/Форма.xml': '<Form>Форма</Form>',
    'Documents/Заказ/Forms/Форма/Ext/Form.xml': '<FormBody/>',
  },
  'Role.Админ': {
    'Roles/Админ.xml': '<Role>Админ</Role>',
    'Roles/Админ/Ext/Rights.xml': '<Rights/>',
  },
  'CommonModule.Общий': {
    'CommonModules/Общий.xml': '<CommonModule>Общий</CommonModule>',
    'CommonModules/Общий/Ext/Module.bsl': 'Процедура Общий() КонецПроцедуры',
  },
};

const POLICY: AgentConnectPolicyOptions = { startupTimeoutMs: 5_000, authWarmupMs: 90_000, retryDelayMs: 1_000 };

export async function createHarness(kind: HarnessKind, options: HarnessOptions = {}): Promise<SyncHarness> {
  const targetKind = options.targetKind ?? 'cf';
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `v8-sync-${kind}-`));
  const projectRoot = path.join(base, 'project');
  const configRoot = targetKind === 'cf'
    ? path.join(projectRoot, 'src', 'cf')
    : path.join(projectRoot, 'src', 'cfe', HARNESS_EXTENSION_NAME);
  const userRoot = path.join(base, 'user-root');
  const localExchangeRoot = path.join(base, 'local-exchange');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(userRoot, { recursive: true });

  let server: AgentSshTestServer | undefined;
  let rawStore: AgentFileStore;
  if (kind === 'sftp') {
    server = await AgentSshTestServer.start({ sftpRoot: userRoot });
    rawStore = await connectSftpAgentFileStore({
      host: '127.0.0.1',
      port: server.port,
      user: 'admin',
      password: 'secret',
      connectTimeoutSeconds: 5,
      policy: POLICY,
    });
  } else {
    rawStore = new LocalAgentFileStore(userRoot);
  }
  const store = options.wrapStore ? options.wrapStore(rawStore) : rawStore;

  let tick = 0;
  const clock = { now: (): number => { tick += 1; return tick; } };
  const projectId = buildAgentProjectId(projectRoot);
  const engine = new AgentSyncEngine({
    projectRoot,
    store,
    workspace: new AgentWorkspaceService(store, projectId),
    archiveThresholdFiles: options.archiveThresholdFiles,
    transferConcurrency: options.transferConcurrency,
    localExchangeRoot,
    now: clock.now,
  });
  const emulator = new AgentConfigEmulator(userRoot);
  const mirrorDir = targetKind === 'cf' ? `workspace/${projectId}/cf` : `workspace/${projectId}/cfe/${HARNESS_EXTENSION_NAME}`;
  const mirrorAbs = path.join(userRoot, ...mirrorDir.split('/'));
  const scopeKey = targetKind === 'cf'
    ? buildScopeKey('cf', configRoot)
    : buildScopeKey('cfe', configRoot, HARNESS_EXTENSION_NAME);
  const abs = (rel: string): string => path.join(configRoot, ...rel.split('/'));
  const target: AgentConfigurationOperationTarget = targetKind === 'cf'
    ? { kind: 'cf', name: 'Основная', rootPath: configRoot }
    : { kind: 'cfe', name: HARNESS_EXTENSION_NAME, rootPath: configRoot };

  const walk = (dir: string, rel: string, out: Record<string, string>): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), childRel, out);
      } else {
        out[childRel] = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
      }
    }
  };
  const listFilesUnder = (dir: string): string[] => {
    const out: string[] = [];
    if (fs.existsSync(dir)) {
      const files: Record<string, string> = {};
      walk(dir, '', files);
      out.push(...Object.keys(files));
    }
    return out.sort();
  };
  const exec: AgentCommandExecutor = { execute: (command) => emulator.execute(command) };

  return {
    kind,
    targetKind,
    projectRoot,
    configRoot,
    userRoot,
    localExchangeRoot,
    mirrorDir,
    mirrorAbs,
    emulator,
    engine,
    exec,
    target,
    store,
    sftp: server?.sftp,
    clock,
    seedDb: () => {
      for (const [fullName, files] of Object.entries(STANDARD_DB)) {
        emulator.setObject(fullName, files);
      }
    },
    importTarget: (hooks) => engine.importTarget(target, exec, hooks),
    loadTarget: (mode, hooks) => engine.loadTarget(target, mode, exec, hooks),
    manifest: () => loadSyncManifest(projectRoot, scopeKey),
    saveManifest: (mirrorState, files = {}, mirrorCoverage) => {
      saveSyncManifest(projectRoot, {
        schemaVersion: 1,
        scopeKey,
        mirrorState,
        files,
        ...(mirrorCoverage === undefined ? {} : { mirrorCoverage }),
      });
    },
    makeMirrorFull: () => {
      const clear = (dir: string): void => {
        if (!fs.existsSync(dir)) {
          return;
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const child = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            clear(child);
            fs.rmdirSync(child);
          } else {
            fs.unlinkSync(child);
          }
        }
      };
      clear(mirrorAbs);
      emulator.snapshotToProject(mirrorAbs);
      saveSyncManifest(projectRoot, { ...loadSyncManifest(projectRoot, scopeKey), mirrorCoverage: 'full' });
    },
    snapshotP: () => {
      const out: Record<string, string> = {};
      if (fs.existsSync(configRoot)) {
        walk(configRoot, '', out);
      }
      return out;
    },
    readP: (rel) => fs.readFileSync(abs(rel), 'utf-8'),
    writeP: (rel, content) => {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), content);
    },
    removeP: (rel) => { if (fs.existsSync(abs(rel))) { fs.unlinkSync(abs(rel)); } },
    existsP: (rel) => fs.existsSync(abs(rel)),
    readM: (rel) => fs.readFileSync(path.join(mirrorAbs, ...rel.split('/')), 'utf-8'),
    listM: () => listFilesUnder(mirrorAbs),
    snapshotM: () => {
      const out: Record<string, string> = {};
      const collect = (dir: string, rel: string): void => {
        if (!fs.existsSync(dir)) {
          return;
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            collect(path.join(dir, entry.name), childRel);
          } else {
            out[childRel] = fs.readFileSync(path.join(dir, entry.name)).toString('base64');
          }
        }
      };
      collect(mirrorAbs, '');
      return out;
    },
    rawManifestText: () => {
      const file = resolveSyncManifestPath(projectRoot, scopeKey);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : undefined;
    },
    serverExchangeLeftovers: () => {
      const dir = path.join(userRoot, 'exchange');
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    localExchangeLeftovers: () => (fs.existsSync(localExchangeRoot) ? fs.readdirSync(localExchangeRoot).sort() : []),
    dispose: async () => {
      await rawStore.dispose();
      await server?.close();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

/** Ожидаемое содержимое P после импорта «как в базе» (с ConfigDumpInfo.xml, который кладёт архив). */
export function dbAsText(files: Record<string, Buffer>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([rel, data]) => [rel, data.toString('utf-8')]));
}
