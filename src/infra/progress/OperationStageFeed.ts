/**
 * Лента этапов идущей операции с конфигурацией: последний опубликованный этап (заголовок + строка
 * прогресса). Читают её пульс долгих MCP-вызовов (`infra/mcp/McpRequestPulse`) и
 * `v8vscedit_repository_status` — агенту нужно видеть, ЧТО делает операция, а не только «занято».
 *
 * Источник этапов — статус-бары операций (`ui/commands/ext/configurationOperationStatus`,
 * `ui/commands/repository/repositoryStatusBar`): через них уже идёт весь прогресс раннеров, поэтому
 * второй канал публикации заводить не нужно. Единственный экземпляр живёт в
 * `configurationOperationStatus.ts`; здесь — только чистая механика без vscode.
 */

export type OperationStagePhase = 'begin' | 'update' | 'end';

export interface OperationStage {
  readonly title: string;
  readonly stage: string;
  readonly phase: OperationStagePhase;
  /** Момент публикации (мс epoch): отличает этап текущей операции от остатка прошлой. */
  readonly at: number;
}

/** Предел длины этапа: строка уходит в уведомления MCP каждые 20 с, полный вывод платформы там не нужен. */
export const MAX_STAGE_LENGTH = 200;

/** Одна строка без повторных пробелов: вывод Конфигуратора приходит с CRLF и выравниванием. */
function toOneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateStage(text: string): string {
  // Нормализация — до обрезки, иначе пробелы съели бы лимит.
  return text.length <= MAX_STAGE_LENGTH ? text : `${text.slice(0, MAX_STAGE_LENGTH - 1)}…`;
}

export class OperationStageFeed {
  private last: OperationStage | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  publish(phase: OperationStagePhase, title: string, stage: string): void {
    this.last = { title: toOneLine(title), stage: truncateStage(toOneLine(stage)), phase, at: this.now() };
  }

  current(): OperationStage | undefined {
    return this.last;
  }
}

export interface RunningOperationView {
  readonly operationRunning: boolean;
  readonly currentOperation: null | {
    startedAt: string;
    elapsedSeconds: number;
    title?: string;
    stage?: string;
    stageUpdatedAt?: string;
  };
}

/**
 * Вид идущей операции для статуса. Этап старше момента старта — остаток прошлой операции (лента
 * не очищается по завершении), его показ ввёл бы агента в заблуждение. Без момента старта
 * (замок взят не через `tryBegin`) длительность неизвестна — `currentOperation: null`.
 */
export function describeRunningOperation(input: {
  running: boolean;
  startedAt?: number;
  stage?: OperationStage;
  now: number;
}): RunningOperationView {
  if (!input.running) {
    return { operationRunning: false, currentOperation: null };
  }
  if (input.startedAt === undefined) {
    return { operationRunning: true, currentOperation: null };
  }
  const base = {
    startedAt: new Date(input.startedAt).toISOString(),
    elapsedSeconds: Math.max(0, Math.floor((input.now - input.startedAt) / 1000)),
  };
  const stage = input.stage;
  if (!stage || stage.at < input.startedAt) {
    return { operationRunning: true, currentOperation: base };
  }
  return {
    operationRunning: true,
    currentOperation: { ...base, title: stage.title, stage: stage.stage, stageUpdatedAt: new Date(stage.at).toISOString() },
  };
}
