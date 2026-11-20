export type AiMcpProfile = 'reference' | 'workspace';
export type AiMcpProcessState = 'disabled' | 'running' | 'stopped' | 'error';

export interface AiMcpSettings {
  readonly extensionAutoStart: boolean;
  readonly extensionHost: string;
  readonly extensionPort: number;
  readonly bslAnalyzerAutoStart: boolean;
  readonly bslAnalyzerReferenceEnabled: boolean;
  readonly bslAnalyzerWorkspaceEnabled: boolean;
  readonly bslAnalyzerWorkspaceSourceDir: string;
  readonly bslAnalyzerEmbeddingUrl: string;
  readonly bslAnalyzerEmbeddingApiKey: string;
  readonly bslAnalyzerEmbeddingModel: string;
  readonly bslAnalyzerNaparnikToken: string;
  readonly bslAnalyzerOnecUrl: string;
  readonly bslAnalyzerOnecUser: string;
  readonly bslAnalyzerOnecPassword: string;
}

/**
 * Снимок настроек для webview без сырых секретов. Реальные значения
 * ключей/токена/пароля остаются только на стороне расширения, наружу
 * уходит лишь признак «задано/не задано», чтобы UI мог показать маску.
 * Любая XSS/инъекция в webview не должна получить доступ к секретам.
 */
export interface AiMcpRedactedSettings {
  readonly extensionAutoStart: boolean;
  readonly extensionHost: string;
  readonly extensionPort: number;
  readonly bslAnalyzerAutoStart: boolean;
  readonly bslAnalyzerReferenceEnabled: boolean;
  readonly bslAnalyzerWorkspaceEnabled: boolean;
  readonly bslAnalyzerWorkspaceSourceDir: string;
  readonly bslAnalyzerEmbeddingUrl: string;
  readonly bslAnalyzerEmbeddingApiKeySet: boolean;
  readonly bslAnalyzerEmbeddingModel: string;
  readonly bslAnalyzerNaparnikTokenSet: boolean;
  readonly bslAnalyzerOnecUrl: string;
  readonly bslAnalyzerOnecUser: string;
  readonly bslAnalyzerOnecPasswordSet: boolean;
}

/**
 * Полезная нагрузка сохранения из webview: несекретные поля приходят всегда,
 * секреты — только если пользователь реально ввёл новое значение. Пустой/
 * отсутствующий секрет означает «не менять» и не затирает сохранённое.
 */
export type AiMcpSaveSettings = Omit<
  AiMcpSettings,
  'bslAnalyzerEmbeddingApiKey' | 'bslAnalyzerNaparnikToken' | 'bslAnalyzerOnecPassword'
> & {
  readonly bslAnalyzerEmbeddingApiKey?: string;
  readonly bslAnalyzerNaparnikToken?: string;
  readonly bslAnalyzerOnecPassword?: string;
};

export { BSL_ANALYZER_MCP_TOOLS, EXTENSION_MCP_TOOLS, type AiMcpToolInfo } from './AiMcpToolCatalog';

export function createDefaultAiMcpSettings(workspaceRoot: string): AiMcpSettings {
  return {
    extensionAutoStart: true,
    extensionHost: '127.0.0.1',
    extensionPort: 38481,
    bslAnalyzerAutoStart: false,
    bslAnalyzerReferenceEnabled: true,
    bslAnalyzerWorkspaceEnabled: true,
    bslAnalyzerWorkspaceSourceDir: workspaceRoot,
    bslAnalyzerEmbeddingUrl: '',
    bslAnalyzerEmbeddingApiKey: '',
    bslAnalyzerEmbeddingModel: 'qwen/qwen3-embedding-0.6b',
    bslAnalyzerNaparnikToken: '',
    bslAnalyzerOnecUrl: '',
    bslAnalyzerOnecUser: '',
    bslAnalyzerOnecPassword: '',
  };
}

