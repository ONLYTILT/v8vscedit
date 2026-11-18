import { createHash } from 'crypto';
import type { AgentConfigurationTarget } from '../../domain/agent';
import type { AgentFileStore } from './files/AgentFileStore';

/**
 * Раскладка рабочей области в персональном корне агента. Все пути — относительные POSIX-пути
 * от корня хранилища, в том виде, в каком их принимает агент (`--dir`, `--list-file`).
 */
export interface AgentWorkspacePaths {
  readonly projectId: string;
  /** `workspace/<projectId>`. */
  readonly workspaceRoot: string;
  readonly listsRoot: string;
  readonly exchangeRoot: string;
  /** Серверное зеркало выгрузки цели: `workspace/<projectId>/cf` или `…/cfe/<имя>`. */
  readonly targetAgentDir: string;
}

const LISTS_ROOT = 'lists';
const EXCHANGE_ROOT = 'exchange';

/**
 * Сегмент проекта в персональном корне. Корень у пользователя один на агента, а одну базу
 * могут обслуживать два проекта (или два окна): без сегмента их зеркала затирали бы друг
 * друга. Форма записи корня (слэши, хвостовой разделитель, регистр буквы диска — VS Code
 * отдаёт `c:\`, а настройки и терминал — `C:\`) на сегмент не влияет.
 */
export function buildAgentProjectId(projectRoot: string): string {
  const normalized = projectRoot
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/^([A-Za-z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
  return createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 8);
}

export class AgentWorkspaceService {
  private readonly projectId: string;

  constructor(private readonly store: AgentFileStore, projectId: string) {
    this.projectId = sanitizePathPart(projectId);
  }

  resolveWorkspace(target: AgentConfigurationTarget): AgentWorkspacePaths {
    const workspaceRoot = `workspace/${this.projectId}`;
    const targetAgentDir = target.kind === 'cf'
      ? `${workspaceRoot}/cf`
      : `${workspaceRoot}/cfe/${sanitizePathPart(requireExtensionName(target))}`;
    return {
      projectId: this.projectId,
      workspaceRoot,
      listsRoot: LISTS_ROOT,
      exchangeRoot: EXCHANGE_ROOT,
      targetAgentDir,
    };
  }

  async ensureWorkspace(target: AgentConfigurationTarget): Promise<AgentWorkspacePaths> {
    const workspace = this.resolveWorkspace(target);
    await this.store.mkdirp(workspace.targetAgentDir);
    await this.store.mkdirp(workspace.listsRoot);
    await this.store.mkdirp(workspace.exchangeRoot);
    return workspace;
  }

  /**
   * Пишет list-файл частичной загрузки и возвращает его путь для агента (`lists/<op>.txt`).
   * Формат — UTF-8 с BOM и `\n` между путями: так его читает конфигуратор.
   */
  async writeListFile(operationId: string, relativeFiles: readonly string[]): Promise<string> {
    const listPath = `${LISTS_ROOT}/${sanitizePathPart(operationId)}.txt`;
    const normalized = relativeFiles.map(normalizeRelativeFilePath);
    await this.store.writeFile(listPath, `\uFEFF${normalized.join('\n')}`);
    return listPath;
  }
}

function requireExtensionName(target: AgentConfigurationTarget): string {
  const name = target.extensionName?.trim();
  if (!name) {
    throw new Error('Для агентской операции с расширением требуется имя расширения.');
  }
  return name;
}

/** Безопасный сегмент пути агента: всё, кроме букв, цифр и `._-`, заменяется на `_`. */
export function sanitizePathPart(value: string): string {
  const result = value.trim().replace(/[^\p{L}\p{N}._-]+/gu, '_');
  if (!result || result === '.' || result === '..') {
    throw new Error(`Некорректный сегмент пути агента: ${value}`);
  }
  return result;
}

function normalizeRelativeFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').trim();
  // Абсолютность проверяется по обеим нотациям (POSIX и диск Windows) независимо от ОС:
  // путь уходит агенту, который может работать на другой платформе.
  if (!normalized || /^(\/|[A-Za-z]:)/.test(normalized)) {
    throw new Error('Пути в list-файле агента должны быть относительными.');
  }

  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Путь list-файла агента не должен выходить за пределы каталога выгрузки.');
  }

  return parts.join('/');
}
