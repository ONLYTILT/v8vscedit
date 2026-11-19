import * as vscode from 'vscode';
import type {
  AgentMirrorSeedDecision,
  AgentMirrorSeedReason,
  AgentMirrorSeedRequest,
} from '../../../../infra/agent/AgentOperationService';

const SEED_ACTION = 'Использовать выгрузку проекта';

/**
 * Тексты по причине вопроса: пустое зеркало — прежний вопрос с кнопкой «Полная выгрузка»; замена
 * выгрузки проекта извне — вторая кнопка «Обычный импорт» (прежний путь без посева, не обязательно
 * полная выгрузка). Таблицей, а не ветками: исходы обеих причин одинаковы (seed/full/cancel).
 */
const REASON_TEXTS: Readonly<Record<AgentMirrorSeedReason, {
  readonly message: (targetName: string) => string;
  readonly fullAction: string;
  readonly alternative: string;
}>> = {
  'mirror-empty': {
    message: (targetName) => `Зеркало выгрузки агента для «${targetName}» пусто. Использовать выгрузку проекта как основу?`,
    fullAction: 'Полная выгрузка',
    alternative: 'Полная выгрузка надёжнее, но для большой конфигурации занимает заметное время.',
  },
  'project-replaced': {
    message: (targetName) =>
      `Выгрузка проекта для «${targetName}» заменена (файл версий изменился после последней синхронизации). ` +
      'Взять её за основу зеркала агента?',
    fullAction: 'Обычный импорт',
    alternative:
      '«Обычный импорт» сравнит проект с прежней базовой линией: отличия ручной выгрузки будут считаться ' +
      'локальными правками и могут потребовать полной выгрузки на сервере.',
  },
};

/**
 * Вопрос о посеве зеркала агента из выгрузки проекта. Это вопрос с ответом (как
 * `showAgentQuestion`), а не уведомление: операция ждёт решения, поэтому модальность уместна, а
 * запрет №18 (уведомления без `await` внутри эксклюзивной секции) его не касается.
 *
 * Закрытие диалога — отмена, а не посев: согласие на скрытое расхождение P и БД даётся только явно.
 */
export async function promptMirrorSeed(request: AgentMirrorSeedRequest): Promise<AgentMirrorSeedDecision> {
  const texts = REASON_TEXTS[request.reason];
  const edits = request.localEditsSinceBaseline === undefined
    ? ''
    : ` (известно ${String(request.localEditsSinceBaseline)} таких файлов)`;
  const answer = await vscode.window.showWarningMessage(
    texts.message(request.targetName),
    {
      modal: true,
      detail:
        `Выгрузка проекта: ${request.projectDir}, файл версий от ${request.dumpInfoModifiedAt.toLocaleString('ru-RU')}. ` +
        'Будут скачаны только объекты, изменённые в базе после неё. ' +
        `Ручные правки XML в проекте после этой выгрузки, не загруженные в базу, перезаписаны НЕ будут${edits}. ` +
        'Они войдут в базовую линию и не попадут в загрузку «по изменениям»: расхождение проекта и базы ' +
        'останется до полной загрузки. ' +
        texts.alternative,
    },
    SEED_ACTION,
    texts.fullAction
  );
  if (answer === SEED_ACTION) {
    return 'seed';
  }
  return answer === texts.fullAction ? 'full' : 'cancel';
}
