import * as vscode from 'vscode';
import type { AgentMirrorSeedDecision, AgentMirrorSeedRequest } from '../../../../infra/agent/AgentOperationService';

const SEED_ACTION = 'Использовать выгрузку проекта';
const FULL_ACTION = 'Полная выгрузка';

/**
 * Вопрос о посеве пустого зеркала агента из выгрузки проекта. Это вопрос с ответом (как
 * `showAgentQuestion`), а не уведомление: операция ждёт решения, поэтому модальность уместна, а
 * запрет №18 (уведомления без `await` внутри эксклюзивной секции) его не касается.
 *
 * Закрытие диалога — отмена, а не посев: согласие на скрытое расхождение P и БД даётся только явно.
 */
export async function promptMirrorSeed(request: AgentMirrorSeedRequest): Promise<AgentMirrorSeedDecision> {
  const edits = request.localEditsSinceBaseline === undefined
    ? ''
    : ` (известно ${String(request.localEditsSinceBaseline)} таких файлов)`;
  const answer = await vscode.window.showWarningMessage(
    `Зеркало выгрузки агента для «${request.targetName}» пусто. Использовать выгрузку проекта как основу?`,
    {
      modal: true,
      detail:
        `Выгрузка проекта: ${request.projectDir}, файл версий от ${request.dumpInfoModifiedAt.toLocaleString('ru-RU')}. ` +
        'Будут скачаны только объекты, изменённые в базе после неё. ' +
        `Ручные правки XML в проекте после этой выгрузки, не загруженные в базу, перезаписаны НЕ будут${edits}. ` +
        'Они войдут в базовую линию и не попадут в загрузку «по изменениям»: расхождение проекта и базы ' +
        'останется до полной загрузки. ' +
        'Полная выгрузка надёжнее, но для большой конфигурации занимает заметное время.',
    },
    SEED_ACTION,
    FULL_ACTION
  );
  if (answer === SEED_ACTION) {
    return 'seed';
  }
  return answer === FULL_ACTION ? 'full' : 'cancel';
}
