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
  /** «Объект не захвачен для редактирования:» — освобождать нечего (рекурсивное освобождение корня, Э33.(б)). */
  readonly notLockedByYou: string[];
  /**
   * «Объект '<имя>' был изменен» — отказ освобождения без `-force` (Э33.3): список освобождается целиком или
   * никак. Строка отказа, а не учёта, поэтому в распознаваемые формы не входит.
   */
  readonly changedInDatabase: string[];
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
/** С `LOCKED_PREFIX` не пересекается: начинается с «Объект не». */
const NOT_LOCKED_BY_YOU_PREFIX = 'Объект не захвачен для редактирования:';
const RECOGNIZED_PREFIXES = [LOCKED_PREFIX, CANCELLED_PREFIX, ABSENT_PREFIX, FOREIGN_LOCK_PREFIX, NOT_LOCKED_BY_YOU_PREFIX];
const CHANGED_IN_DATABASE = /^Объект '(.+)' был изменен/;
/** Хвост строки чужого захвата: `<имя> (<пользователь>)`; в имени объекта платформы скобок нет. */
const FOREIGN_LOCK_TAIL = /^(.*?)\s*\((.*)\)$/;
/** Полное имя объекта платформы: вид и имя через точку (`Справочник.Товары`). */
const OBJECT_FULL_NAME = /^[^.\s]+\.[^.\s]/;

export function parseRepositoryLockLog(log: string): RepositoryLockLogResult {
  const locked: string[] = [];
  const cancelled: string[] = [];
  const absent: string[] = [];
  const lockedByOthers: LockedByOther[] = [];
  const notLockedByYou: string[] = [];
  const changedInDatabase: string[] = [];
  let recognized = false;
  for (const line of splitLines(log)) {
    recognized ||= RECOGNIZED_PREFIXES.some((prefix) => line.startsWith(prefix));
    const changed = CHANGED_IN_DATABASE.exec(line);
    if (changed) {
      changedInDatabase.push(changed[1]);
    } else if (line.startsWith(NOT_LOCKED_BY_YOU_PREFIX)) {
      notLockedByYou.push(line.slice(NOT_LOCKED_BY_YOU_PREFIX.length).trim());
    } else if (line.startsWith(FOREIGN_LOCK_PREFIX)) {
      lockedByOthers.push(parseForeignLock(line.slice(FOREIGN_LOCK_PREFIX.length).trim()));
    } else if (line.startsWith(LOCKED_PREFIX)) {
      locked.push(line.slice(LOCKED_PREFIX.length).trim());
    } else if (line.startsWith(CANCELLED_PREFIX)) {
      cancelled.push(line.slice(CANCELLED_PREFIX.length).trim());
    } else if (line.startsWith(ABSENT_PREFIX)) {
      absent.push(...line.slice(ABSENT_PREFIX.length).split(',').map((name) => name.trim()).filter(Boolean));
    }
  }
  return { locked, cancelled, absent, lockedByOthers, notLockedByYou, changedInDatabase, recognized };
}

function parseForeignLock(tail: string): LockedByOther {
  const match = FOREIGN_LOCK_TAIL.exec(tail);
  // Строка без «(пользователь)» не должна ломать разбор: объект всё равно не освобождён.
  return match ? { name: match[1], user: match[2] } : { name: tail, user: '' };
}

/**
 * Какие из запрошенных объектов помечать захваченными (порядок — как в `fullNames`). Повторный захват своего
 * объекта строки не пишет (Э33.(а)), поэтому объект из учёта до операции (`alreadyLocked`) остаётся захваченным,
 * если лог не называет его чужим или отсутствующим. Правило одно для exit 0 и exit≠0: неудачный захват своего
 * захвата не снимает. Захват мимо учёта (интерактивный Конфигуратор) без строки не подтверждается — лишнее
 * предупреждение лучше учёта захвата, которого нет.
 */