export function normalizeAiMcpSettings(
  value: Partial<AiMcpSettings>,
  workspaceRoot: string
): AiMcpSettings {
  const defaults = createDefaultAiMcpSettings(workspaceRoot);
  const extensionHost = normalizeLoopbackHost(value.extensionHost, defaults.extensionHost);
  const extensionPort = normalizePort(value.extensionPort, defaults.extensionPort);
  return {
    extensionAutoStart: value.extensionAutoStart ?? defaults.extensionAutoStart,
    extensionHost,
    extensionPort,
    bslAnalyzerAutoStart: value.bslAnalyzerAutoStart ?? defaults.bslAnalyzerAutoStart,
    bslAnalyzerReferenceEnabled: value.bslAnalyzerReferenceEnabled ?? defaults.bslAnalyzerReferenceEnabled,
    bslAnalyzerWorkspaceEnabled: value.bslAnalyzerWorkspaceEnabled ?? defaults.bslAnalyzerWorkspaceEnabled,
    bslAnalyzerWorkspaceSourceDir: nonEmpty(value.bslAnalyzerWorkspaceSourceDir, defaults.bslAnalyzerWorkspaceSourceDir),
    bslAnalyzerEmbeddingUrl: value.bslAnalyzerEmbeddingUrl?.trim() ?? defaults.bslAnalyzerEmbeddingUrl,
    bslAnalyzerEmbeddingApiKey: value.bslAnalyzerEmbeddingApiKey?.trim() ?? defaults.bslAnalyzerEmbeddingApiKey,
    bslAnalyzerEmbeddingModel: nonEmpty(value.bslAnalyzerEmbeddingModel, defaults.bslAnalyzerEmbeddingModel),
    bslAnalyzerNaparnikToken: value.bslAnalyzerNaparnikToken?.trim() ?? defaults.bslAnalyzerNaparnikToken,
    bslAnalyzerOnecUrl: value.bslAnalyzerOnecUrl?.trim() ?? defaults.bslAnalyzerOnecUrl,
    bslAnalyzerOnecUser: value.bslAnalyzerOnecUser?.trim() ?? defaults.bslAnalyzerOnecUser,
    bslAnalyzerOnecPassword: value.bslAnalyzerOnecPassword ?? defaults.bslAnalyzerOnecPassword,
  };
}

/** Готовит снимок настроек для webview, заменяя секреты признаком «задано». */
export function redactAiMcpSettings(settings: AiMcpSettings): AiMcpRedactedSettings {
  return {
    extensionAutoStart: settings.extensionAutoStart,
    extensionHost: settings.extensionHost,
    extensionPort: settings.extensionPort,
    bslAnalyzerAutoStart: settings.bslAnalyzerAutoStart,
    bslAnalyzerReferenceEnabled: settings.bslAnalyzerReferenceEnabled,
    bslAnalyzerWorkspaceEnabled: settings.bslAnalyzerWorkspaceEnabled,
    bslAnalyzerWorkspaceSourceDir: settings.bslAnalyzerWorkspaceSourceDir,
    bslAnalyzerEmbeddingUrl: settings.bslAnalyzerEmbeddingUrl,
    bslAnalyzerEmbeddingApiKeySet: settings.bslAnalyzerEmbeddingApiKey.trim().length > 0,
    bslAnalyzerEmbeddingModel: settings.bslAnalyzerEmbeddingModel,
    bslAnalyzerNaparnikTokenSet: settings.bslAnalyzerNaparnikToken.trim().length > 0,
    bslAnalyzerOnecUrl: settings.bslAnalyzerOnecUrl,
    bslAnalyzerOnecUser: settings.bslAnalyzerOnecUser,
    bslAnalyzerOnecPasswordSet: settings.bslAnalyzerOnecPassword.trim().length > 0,
  };
}

/**
 * Заменяет в настройках сырые секреты на маску для путей, ведущих в webview
 * (например commandLine со статусом). Несекретные значения не меняются.
 */
export function maskAiMcpSecrets(settings: AiMcpSettings, mask: string): AiMcpSettings {
  return {
    ...settings,
    bslAnalyzerEmbeddingApiKey: settings.bslAnalyzerEmbeddingApiKey.trim() ? mask : '',
    bslAnalyzerNaparnikToken: settings.bslAnalyzerNaparnikToken.trim() ? mask : '',
    bslAnalyzerOnecPassword: settings.bslAnalyzerOnecPassword.trim() ? mask : '',
  };
}

