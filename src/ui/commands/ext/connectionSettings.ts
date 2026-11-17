// Перенесено из ExtensionCommandRunner.ts (Э2) без изменения поведения; публичный API реэкспортируется оттуда.
import * as fs from 'fs';
import * as path from 'path';
import { normalizeInfoBasePath, resolveV8PathHintFromVersion } from '../../../infra/process';
import { resolveDbPassword, type ProjectSecretStorage } from '../../../infra/environment';

/**
 * Хранилище секретов проекта, внедряемое из композиционного корня (`Container`).
 * Модуль запускает процессы 1С из множества экспортируемых функций с разными
 * сигнатурами; вместо каскадного проброса `ProjectSecretStorage` через каждую из
 * них корень один раз регистрирует единственный экземпляр. Пароль БД читается
 * только через него (SecretStorage), в env.json пароль больше не хранится.
 */
let injectedProjectSecretStorage: ProjectSecretStorage | undefined;

/**
 * Регистрирует хранилище секретов проекта. Вызывается один раз из `Container`.
 * `undefined` возвращает модуль к состоянию «не внедрено» — иначе путь деградации до
 * legacy-пароля (resolveConnectionPassword) недостижим для теста после первого внедрения.
 */
export function setProjectSecretStorage(secrets: ProjectSecretStorage | undefined): void {
  injectedProjectSecretStorage = secrets;
}

export interface ConnectionParams {
  infoBasePath?: string;
  infoBaseServer?: string;
  infoBaseRef?: string;
  userName?: string;
  password?: string;
  v8Path?: string;
}

export function resolveSettingsPath(workspaceRoot: string, extensionRoot: string): string {
  const extensionParent = path.dirname(extensionRoot);
  const extensionGrandParent = path.dirname(extensionParent);
  const candidates = [
    path.join(workspaceRoot, 'env.json'),
    path.join(extensionGrandParent, 'env.json'),
    path.join(extensionParent, 'env.json'),
    path.join(workspaceRoot, 'example', 'env.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

/**
 * Файл настроек подключения ПРОЕКТА (не конкретного расширения): `env.json`
 * ищется от корня рабочей папки. Псевдо-корень `src/cfe/_probe` — способ
 * переиспользовать общий `resolveSettingsPath` там, где конкретного расширения
 * нет (список расширений базы, операции с CF/CFE-файлами, пакетные операции):
 * третьей копии этого литерала быть не должно.
 */
export function resolveProjectSettingsPath(workspaceRoot: string): string {
  return resolveSettingsPath(workspaceRoot, path.join(workspaceRoot, 'src', 'cfe', '_probe'));
}

export async function resolveConnectionFromSettings(settingsPath: string): Promise<ConnectionParams> {
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Не найден env.json для подключения к базе: ${settingsPath}`);
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const parsed = JSON.parse(raw) as {
    default?: Record<string, unknown>;
  };
  const defaults = parsed.default ?? {};

  const ibConnectionRaw = asString(defaults['--ibconnection']);
  if (!ibConnectionRaw) {
    throw new Error(`В env.json отсутствует "--ibconnection": ${settingsPath}`);
  }

  const connection: ConnectionParams = parseIbConnection(ibConnectionRaw);
  connection.userName = asString(defaults['--db-user']) ?? '';
  connection.password = await resolveConnectionPassword(asString(defaults['--db-pwd']) ?? '');
  connection.v8Path = resolveV8PathFromSettings(defaults);
  return connection;
}

/**
 * Резолвит пароль подключения: приоритет — `ProjectSecretStorage`, fallback —
 * legacy-значение из env.json (для конфигураций, ещё не пересохранённых новым
 * `ProjectEnvironmentService.save`). Без внедрённого хранилища деградирует до
 * legacy-значения, не роняя запуск.
 */
async function resolveConnectionPassword(legacyEnvJsonPassword: string): Promise<string> {
  if (!injectedProjectSecretStorage) {
    return legacyEnvJsonPassword;
  }
  return resolveDbPassword(injectedProjectSecretStorage, legacyEnvJsonPassword);
}

function parseIbConnection(rawValue: string): ConnectionParams {
  const normalized = rawValue.replace(/^"+|"+$/g, '');
  if (/^\/F/i.test(normalized)) {
    const infoBasePath = normalizeInfoBasePath(normalized.slice(2).trim());
    return { infoBasePath };
  }

  if (/^\/S/i.test(normalized)) {
    const serverRef = normalized.slice(2).trim();
    const slashIndex = serverRef.indexOf('/');
    if (slashIndex > 0) {
      return {
        infoBaseServer: serverRef.slice(0, slashIndex),
        infoBaseRef: serverRef.slice(slashIndex + 1),
      };
    }
  }

  throw new Error(`Не удалось разобрать "--ibconnection": ${rawValue}`);
}

export function buildConnectionCliArgs(params: ConnectionParams): string[] {
  const args: string[] = [];
  if (params.infoBasePath) {
    args.push('-InfoBasePath', params.infoBasePath);
  } else if (params.infoBaseServer && params.infoBaseRef) {
    args.push('-InfoBaseServer', params.infoBaseServer, '-InfoBaseRef', params.infoBaseRef);
  } else {
    throw new Error('Недостаточно параметров подключения к базе из env.json');
  }

  if (params.userName) {
    args.push('-UserName', params.userName);
  }
  if (params.password) {
    args.push('-Password', params.password);
  }
  if (params.v8Path) {
    args.push('-V8Path', params.v8Path);
  }
  return args;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed) {
    return trimmed;
  }
  return undefined;
}

function resolveV8PathFromSettings(defaults: Record<string, unknown>): string {
  return asString(defaults['--path']) ?? resolveV8PathHintFromVersion(asString(defaults['--v8version']) ?? '');
}