export function resolveLockedFullNames(
  fullNames: readonly string[],
  log: string,
  alreadyLocked: readonly string[] = []
): string[] {
  const parsed = parseRepositoryLockLog(log);
  if (!parsed.recognized) {
    return [...fullNames];
  }
  const locked = new Set(parsed.locked.map(toKey));
  const denied = new Set([...parsed.lockedByOthers.map((item) => item.name), ...parsed.absent].map(toKey));
  const before = new Set(alreadyLocked.map(toKey));
  // Фильтруются только имена объектов вида «Тип.Имя». Служебное имя корня (`__configuration_root__`)
  // в логе не встречается никогда: отбросив его, учёт потерял бы захват корня и запретил бы создание
  // корневых объектов. Корень захватывается целиком, и успех операции — его единственный признак.
  return fullNames.filter((name) => {
    const key = toKey(name);
    return !OBJECT_FULL_NAME.test(name) || locked.has(key) || (before.has(key) && !denied.has(key));
  });
}

/**
 * С какими объектами снимать локальный учёт после `/ConfigurationRepositoryUnLock` (Э24). Освобождение
 * чужого захвата — exit 0 без снятия, поэтому учёт — по строкам «Захват объекта отменен»: из
 * запрошенных (в их написании — по нему `setLocked` удаляет учёт) и вне их (рекурсия подчинённых).
 * Рекурсивное освобождение корня пишет «отменен» по ВСЕМ объектам выборки, а следом «не захвачен» и «чужой»
 * (Э33.(б)) — такие объекты освобождёнными не считаются. Служебное имя корня в логе не встречается —
 * сохраняется, как при захвате. Лог другой формы — прежнее поведение: снимаются все запрошенные.
 */
export function resolveUnlockedFullNames(fullNames: readonly string[], log: string): string[] {
  const parsed = parseRepositoryLockLog(log);
  if (!isUnlockLogRecognized(log)) {
    return [...fullNames];
  }
  const requested = new Set(fullNames.map(toKey));
  const excluded = new Set([...parsed.notLockedByYou, ...parsed.lockedByOthers.map((item) => item.name)].map(toKey));
  const released = parsed.cancelled.filter((name) => !excluded.has(toKey(name)));
  const releasedKeys = new Set(released.map(toKey));
  const fromRequest = fullNames.filter((name) => !OBJECT_FULL_NAME.test(name) || releasedKeys.has(toKey(name)));
  const outside = released.filter((name) => !requested.has(toKey(name)));
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
 * Запрошенные объекты, которые помещение пропустило: незахваченный и чужой объект платформа пропускает МОЛЧА,
 * с exit 0 (Э33.4б/в). Нераспознанный лог — `[]`, согласованно с «консервативно всё помещено». Служебное имя
 * корня в логе не встречается и в результат не попадает никогда.
 */
export function resolveNotCommittedFullNames(fullNames: readonly string[], log: string): string[] {
  const parsed = parseRepositoryCommitLog(log);
  if (!parsed.recognized) {
    return [];
  }
  const named = new Set([...parsed.committed, ...parsed.unchanged].map(toKey));
  return fullNames.filter((name) => OBJECT_FULL_NAME.test(name) && !named.has(toKey(name)));
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

/**
 * Какие из захваченных вами объектов выборки получение реально перезаписало. «Получен» пишется и для перезаписи
 * захваченного без новой версии в хранилище, а незатронутый объект не упоминается (Э33.6) — поэтому решает
 * строка лога о самом объекте или его подобъекте. Служебное имя корня в логе не встречается: корень считается
 * затронутым, если затронуто хоть что-то. Лог без маркера начала операции — консервативно все захваченные,
 * как у `hasReceivedFromRepository`.
 */
export function resolveOverwrittenLocked(locked: readonly string[], log: string): string[] {
  const lines = splitLines(log);
  if (!lines.some((line) => line.startsWith(OPERATION_BEGIN_MARKER))) {
    return [...locked];
  }
  const touched = lines.flatMap((line) => {
    const prefix = BASE_CHANGED_PREFIXES.find((item) => line.startsWith(item));
    return prefix ? [toKey(line.slice(prefix.length).trim())] : [];
  });
  return locked.filter((name) => {
    if (!OBJECT_FULL_NAME.test(name)) {
      return touched.length > 0;
    }
    const key = toKey(name);
    return touched.some((item) => item === key || item.startsWith(`${key}.`));
  });
}
