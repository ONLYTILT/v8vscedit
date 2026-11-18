import * as vscode from 'vscode';
import type { AgentOrphanFilesRequest } from '../../../../infra/agent/AgentOperationService';
import { summarizeList } from '../../../../infra/agent/sync/ProjectSeed';

const DELETE_ACTION = 'Удалить файлы';
/** Длинный перечень в модальном окне нечитаем: поимённо — первые 20, остальные числом. */
const OWNERS_SHOWN = 20;

/**
 * Вопрос об удалении «осиротевших» файлов выгрузки проекта: их объектов нет в базе (удалены до ручной
 * выгрузки, сделанной поверх прежней). Удаление файлов — только по явному согласию: Esc — «не удалять».
 */
export async function promptOrphanRemoval(request: AgentOrphanFilesRequest): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `В выгрузке проекта «${request.targetName}» есть файлы объектов, которых нет в базе: ${String(request.owners.length)}. Удалить их?`,
    {
      modal: true,
      detail: `${summarizeList(request.owners, OWNERS_SHOWN, '\n')}\n\nФайлов: ${String(request.files.length)}.`,
    },
    DELETE_ACTION
  );
  return answer === DELETE_ACTION;
}
