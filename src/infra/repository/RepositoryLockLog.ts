/**
 * Разбор лога `/ConfigurationRepositoryLock` (Н10).
 *
 * Пилот 8.3.27.2130: частичный захват — УСПЕХ платформы (exit 0), несуществующие объекты
 * перечисляются отдельной строкой, остальные захватываются. Помечать захваченными все
 * запрошенные объекты значило бы показывать в локальном учёте захват, которого в хранилище нет,
 * поэтому отметки ставятся по строкам лога. Лог другой формы (другая версия платформы, пустой
 * лог) — прежнее поведение: помечаются все, чтобы не было регресса там, где формат не снят.
 */

export interface RepositoryLockLogResult {
  readonly locked: string[];
  readonly cancelled: string[];
  readonly absent: string[];
  /** В логе была хотя бы одна из распознаваемых форм строк. */
  readonly recognized: boolean;
}

const LOCKED_PREFIX = 'Объект захвачен для редактирования:';
const CANCELLED_PREFIX = 'Захват объекта отменен:';
const ABSENT_PREFIX = 'Объекты, отсутствующие в обеих конфигурациях:';
/** Полное имя объекта платформы: вид и имя через точку (`Справочник.Товары`). */
const OBJECT_FULL_NAME = /^[^.\s]+\.[^.\s]/;

export function parseRepositoryLockLog(log: string): RepositoryLockLogResult {
  const locked: string[] = [];
  const cancelled: string[] = [];
  const absent: string[] = [];
  let recognized = false;
  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim();
    recognized ||= [LOCKED_PREFIX, CANCELLED_PREFIX, ABSENT_PREFIX].some((prefix) => line.startsWith(prefix));
    if (line.startsWith(LOCKED_PREFIX)) {
      locked.push(line.slice(LOCKED_PREFIX.length).trim());
    } else if (line.startsWith(CANCELLED_PREFIX)) {
      cancelled.push(line.slice(CANCELLED_PREFIX.length).trim());
    } else if (line.startsWith(ABSENT_PREFIX)) {
      absent.push(...line.slice(ABSENT_PREFIX.length).split(',').map((name) => name.trim()).filter(Boolean));
    }
  }
  return { locked, cancelled, absent, recognized };
}

/** Какие из запрошенных объектов помечать захваченными (порядок — как в `fullNames`). */
export function resolveLockedFullNames(fullNames: readonly string[], log: string): string[] {
  const parsed = parseRepositoryLockLog(log);
  if (!parsed.recognized) {
    return [...fullNames];
  }
  const locked = new Set(parsed.locked.map((name) => name.toLocaleLowerCase('ru')));
  // Фильтруются только имена объектов вида «Тип.Имя». Служебное имя корня (`__configuration_root__`)
  // в логе не встречается никогда: отбросив его, учёт потерял бы захват корня и запретил бы создание
  // корневых объектов. Корень захватывается целиком, и успех операции — его единственный признак.
  return fullNames.filter((name) => !OBJECT_FULL_NAME.test(name) || locked.has(name.toLocaleLowerCase('ru')));
}

const OPERATION_BEGIN_MARKER = '---- Начало операции';
const RECEIVED_PREFIX = 'Объект получен из хранилища:';

/**
 * Получила ли база при захвате новые версии объектов из хранилища (эксперимент Э14: строка
 * «Объект получен из хранилища» пишется и при захвате БЕЗ `-revised`, если объект менялся в
 * хранилище). Лог не распознан (нет маркера начала операции) — `true`: лишний импорт дешевле
 * проекта, молча отстающего от базы.
 */
export function hasReceivedFromRepository(log: string): boolean {
  const lines = log.split(/\r?\n/).map((line) => line.trim());
  if (!lines.some((line) => line.startsWith(OPERATION_BEGIN_MARKER))) {
    return true;
  }
  return lines.some((line) => line.startsWith(RECEIVED_PREFIX));
}
