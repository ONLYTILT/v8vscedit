import type { AgentMessage } from '../../../../domain/agent';
import type {
  AgentFullDumpRequest,
  AgentMirrorSeedRequest,
  AgentOperationHooks,
  AgentOrphanFilesRequest,
} from '../../../../infra/agent';

/**
 * Строки «Ожидание ответа пользователя: …» / «Ответ пользователя: …» вокруг каждого вопроса агентской
 * операции. Без них журнал и уведомление замирают на последнем этапе, пока модальный диалог ждёт человека,
 * и операция выглядит зависшей. Обёртка — здесь, а не в infra: сюда сходятся все четыре источника вопросов,
 * включая вопросы транспорта агента, которых контекст синхронизации не видит.
 */

/** Текст вопроса агента — как его показывает диалог. */
export function agentQuestionText(message: AgentMessage): string {
  if (typeof message.message === 'string' && message.message.trim()) {
    return message.message.trim();
  }
  return typeof message.body === 'string' ? message.body : JSON.stringify(message.body ?? message);
}

/** Вопрос о пароле: ответ на него в журнал и уведомление не попадает. */
export function isSecretQuestion(text: string): boolean {
  return /(парол|password)/i.test(text);
}

type QuestionHooks = Pick<AgentOperationHooks, 'confirmMirrorSeed' | 'confirmFullDump' | 'confirmOrphanRemoval'> & {
  readonly onQuestion: (message: AgentMessage) => Promise<string | undefined>;
};

/** Оборачивает заданные хуки вопросов; отсутствующий хук остаётся отсутствующим (у infra своё умолчание). */
export function withQuestionJournal<T extends QuestionHooks>(hooks: T, report: (line: string) => void): T {
  const ask = async <R>(topic: string, run: () => Promise<R>, answerText: (answer: R) => string): Promise<R> => {
    report(`Ожидание ответа пользователя: ${topic}`);
    const answer = await run();
    report(`Ответ пользователя: ${answerText(answer)}`);
    return answer;
  };
  const plain = (answer: string | boolean | undefined): string => (answer === undefined ? 'нет ответа' : String(answer));
  const { confirmMirrorSeed, confirmFullDump, confirmOrphanRemoval, onQuestion } = hooks;
  return {
    ...hooks,
    onQuestion: (message: AgentMessage) => {
      const text = agentQuestionText(message);
      const secret = isSecretQuestion(text);
      return ask(text.split(/\r?\n/)[0], () => onQuestion(message), (answer) => (secret ? 'введён (не показывается)' : plain(answer)));
    },
    confirmMirrorSeed: confirmMirrorSeed && ((request: AgentMirrorSeedRequest) =>
      ask('подготовка зеркала агента', () => confirmMirrorSeed(request), plain)),
    confirmFullDump: confirmFullDump && ((request: AgentFullDumpRequest) =>
      ask(`полная выгрузка на сервере (${request.reasonText})`, () => confirmFullDump(request), plain)),
    confirmOrphanRemoval: confirmOrphanRemoval && ((request: AgentOrphanFilesRequest) =>
      ask(`удаление осиротевших файлов (${String(request.files.length)})`, () => confirmOrphanRemoval(request), plain)),
  };
}