/**
 * Сливает полезную нагрузку сохранения с уже сохранёнными настройками:
 * секрет берётся из payload только при непустом значении, иначе остаётся
 * прежний. Так пустой ввод не затирает сохранённый секрет.
 */
export function mergeAiMcpSaveSettings(
  current: AiMcpSettings,
  incoming: AiMcpSaveSettings
): AiMcpSettings {
  return {
    extensionAutoStart: incoming.extensionAutoStart,
    extensionHost: incoming.extensionHost,
    extensionPort: incoming.extensionPort,
    bslAnalyzerAutoStart: incoming.bslAnalyzerAutoStart,
    bslAnalyzerReferenceEnabled: incoming.bslAnalyzerReferenceEnabled,
    bslAnalyzerWorkspaceEnabled: incoming.bslAnalyzerWorkspaceEnabled,
    bslAnalyzerWorkspaceSourceDir: incoming.bslAnalyzerWorkspaceSourceDir,
    bslAnalyzerEmbeddingUrl: incoming.bslAnalyzerEmbeddingUrl,
    bslAnalyzerEmbeddingApiKey: pickSecret(incoming.bslAnalyzerEmbeddingApiKey, current.bslAnalyzerEmbeddingApiKey),
    bslAnalyzerEmbeddingModel: incoming.bslAnalyzerEmbeddingModel,
    bslAnalyzerNaparnikToken: pickSecret(incoming.bslAnalyzerNaparnikToken, current.bslAnalyzerNaparnikToken),
    bslAnalyzerOnecUrl: incoming.bslAnalyzerOnecUrl,
    bslAnalyzerOnecUser: incoming.bslAnalyzerOnecUser,
    bslAnalyzerOnecPassword: pickSecret(incoming.bslAnalyzerOnecPassword, current.bslAnalyzerOnecPassword),
  };
}

function pickSecret(incoming: string | undefined, current: string): string {
  const trimmed = incoming?.trim();
  if (trimmed) {
    return trimmed;
  }
  return current;
}

export function getEnabledBslAnalyzerProfiles(settings: AiMcpSettings): AiMcpProfile[] {
  const profiles: AiMcpProfile[] = [];
  if (settings.bslAnalyzerReferenceEnabled) {
    profiles.push('reference');
  }
  if (settings.bslAnalyzerWorkspaceEnabled) {
    profiles.push('workspace');
  }
  return profiles;
}

export function buildBslAnalyzerMcpArgs(profile: AiMcpProfile, settings: AiMcpSettings): string[] {
  const args = ['mcp', 'serve', '--profile', profile];
  if (profile === 'workspace') {
    args.push('--source-dir', settings.bslAnalyzerWorkspaceSourceDir);
    appendOption(args, '--onec-url', settings.bslAnalyzerOnecUrl);
    appendOption(args, '--onec-user', settings.bslAnalyzerOnecUser);
    appendOption(args, '--onec-password', settings.bslAnalyzerOnecPassword);
  }
  return args;
}

export function buildBslAnalyzerMcpEnv(
  settings: AiMcpSettings,
  baseEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: baseEnv.PATH,
    HOME: baseEnv.HOME,
    LANG: baseEnv.LANG,
    LC_ALL: baseEnv.LC_ALL,
  };
  appendEnv(env, 'EMBEDDING_URL', settings.bslAnalyzerEmbeddingUrl);
  appendEnv(env, 'EMBEDDING_API_KEY', settings.bslAnalyzerEmbeddingApiKey);
  appendEnv(env, 'EMBEDDING_MODEL', settings.bslAnalyzerEmbeddingModel);
  appendEnv(env, 'NAPARNIK_TOKEN', settings.bslAnalyzerNaparnikToken);
  return removeUndefinedEnv(env);
}

function normalizeLoopbackHost(value: string | undefined, fallback: string): string {
  const host = value?.trim();
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    return host;
  }
  return fallback;
}

function normalizePort(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535) {
    return value;
  }
  return fallback;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (trimmed) {
    return trimmed;
  }
  return fallback;
}

function appendOption(args: string[], name: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed) {
    args.push(name, trimmed);
  }
}

function appendEnv(env: NodeJS.ProcessEnv, name: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed) {
    env[name] = trimmed;
  }
}

function removeUndefinedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string'));
}
