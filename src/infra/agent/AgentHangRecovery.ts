import { AgentConnectionLostError } from './AgentTransport';

/**
 * Что делать, если агент не ответил на короткую команду за срок. Известного триггера нет (ФАКТ Э30–Э31:
 * наблюдавшееся «зависание» на списке расширений было иной формой ответа), это общая защита: процесс, который
 * не отвечает, повтором команды не оживить. Свой локальный процесс (запущенный расширением) перезапускается;
 * чужой локальный и удалённый — только явная просьба перезапустить.
 */
export interface AgentHangRecoveryDecision {
  /** Остановить свой процесс агента: следующая операция запустит его заново. */
  readonly restartOwnProcess: boolean;
  /** Текст причины отказа операции для человека. */
  readonly text: string;
}

export interface AgentHangRecoveryContext {
  readonly location: 'local' | 'remote';
  /** Процесс агента запущен этим расширением (автозапуск), а не пользователем. */
  readonly ownsProcess: boolean;
}

/** `undefined` — ошибка не неответ за срок (обрыв канала, отказ агента): восстановление не требуется. */
export function decideAgentHangRecovery(error: unknown, context: AgentHangRecoveryContext): AgentHangRecoveryDecision | undefined {
  if (!(error instanceof AgentConnectionLostError) || error.lossKind !== 'no-response') {
    return undefined;
  }
  if (context.location === 'remote') {
    return {
      restartOwnProcess: false,
      text: `Агент конфигуратора на сервере перестал отвечать на команду «${error.commandVerb}» за отведённый срок. ` +
        'Соединение сброшено; перезапустите агента на сервере (1cv8 /AgentMode) и повторите операцию.',
    };
  }
  if (!context.ownsProcess) {
    return { restartOwnProcess: false, text: error.operatorText };
  }
  return {
    restartOwnProcess: true,
    text: `Агент конфигуратора перестал отвечать на команду «${error.commandVerb}» за отведённый срок. Соединение ` +
      'закрыто, процесс агента остановлен и будет запущен заново при следующей операции — повторите её.',
  };
}
