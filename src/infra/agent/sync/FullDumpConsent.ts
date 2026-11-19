import { AgentFullDumpDeclinedError, type FullDumpConsentContext, type SyncOperationContext } from './SyncContext';
import { ARCHIVE_REASON_POLICY, type ImportArchiveReason } from './SyncPlanner';

export type { FullDumpConsentContext } from './SyncContext';

/**
 * Вопрос перед полной серверной выгрузкой — общий для импорта и загрузки. Нет хука — согласие
 * (прежнее поведение без человека), отказ — исключение с текстом по контексту вопроса.
 */
export async function confirmFullDumpOrThrow(
  context: SyncOperationContext,
  reason: ImportArchiveReason,
  consent: FullDumpConsentContext
): Promise<void> {
  const confirm = context.hooks?.confirmFullDump;
  if (confirm === undefined) {
    return;
  }
  const reasonText = ARCHIVE_REASON_POLICY[reason].text;
  const decision = await confirm({
    targetKind: context.target.kind,
    targetName: context.extensionName ?? context.target.name,
    projectDir: context.target.rootPath,
    operation: consent === 'load' ? 'load' : 'import',
    reason,
    reasonText,
  });
  if (decision === 'cancel') {
    throw new AgentFullDumpDeclinedError(consent, reasonText);
  }
}
