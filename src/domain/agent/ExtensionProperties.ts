import type { AgentMessage } from './AgentMessage';

/** Свойства расширения базы из ответа `config extensions properties get --all-extensions`. */
export interface AgentExtensionInfo {
  readonly name: string;
  readonly hashSum: string;
  readonly version?: string;
  readonly active?: boolean;
  /** `customization` | `add-on` | `patch` | иное — как прислал агент. */
  readonly purpose?: string;
  readonly safeMode?: boolean;
  readonly securityProfileName?: string;
  readonly unsafeActionProtection?: boolean;
  readonly usedInDistributedInfobase?: boolean;
  readonly scope?: string;
}

/** Ответ агента не похож на список расширений: неверно понятый список опаснее отказа. */
export class ExtensionPropertiesFormatError extends Error {
  constructor(detail: string) {
    super(`Ответ агента на запрос списка расширений не распознан: ${detail}.`);
    this.name = 'ExtensionPropertiesFormatError';
  }
}

/**
 * Хеш неприменённой заглушки — base64 от 20 нулевых байт (нулевой SHA-1, ФАКТ Э29, П8). Признак — ровно
 * этот хеш: «содержит A» ложно срабатывает на настоящих хешах, а `version` у заглушки пуст так же, как у
 * любого созданного расширения.
 */
const UNAPPLIED_STUB_HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const EXTENSION_PROPERTIES_TYPE = 'extension-properties';

/**
 * Две формы ответа (ФАКТ Э30–Э31). При 0 и ≥2 расширениях — ПОСЛЕДНЕЕ не-error сообщение с массивом `body`
 * (`success`), элемент — `{type:'extension-properties', body:{…}}`; `body: []` — пустая база. При ОДНОМ
 * расширении — само сообщение `extension-properties` верхнего уровня без `success`. Нет ни той, ни другой, элемент
 * чужого типа, пустое `name` или нет `hash-sum` — {@link ExtensionPropertiesFormatError} (fail closed).
 */
export function parseExtensionProperties(messages: readonly AgentMessage[]): AgentExtensionInfo[] {
  const source = [...messages].reverse().find((message) => message.type !== 'error' && Array.isArray(message.body));
  if (source) {
    return (source.body as unknown[]).map(parseElement);
  }
  // Одно расширение: агент шлёт элемент верхнего уровня без `success` (ФАКТ Э30–Э31).
  const single = messages.filter((message) => message.type === EXTENSION_PROPERTIES_TYPE);
  if (single.length === 0) {
    throw new ExtensionPropertiesFormatError('нет сообщения со списком (массив body)');
  }
  return single.map(parseElement);
}

/** Неприменённая заглушка от прерванной загрузки: хеш из нулей. */
export function isUnappliedExtensionStub(info: AgentExtensionInfo): boolean {
  return info.hashSum === UNAPPLIED_STUB_HASH;
}

function parseElement(raw: unknown): AgentExtensionInfo {
  const element = asRecord(raw);
  if (element?.type !== EXTENSION_PROPERTIES_TYPE) {
    throw new ExtensionPropertiesFormatError(`элемент списка не ${EXTENSION_PROPERTIES_TYPE}`);
  }
  const body = asRecord(element.body);
  if (!body) {
    throw new ExtensionPropertiesFormatError('у элемента списка нет свойств');
  }
  const name = body.name;
  const hashSum = body['hash-sum'];
  if (typeof name !== 'string' || !name) {
    throw new ExtensionPropertiesFormatError('у расширения нет имени');
  }
  if (typeof hashSum !== 'string') {
    throw new ExtensionPropertiesFormatError(`у расширения «${name}» нет hash-sum`);
  }
  return {
    name,
    hashSum,
    version: optionalString(body.version),
    active: optionalBoolean(body.active),
    purpose: optionalString(body.purpose),
    safeMode: optionalBoolean(body['safe-mode']),
    securityProfileName: optionalString(body['security-profile-name']),
    unsafeActionProtection: optionalBoolean(body['unsafe-action-protection']),
    usedInDistributedInfobase: optionalBoolean(body['used-in-distributed-infobase']),
    scope: optionalString(body.scope),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Э29: булевы поля — JSON boolean; `yes`/`no` принимаются на случай иной версии платформы. */
function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'yes') {
    return true;
  }
  return value === 'no' ? false : undefined;
}
