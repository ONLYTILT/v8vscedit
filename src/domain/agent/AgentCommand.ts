export type AgentConfigurationTargetKind = 'cf' | 'cfe';

export interface AgentConfigurationTarget {
  readonly kind: AgentConfigurationTargetKind;
  readonly extensionName?: string;
}

export interface AgentCommandOptions {
  readonly format?: 'hierarchical' | 'plain';
  readonly extensionName?: string;
  readonly allExtensions?: boolean;
  readonly update?: boolean;
  readonly force?: boolean;
  readonly listFile?: string;
  readonly partial?: boolean;
  readonly updateConfigDumpInfo?: boolean;
  readonly noCheck?: boolean;
  readonly threads?: string;
  /** Имя архива; агент разрешает его относительно `--dir` (факт пилота §5b п.6). */
  readonly archive?: string;
  readonly getChanges?: string;
  readonly configDumpInfoForChanges?: string;
  readonly configDumpInfoOnly?: boolean;
}

export function buildAgentCommand(command: string, options: Record<string, string | boolean | undefined> = {}): string {
  const parts = [command];
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined || value === false) {
      continue;
    }
    if (value === true) {
      parts.push(`--${name}`);
      continue;
    }
    parts.push(`--${name}=${quoteAgentArgument(value)}`);
  }
  return parts.join(' ');
}

export function buildDumpConfigToFilesCommand(dirPath: string, options: AgentCommandOptions = {}): string {
  // Пилот: `--update` вместе с `--archive` агент не выполняет, а сообщает об этом невнятно —
  // ошибку в построении команды ловим до отправки.
  if (options.update && options.archive !== undefined) {
    throw new Error('Выгрузка агента: ключи --update и --archive вместе не поддерживаются (update + archive).');
  }
  return buildAgentCommand('config dump-config-to-files', {
    dir: dirPath,
    extension: options.extensionName,
    'all-extensions': options.allExtensions,
    format: options.format ?? 'hierarchical',
    update: options.update,
    force: options.force,
    'list-file': options.listFile,
    'get-changes': options.getChanges,
    'config-dump-info-for-changes': options.configDumpInfoForChanges,
    'config-dump-info-only': options.configDumpInfoOnly,
    archive: options.archive,
  });
}

export function buildLoadConfigFromFilesCommand(dirPath: string, options: AgentCommandOptions = {}): string {
  return buildAgentCommand('config load-config-from-files', {
    dir: dirPath,
    extension: options.extensionName,
    'all-extensions': options.allExtensions,
    format: options.format ?? 'hierarchical',
    'list-file': options.listFile,
    archive: options.archive,
    partial: options.partial,
    'update-config-dump-info': options.updateConfigDumpInfo,
    'no-check': options.noCheck,
    threads: options.threads,
  });
}

export function buildUpdateDbCfgCommand(options: AgentCommandOptions = {}): string {
  return buildAgentCommand('config update-db-cfg', {
    extension: options.extensionName,
  });
}

export function quoteAgentArgument(value: string): string {
  if (/^[^\s"']+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
