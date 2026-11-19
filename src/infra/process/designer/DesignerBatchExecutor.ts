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

/** Имя лога `/Out` в рабочем каталоге запуска (локальном или на сервере). */
export const DESIGNER_LOG_FILE_NAME = 'out.log';

/**
 * Имя файла в запросе — простое имя внутри рабочего каталога. Разделители, `..` и
 * абсолютные пути позволили бы запросу писать (или забирать) файлы вне каталога
 * запуска, а совпадение имён — молча перетереть один файл другим или лог `/Out`.
 * Общая проверка всех исполнителей: локальный и удалённый отказывают одинаково и ДО
 * любых побочных эффектов.
 */
export function validateDesignerFileNames(args: readonly DesignerArg[]): void {
  const seen = new Set<string>([DESIGNER_LOG_FILE_NAME]);
  for (const arg of args) {
    if (typeof arg === 'string') {
      continue;
    }
    const name = arg.name;
    if (!name || name === '.' || name === '..' || /[\\/:]/.test(name)) {
      throw new Error(`Недопустимое имя файла пакетного конфигуратора: "${name}". Ожидается простое имя файла.`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Имя файла пакетного конфигуратора "${name}" повторяется или занято логом /Out.`);
    }
    seen.add(key);
  }
}
