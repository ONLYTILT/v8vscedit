import { buildDumpConfigToFilesCommand } from '../../../domain/agent/AgentCommand';
import { parseDumpChanges, type DumpChangeSet } from '../../../domain/agent/DumpChangesParser';
import { exchangeDirOf, type SyncOperationContext } from './SyncContext';

/**
 * Список изменений базы относительно файла версий M: `dump --update --get-changes=exchange/<op><suffix>`.
 * С `--get-changes` агент только пишет список (пилот §5b п.4), M не меняется. Суффикс разделяет первый
 * список и повторный после очистки зеркала: файлы не перетирают друг друга, уборка — по
 * `EXCHANGE_SIDE_SUFFIXES`.
 */
export async function fetchChangeSet(context: SyncOperationContext, suffix: string): Promise<DumpChangeSet> {
  const changesFile = `${exchangeDirOf(context)}${suffix}`;
  context.progress.step('Запрос списка изменений базы у агента…');
  await context.exec.execute(buildDumpConfigToFilesCommand(context.workspace.targetAgentDir, {
    extensionName: context.extensionName,
    update: true,
    getChanges: changesFile,
  }));
  return parseDumpChanges((await context.store.readFile(changesFile)).toString('utf-8'));
}
