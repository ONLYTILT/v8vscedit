import { buildAgentCommand } from './AgentCommand';

/**
 * Строки команд агента для CF/CFE-файлов и списка расширений (эксперименты Э28/Э29, 8.3.27.2130).
 *
 * Вектор команды держится под точным регресс-тестом: агент молча принимает неизвестные ключи, поэтому
 * ошибку в строке не покажет ни код ответа, ни журнал.
 */

/** `config dump-cfg --file=<rel> [--extension=<имя>]`. Пустое/пробельное имя — основная конфигурация. */
export function buildDumpCfgCommand(fileRel: string, extensionName?: string): string {
  return buildAgentCommand('config dump-cfg', { file: fileRel, extension: normalizeExtensionName(extensionName) });
}

/** `config load-cfg --file=<rel> [--extension=<имя>]`. Пустое/пробельное имя — основная конфигурация. */
export function buildLoadCfgCommand(fileRel: string, extensionName?: string): string {
  return buildAgentCommand('config load-cfg', { file: fileRel, extension: normalizeExtensionName(extensionName) });
}

/**
 * `config extensions properties get --all-extensions`. Параметра имени нет: форма с `--extension=<имя>`
 * расширению не нужна — список всех расширений покрывает все сценарии. Наблюдавшееся «зависание» на ней
 * оказалось ответом одним `extension-properties` без `success` (ФАКТ Э30–Э31), а не сбоем агента.
 */
export function buildExtensionsPropertiesGetAllCommand(): string {
  return buildAgentCommand('config extensions properties get', { 'all-extensions': true });
}

function normalizeExtensionName(extensionName: string | undefined): string | undefined {
  const trimmed = extensionName?.trim();
  return trimmed === '' ? undefined : trimmed;
}
