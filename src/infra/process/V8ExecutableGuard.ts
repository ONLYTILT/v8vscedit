/**
 * Единая классификация исполняемого файла платформы 1С. Её вызывают обе точки, через которые
 * проходит любой путь к 1cv8: `resolveV8ExecutablePath` (локально) и `resolveServerV8Path`
 * (удалённо), а также проверка подключения. Третьей точки резолвинга заводить нельзя.
 */

export type V8ExecutableKind = 'designer' | 'starter' | 'other';

const DESIGNER_NAMES = new Set(['1cv8.exe', '1cv8']);
const STARTER_NAMES = new Set(['1cestart.exe', '1cestart']);

/**
 * Имя файла без учёта регистра: Windows-пути регистронезависимы, а пользователь мог написать
 * `1CEStart.exe`. Разделители `\` и `/` — путь может быть серверным Windows-путём на любой ОС,
 * поэтому `path.basename` текущей ОС здесь не годится. Кавычки снимает вызывающий.
 */
export function classifyV8Executable(filePath: string): V8ExecutableKind {
  const name = baseName(filePath).toLowerCase();
  if (DESIGNER_NAMES.has(name)) {
    return 'designer';
  }
  if (STARTER_NAMES.has(name)) {
    return 'starter';
  }
  return 'other';
}

export class OnecStarterExecutableError extends Error {
  constructor(readonly executablePath: string, readonly source: string) {
    super(
      `${source} указывает на стартер 1cestart.exe (${executablePath}). Стартер запускает 1cv8 и сразу ` +
      'завершается: пакетная операция «завершилась» бы раньше реального окончания, без лога, а база осталась ' +
      'бы заблокированной («Ошибка блокировки информационной базы для конфигурирования»). Укажите 1cv8.exe ' +
      'конкретной версии, например C:\\Program Files\\1cv8\\8.3.27.2130\\bin\\1cv8.exe.'
    );
    this.name = 'OnecStarterExecutableError';
  }
}

/** Бросает OnecStarterExecutableError для стартера; прочие файлы не проверяет. */
export function assertNotOnecStarter(filePath: string, source: string): void {
  if (classifyV8Executable(filePath) === 'starter') {
    throw new OnecStarterExecutableError(filePath, source);
  }
}

/**
 * Удалённый сервер — Windows, и исполнитель запускает именно Конфигуратор: тонкий клиент
 * (`1cv8c.exe`) или Unix-файл без расширения пакетный режим не выполнят.
 */
export function assertServerDesignerExecutable(filePath: string, source: string): void {
  assertNotOnecStarter(filePath, source);
  if (baseName(filePath).toLowerCase() !== '1cv8.exe') {
    throw new Error(`${source} указывает не 1cv8.exe (${filePath}). На сервере нужен 1cv8.exe конкретной версии платформы.`);
  }
}

function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1];
}
