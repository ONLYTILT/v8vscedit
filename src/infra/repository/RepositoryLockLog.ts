/**
 * Разбор лога `/ConfigurationRepositoryLock` (Н10); признак изменения базы (`hasReceivedFromRepository`)
 * читает и лог `/ConfigurationRepositoryUpdateCfg` — формат строк общий.
 *
 * Пилот 8.3.27.2130: частичный захват — УСПЕХ платформы (exit 0), несуществующие объекты
 * перечисляются отдельной строкой, остальные захватываются. Помечать захваченными все
 * запрошенные объекты значило бы показывать в локальном учёте захват, которого в хранилище нет,
 * поэтому отметки ставятся по строкам лога. Лог другой формы (другая версия платформы, пустой
 * лог) — прежнее поведение: помечаются все, чтобы не было регресса там, где формат не снят.
 *
 * Тем же принципом учёт ведётся после освобождения (`/ConfigurationRepositoryUnLock`, Э24) и
 * помещения (`/ConfigurationRepositoryCommit`, Э25): exit 0 не говорит, что именно сделано.
 */

/** Объект, захваченный в хранилище другим пользователем (строка лога освобождения, Э24). */
export interface LockedByOther {
  readonly name: string;
  readonly user: string;
}

export interface RepositoryLockLogResult {
  readonly locked: string[];
  readonly cancelled: string[];
  readonly absent: string[];
  readonly lockedByOthers: LockedByOther[];
  /** В логе была хотя бы одна из распознаваемых форм строк. */
  readonly recognized: boolean;
}

const OPERATION_BEGIN_MARKER = '---- Начало операции';
const LOCKED_PREFIX = 'Объект захвачен для редактирования:';
const CANCELLED_PREFIX = 'Захват объекта отменен:';
const ABSENT_PREFIX = 'Объекты, отсутствующие в обеих конфигурациях:';
/**
 * Э24: освобождение чужого захвата — exit 0 без снятия, единственный след — эта строка. С `LOCKED_PREFIX`
 * не пересекается: там двоеточие сразу после «редактирования».
 */
const FOREIGN_LOCK_PREFIX = 'Объект захвачен для редактирования другим пользователем:';
const RECOGNIZED_PREFIXES = [LOCKED_PREFIX, CANCELLED_PREFIX, ABSENT_PREFIX, FOREIGN_LOCK_PREFIX];
/** Хвост строки чужого захвата: `<имя> (<пользователь>)`; в имени объекта платформы скобок нет. */
const FOREIGN_LOCK_TAIL = /^(.*?)\s*\((.*)\)$/;
/** Полное имя объекта платформы: вид и имя через точку (`Справочник.Товары`). */
const OBJECT_FULL_NAME = /^[^.\s]+\.[^.\s]/;

export function parseRepositoryLockLog(log: string): RepositoryLockLogResult {
  const locked: string[] = [];
  const cancelled: string[] = [];
  const absent: string[] = [];
  const lockedByOthers: LockedByOther[] = [];
  let recognized = false;
  for (const line of splitLines(log)) {
    recognized ||= RECOGNIZED_PREFIXES.some((prefix) => line.startsWith(prefix));
    if (line.startsWith(FOREIGN_LOCK_PREFIX)) {
      lockedByOthers.push(parseForeignLock(line.slice(FOREIGN_LOCK_PREFIX.length).trim()));
    } else if (line.startsWith(LOCKED_PREFIX)) {
      locked.push(line.slice(LOCKED_PREFIX.length).trim());
    } else if (line.startsWith(CANCELLED_PREFIX)) {
      cancelled.push(line.slice(CANCELLED_PREFIX.length).trim());
    } else if (line.startsWith(ABSENT_PREFIX)) {
      absent.push(...line.slice(ABSENT_PREFIX.length).split(',').map((name) => name.trim()).filter(Boolean));
    }
  }
  return { locked, cancelled, absent, lockedByOthers, recognized };
}

function parseForeignLock(tail: string): LockedByOther {
  const match = FOREIGN_LOCK_TAIL.exec(tail);
  // Строка без «(пользователь)» не должна ломать разбор: объект всё равно не освобождён.
  return match ? { name: match[1], user: match[2] } : { name: tail, user: '' };
}

/** Какие из запрошенных объектов помечать захваченными (порядок — как в `fullNames`). */
export function resolveLockedFullNames(fullNames: readonly string[], log: string): string[] {
  const parsed = parseRepositoryLockLog(log);
  if (!parsed.recognized) {
    return [...fullNames];
  }
  const locked = new Set(parsed.locked.map(toKey));
  // Фильтруются только имена объектов вида «Тип.Имя». Служебное имя корня (`__configuration_root__`)
  // в логе не встречается никогда: отбросив его, учёт потерял бы захват корня и запретил бы создание
  // корневых объектов. Корень захватывается целиком, и успех операции — его единственный признак.
  return fullNames.filter((name) => !OBJECT_FULL_NAME.test(name) || locked.has(toKey(name)));
}

