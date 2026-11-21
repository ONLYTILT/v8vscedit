import type { AgentMessage } from '../../../../domain/agent';
import type { AgentFullDumpRequest, AgentOperationHooks } from '../../../../infra/agent';
import { agentQuestionText } from './agentQuestionJournal';

/**
 * Хуки согласия агентской операции, когда отвечать некому (MCP). Отсутствие хука в infra означает разное:
 * у `confirmFullDump` — СОГЛАСИЕ (молчаливая полная выгрузка на десятки минут), у `onQuestion` — вечное
 * ожидание агента. Поэтому здесь не «нет хука», а явный отказ, и всё отклонённое записывается в журнал
 * операции: из него строится причина отказа для вызывающего агента.
 */

/** Ответ на вопрос агента без человека — как кнопка «Отмена» в `showAgentQuestion`. */
export const UNATTENDED_QUESTION_ANSWER = 'cancel';

/** Что произошло с вопросами за операцию unattended: из этого строится причина отказа и предупреждения. */
export interface UnattendedInteractionLog {
  /** Последний отклонённый запрос полной выгрузки. */
  fullDumpRequest?: AgentFullDumpRequest;
  /** Первые строки вопросов агента. */
  readonly questions: string[];
}

export interface UnattendedAgentHooks {
  readonly confirmFullDump: NonNullable<AgentOperationHooks['confirmFullDump']>;
  readonly onQuestion: (message: AgentMessage) => Promise<string>;
  readonly log: UnattendedInteractionLog;
}

/** `report` — строка журнала операции: тема вопроса и данный ответ (без ответа-секрета: его нет). */
export function createUnattendedAgentHooks(report: (line: string) => void): UnattendedAgentHooks {
  const log: UnattendedInteractionLog = { questions: [] };
  return {
    log,
    confirmFullDump: (request) => {
      log.fullDumpRequest = request;
      report(`Вызов без участия человека: полная выгрузка на сервере (${request.reasonText}); ответ: отказ`);
      return Promise.resolve('cancel');
    },
    onQuestion: (message) => {
      const topic = agentQuestionText(message).split(/\r?\n/)[0];
      log.questions.push(topic);
      report(`Вызов без участия человека: вопрос агента «${topic}»; ответ: «Отмена»`);
      return Promise.resolve(UNATTENDED_QUESTION_ANSWER);
    },
  };
}

export function describeUnattendedFullDumpRefusal(request: AgentFullDumpRequest): string {
  const name = request.targetName;
  if (request.operation === 'load') {
    return `Загрузка «${name}» требует выгрузки конфигурации на сервере для подготовки зеркала агента: ${request.reasonText}. ` +
      'Без подтверждения человека она не запускается. Выполните загрузку из интерфейса VS Code («Обновить в базе») и ' +
      'подтвердите выгрузку. База и проект не изменены.';
  }
  if (request.download) {
    return `Импорт «${name}» требует полной выгрузки конфигурации на сервере: ${request.reasonText}. Без подтверждения ` +
      'человека она не запускается (для большой конфигурации — десятки минут и сотни мегабайт). Выполните импорт из ' +
      'интерфейса VS Code (команда «Импортировать конфигурации из базы») и подтвердите выгрузку. Проект не изменён.';
  }
  return `Импорт «${name}» требует перезаписи зеркала агента выгрузкой на сервере: ${request.reasonText}. Без ` +
    'подтверждения человека она не запускается. Выполните импорт из интерфейса VS Code и подтвердите выгрузку. ' +
    'Проект не изменён.';
}

export function describeUnattendedQuestion(question: string): string {
  return `Агент конфигуратора запросил ответ («${question}»), а вызов идёт без участия человека: дан ответ «Отмена».`;
}

/**
 * Причина отказа unattended. Отклонённая полная выгрузка — сама причина (текст ошибки infra написан для
 * человека с кнопкой). Иначе отказ после вопроса агента, скорее всего, вызван ответом «Отмена» — вопрос
 * ставится впереди текста ошибки; последний вопрос — ближайший к отказу.
 */
export function resolveUnattendedFailure(
  log: UnattendedInteractionLog,
  fallbackReason: string
): { readonly reason: string; readonly requiresUserAction: boolean } {
  if (log.fullDumpRequest) {
    return { reason: describeUnattendedFullDumpRefusal(log.fullDumpRequest), requiresUserAction: true };
  }
  const lastQuestion = log.questions.at(-1);
  if (lastQuestion !== undefined) {
    return {
      reason: `${describeUnattendedQuestion(lastQuestion)} Выполните операцию из интерфейса VS Code. ${fallbackReason}`,
      requiresUserAction: true,
    };
  }
  return { reason: fallbackReason, requiresUserAction: false };
}

/** Предупреждения успешной операции, в ходе которой агент задавал вопросы (ответ «Отмена»). */
export function unattendedWarnings(log: UnattendedInteractionLog): string[] {
  return log.questions.map(describeUnattendedQuestion);
}
