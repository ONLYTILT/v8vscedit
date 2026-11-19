/**
 * Разбор `agentbasedir.json` — индекса персональных каталогов агента конфигуратора.
 *
 * Агент при первом SSH-входе пользователя заводит ему подкаталог `<AgentBaseDir>/<dir>`
 * и дописывает пару «имя → dir» в этот файл. Корень SFTP пользователя — именно этот
 * подкаталог, поэтому при локальном агенте расширение обязано вычислять тот же путь,
 * а не угадывать (прежний хардкод `'0'` верен только для первого вошедшего).
 *
 * Модуль чистый: ни `fs`, ни `path` — только текст на входе.
 */

/** Корректная запись индекса: `dir` — безопасный одиночный сегмент пути. */
export interface AgentUserDir {
  readonly name: string;
  readonly dir: string;
}

/**
 * Запись с непригодным `dir`. Файл общий для всех пользователей агента, поэтому порча
 * чужой записи не должна ломать работу остальным: ошибка всплывает только у того,
 * чья запись испорчена, — в {@link resolveAgentUserDir}.
 */
export interface InvalidAgentUserDir {
  readonly name: string;
  readonly error: string;
}

export type AgentUserDirEntry = AgentUserDir | InvalidAgentUserDir;

const INDEX_FILE = 'agentbasedir.json';
/** UTF-8 BOM: агент на Windows может записать индекс с ним. */
const BOM_CODE = 0xfeff;

/**
 * Разбирает текст индекса. Файл целиком невалиден (битый JSON, нет массива `usersInfo`) —
 * исключение: тогда неизвестен ни один персональный каталог. Отдельная запись без имени
 * пропускается (её нельзя ни запросить, ни приписать кому-либо), запись с плохим `dir`
 * сохраняется как {@link InvalidAgentUserDir}.
 */
export function parseAgentBaseDirIndex(jsonText: string): AgentUserDirEntry[] {
  const text = jsonText.charCodeAt(0) === BOM_CODE ? jsonText.slice(1) : jsonText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // JSON.parse отказывает только SyntaxError.
    throw new Error(`Файл ${INDEX_FILE} агента конфигуратора повреждён: ${(error as Error).message}`, { cause: error });
  }
  const usersInfo = isRecord(parsed) ? parsed.usersInfo : undefined;
  if (!Array.isArray(usersInfo)) {
    throw new Error(`Файл ${INDEX_FILE} агента конфигуратора не содержит массива usersInfo.`);
  }

  const result: AgentUserDirEntry[] = [];
  for (const entry of usersInfo as unknown[]) {
    const name = isRecord(entry) ? entry.name : undefined;
    if (typeof name !== 'string' || !name.trim()) {
      continue;
    }
    const dir = (entry as Record<string, unknown>).dir;
    const error = validateDirSegment(dir);
    result.push(error === undefined ? { name, dir: dir as string } : { name, error });
  }
  return result;
}

/**
 * Персональный каталог пользователя (`dir`) или `undefined`, если его нет в индексе.
 * Имена сравниваются без учёта регистра и пробелов по краям (логин 1С регистронезависим).
 * При нескольких совпадениях берётся первая запись: как поступает сам агент, не проверено
 * (в образце индекса дублей нет) — правило выбрано как детерминированное и предсказуемое.
 */
export function resolveAgentUserDir(index: readonly AgentUserDirEntry[], userName: string): string | undefined {
  const wanted = userName.trim().toLocaleLowerCase('ru');
  if (!wanted) {
    return undefined;
  }
  const entry = index.find((item) => item.name.trim().toLocaleLowerCase('ru') === wanted);
  if (!entry) {
    return undefined;
  }
  if ('error' in entry) {
    throw new Error(`Некорректная запись пользователя "${entry.name}" в ${INDEX_FILE}: dir ${entry.error}.`);
  }
  return entry.dir;
}

/** Причина непригодности `dir` или `undefined` для безопасного одиночного сегмента. */
function validateDirSegment(dir: unknown): string | undefined {
  if (typeof dir !== 'string') {
    return 'не задан строкой';
  }
  if (!dir.trim() || dir.trim() !== dir) {
    return `пуст или окружён пробелами (${JSON.stringify(dir)})`;
  }
  // Управляющие символы (включая NUL) недопустимы в именах файлов и обрывают путь в API ОС.
  // eslint-disable-next-line no-control-regex
  if (dir === '.' || dir === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(dir)) {
    return `не является одиночным безопасным сегментом пути (${JSON.stringify(dir)})`;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
