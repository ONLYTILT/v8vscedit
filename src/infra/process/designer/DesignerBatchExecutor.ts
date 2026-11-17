import type { CancellationLike } from '../ProcessRunner';

/**
 * Элемент вектора пакетного конфигуратора.
 *
 * Файлы объявляются ИМЕНЕМ, а не путём: где они окажутся (локальный временный
 * каталог или каталог на удалённом сервере), решает исполнитель. Так один и тот же
 * запрос можно исполнить и локально, и через удалённый хост, не пересобирая вектор.
 */
export type DesignerArg =
  | string
  | { readonly kind: 'inputFile'; readonly name: string; readonly content: string | Uint8Array }
  | { readonly kind: 'outputFile'; readonly name: string };

export interface DesignerBatchRequest {
  /** Вектор БЕЗ исполняемого файла и БЕЗ `/Out`/`/DisableStartupDialogs` — их добавляет исполнитель. */
  readonly args: readonly DesignerArg[];
  /** Значения для маскирования в журнале. */
  readonly secrets: readonly string[];
  readonly cancellation?: CancellationLike;
  readonly onOutput?: (line: string) => void;
}

export interface DesignerBatchResult {
  readonly exitCode: number;
  /** Нейтральное описание штатного прерывания (отмена/таймаут); нет — прерывания не было. */
  readonly interrupted?: string;
  /** Декодированный лог `/Out`; пустая строка, если лога нет. */
  readonly log: string;
  /** Имя выходного файла → ЛОКАЛЬНЫЙ staging-путь; только для файлов, которые процесс создал. */
  readonly outputs: ReadonlyMap<string, string>;
}

/**
 * Строковое представление вектора для журнала: файлы показываются именем в угловых
 * скобках. Реальный путь знает только исполнитель, а содержимое входного файла в
 * журнал не попадает.
 */
export function describeDesignerArgs(args: readonly DesignerArg[]): string[] {
  return args.map((arg) => (typeof arg === 'string' ? arg : `<${arg.name}>`));
}

export interface DesignerBatchExecutor {
  run(request: DesignerBatchRequest): Promise<DesignerBatchResult>;
  /** Освобождает ресурсы исполнителя, включая не забранные staging-файлы. */
  dispose(): Promise<void>;
}
