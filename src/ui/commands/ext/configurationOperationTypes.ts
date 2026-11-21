// Перенесено из ExtensionCommandRunner.ts (Э2) без изменения поведения; публичный API реэкспортируется оттуда.

export interface ConfigurationProgressHooks {
  readonly onProgressMessage?: (message: string) => void;
}

export interface ConfigurationImportHooks extends ConfigurationProgressHooks {
  readonly beforeProjectFilesChanged?: (filePaths: string[]) => void;
}

/**
 * Кто отвечает на вопросы операции. interactive — человек (UI: модальные вопросы, тосты); unattended — никто
 * (MCP): ни окон, ни тостов, вопрос, требующий человека, — отказ с инструкцией выполнить операцию из UI.
 */
export type OperationInteraction = 'interactive' | 'unattended';

/** Исход импорта одной цели (для MCP и общего раннера импорта). */
export interface ConfigurationImportOutcome {
  readonly success: boolean;
  /** Причина отказа (текст агента/CLI или инструкция unattended). */
  readonly reason?: string;
  /** Отмена/отказ до изменения проекта (кнопка «Отмена», отказ от полной выгрузки). */
  readonly cancelled?: boolean;
  /** Отказ unattended: операции нужен человек (полная выгрузка, вопрос агента). */
  readonly requiresUserAction?: boolean;
  readonly warnings: readonly string[];
}

export interface ConfigurationImportOptions {
  readonly interaction: OperationInteraction;
  /** Вызывается ровно один раз и при успехе, и при отказе (кроме исключения — его ловит вызывающий). */
  readonly onOutcome?: (outcome: ConfigurationImportOutcome) => void;
}