/**
 * С какими объектами снимать локальный учёт после `/ConfigurationRepositoryUnLock` (Э24). Освобождение
 * чужого захвата — exit 0 без снятия, поэтому учёт — по строкам «Захват объекта отменен»: из
 * запрошенных (в их написании — по нему `setLocked` удаляет учёт) и вне их (рекурсия подчинённых).
 * Служебное имя корня в логе не встречается — сохраняется, как при захвате. Лог другой формы —
 * прежнее поведение: снимаются все запрошенные.
 */
export function resolveUnlockedFullNames(fullNames: readonly string[], log: string): string[] {
  const parsed = parseRepositoryLockLog(log);
  if (!isUnlockLogRecognized(log)) {
    return [...fullNames];
  }
  const requested = new Set(fullNames.map(toKey));
  const cancelled = new Set(parsed.cancelled.map(toKey));
  const fromRequest = fullNames.filter((name) => !OBJECT_FULL_NAME.test(name) || cancelled.has(toKey(name)));
  const outside = parsed.cancelled.filter((name) => !requested.has(toKey(name)));
  return [...fromRequest, ...outside];
}

/**
 * Лог освобождения той формы, что снята Э24: есть объектные строки или хотя бы маркер начала операции.
 * Маркер без строк «отменен» — тоже ответ платформы («ничего не освобождено»), а не чужой формат.
 */
export function isUnlockLogRecognized(log: string): boolean {
  return parseRepositoryLockLog(log).recognized || splitLines(log).some((line) => line.startsWith(OPERATION_BEGIN_MARKER));
}

function toKey(name: string): string {
  return name.toLocaleLowerCase('ru');
}

export interface RepositoryCommitLogResult {
  readonly committed: string[];
  readonly unchanged: string[];
  /** Есть маркер начала операции: лог той формы, что снята экспериментом Э25. */
  readonly recognized: boolean;
}

const COMMITTED_PREFIX = 'Объект помещен в хранилище:';
const UNCHANGED_PREFIX = 'Объект не был изменен:';
const REFERENCES_CLEANED_PREFIX = 'Очистка объектов от некорректных ссылок выполнена';

/** Разбор лога `/ConfigurationRepositoryCommit` (Э25): помещённые и не изменённые объекты. */
export function parseRepositoryCommitLog(log: string): RepositoryCommitLogResult {
  const lines = splitLines(log);
  return {
    committed: valuesAfter(lines, COMMITTED_PREFIX),
    unchanged: valuesAfter(lines, UNCHANGED_PREFIX),
    recognized: lines.some((line) => line.startsWith(OPERATION_BEGIN_MARKER)),
  };
}

/**
 * Что помещено. Exit 0 ещё не значит «что-то помещено»: помещение без правок — тоже успех платформы
 * (Э25). Нераспознанный лог — консервативно все запрошенные, как у захвата.
 */
export function resolveCommittedFullNames(fullNames: readonly string[], log: string): string[] {
  const parsed = parseRepositoryCommitLog(log);
  return parsed.recognized ? parsed.committed : [...fullNames];
}

/**
 * `-force` помещения чистит ссылки на удалённые объекты и этим меняет базу помещающего (Э25):
 * проект после такого помещения отстаёт от базы, нужен импорт.
 */
export function hasReferencesCleaned(log: string): boolean {
  return splitLines(log).some((line) => line.startsWith(REFERENCES_CLEANED_PREFIX));
}

function splitLines(log: string): string[] {
  return log.split(/\r?\n/).map((line) => line.trim());
}

function valuesAfter(lines: readonly string[], prefix: string): string[] {
  return lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).trim());
}

/**
 * Строки, которыми платформа сообщает об изменении основной конфигурации базы операцией хранилища.
 * Удаление — отдельная строка (эксперимент Э16): при получении поддерева без корня она может
 * оказаться единственной, и без неё файлы удалённого объекта остались бы в проекте.
 */
const BASE_CHANGED_PREFIXES = ['Объект получен из хранилища:', 'Объект удален из конфигурации:'];

/**
 * Изменила ли операция хранилища основную конфигурацию базы — захват (`/ConfigurationRepositoryLock`,
 * Э14: версия получается и БЕЗ `-revised`) или получение (`/ConfigurationRepositoryUpdateCfg`, тот же
 * формат строк). Лог не распознан (нет маркера начала операции) — `true`: лишний импорт дешевле
 * проекта, молча отстающего от базы.
 */
export function hasReceivedFromRepository(log: string): boolean {
  const lines = splitLines(log);
  if (!lines.some((line) => line.startsWith(OPERATION_BEGIN_MARKER))) {
    return true;
  }
  return lines.some((line) => BASE_CHANGED_PREFIXES.some((prefix) => line.startsWith(prefix)));
}
