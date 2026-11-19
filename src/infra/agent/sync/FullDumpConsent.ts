import { AgentFullDumpDeclinedError, type FullDumpConsentContext, type SyncOperationContext } from './SyncContext';
import { SERVER_DUMP_POLICY, type ServerDumpReason } from './SyncPlanner';

export type { FullDumpConsentContext } from './SyncContext';

/**
 * Вопрос перед полной серверной выгрузкой — общий для импорта и загрузки: архив или перезапись зеркала
 * (`download: false` — скачиваются только изменённые файлы, текст вопроса другой). Нет хука — согласие
 * (прежнее поведение без человека), отказ — исключение с текстом по контексту вопроса.
 */
export async function confirmFullDumpOrThrow(
  context: SyncOperationContext,
  reason: ServerDumpReason,
  consent: FullDumpConsentContext
): Promise<void> {
  const confirm = context.hooks?.confirmFullDump;
  if (confirm === undefined) {
    return;
  }
  const { text: reasonText, download } = SERVER_DUMP_POLICY[reason];
  const decision = await confirm({
    targetKind: context.target.kind,
    targetName: context.extensionName ?? context.target.name,
    projectDir: context.target.rootPath,
    operation: consent === 'load' ? 'load' : 'import',
    reason,
    reasonText,
    download,
  });
  if (decision === 'cancel') {
    throw new AgentFullDumpDeclinedError(consent, reasonText);
  }
}
