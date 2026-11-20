import { isUnappliedExtensionStub, type AgentExtensionInfo } from './ExtensionProperties';

/**
 * Чистые решения поверх списка расширений базы (`properties get --all-extensions`) для операций с
 * CF/CFE-файлами через агента. Имена 1С сравниваются без учёта регистра (как `planCfeLoad`).
 */

/**
 * Цель загрузки `.cfe`:
 *  - `new` — имени нет в базе: после `load-cfg` обязателен `update-db-cfg`, иначе остаётся заглушка (Э28);
 *  - `existing` — применённое расширение: применение — отдельный шаг (прежний контракт);
 *  - `stub` — в базе неприменённая заглушка с этим именем: загрузка в неё безопасна в той же сессии
 *    (ФАКТ Э29, П3), поэтому — как новое: load → update → сверка списком.
 */
export type CfeLoadTargetDecision =
  | { readonly kind: 'new' }
  | { readonly kind: 'existing'; readonly name: string }
  | { readonly kind: 'stub'; readonly name: string };

export function planCfeLoadTarget(infos: readonly AgentExtensionInfo[], requested: string): CfeLoadTargetDecision {
  const found = findExtension(infos, requested);
  if (!found) {
    return { kind: 'new' };
  }
  return isUnappliedExtensionStub(found) ? { kind: 'stub', name: found.name } : { kind: 'existing', name: found.name };
}

export type CfeDumpTargetDecision =
  | { readonly kind: 'dump'; readonly name: string }
  | { readonly kind: 'refuse'; readonly reason: string };

/** Выгрузка `.cfe`: имени нет в базе — E5; заглушка — E3 (её выгрузка роняет агента, команда не отправляется). */
export function planCfeDumpTarget(infos: readonly AgentExtensionInfo[], requested: string): CfeDumpTargetDecision {
  const found = findExtension(infos, requested);
  if (!found) {
    return { kind: 'refuse', reason: extensionMissingText(requested, infos) };
  }
  if (isUnappliedExtensionStub(found)) {
    return { kind: 'refuse', reason: stubDumpRefusedText(found.name) };
  }
  return { kind: 'dump', name: found.name };
}

/** Пакетная выгрузка: применённые — выгружаются, заглушки — пропускаются с причиной E3. Порядок входа сохраняется. */
export function splitDumpableExtensions(infos: readonly AgentExtensionInfo[]): { readonly dumpable: string[]; readonly stubs: string[] } {
  const dumpable: string[] = [];
  const stubs: string[] = [];
  for (const info of infos) {
    (isUnappliedExtensionStub(info) ? stubs : dumpable).push(info.name);
  }
  return { dumpable, stubs };
}

export type LoadVerification =
  | { readonly status: 'ok'; readonly actualName: string }
  /** Имя в базе взято из файла (ФАКТ Э29, П4), а не запрошенное. */
  | { readonly status: 'renamed'; readonly actualName: string }
  | { readonly status: 'stub'; readonly actualName: string }
  | { readonly status: 'missing' };

/**
 * Сверка ДО/ПОСЛЕ применения: появившиеся имена = after − before. Запрошенное среди них — `ok`/`stub`;
 * ровно одно другое — `renamed`; иначе (ничего или неоднозначно) — `missing`: угадывать нельзя.
 * Для загрузки в существующее имя вызывающий убирает это имя из `before`.
 */
export function verifyNewExtensionLoad(
  before: readonly AgentExtensionInfo[],
  after: readonly AgentExtensionInfo[],
  requested: string
): LoadVerification {
  const appeared = after.filter((info) => !findExtension(before, info.name));
  const target = findExtension(appeared, requested);
  if (target) {
    return isUnappliedExtensionStub(target)
      ? { status: 'stub', actualName: target.name }
      : { status: 'ok', actualName: target.name };
  }
  return appeared.length === 1 ? { status: 'renamed', actualName: appeared[0].name } : { status: 'missing' };
}

/** Есть ли имя в базе (заглушка — есть). Агент на `update-db-cfg` отсутствующего отвечает успехом молча (Э28). */
export function hasExtension(infos: readonly AgentExtensionInfo[], name: string): boolean {
  return findExtension(infos, name) !== undefined;
}

export function findExtension(infos: readonly AgentExtensionInfo[], name: string): AgentExtensionInfo | undefined {
  const lower = name.toLowerCase();
  return infos.find((info) => info.name.toLowerCase() === lower);
}

/** E5. */
export function extensionMissingText(requested: string, infos: readonly AgentExtensionInfo[]): string {
  const names = infos.map((info) => info.name);
  return names.length > 0
    ? `Расширения «${requested}» нет в базе. Расширения базы: ${names.join(', ')}.`
    : `Расширения «${requested}» нет в базе: в базе нет расширений.`;
}

/** E3. */
export function stubDumpRefusedText(name: string): string {
  return `Расширение «${name}» в базе не применено (неприменённая заглушка от прерванной загрузки): выгружать ` +
    'нельзя — агент конфигуратора аварийно завершается на такой выгрузке. Загрузите расширение заново или удалите ' +
    'его в Конфигураторе.';
}
