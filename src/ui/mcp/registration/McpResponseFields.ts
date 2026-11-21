/**
 * Общая сборка JSON-ответов MCP-инструментов: ключ без значения не публикуется (агент не должен гадать,
 * чем `undefined` отличается от отсутствия поля).
 */

/** Непустые списки предупреждений; `undefined` — предупреждений нет (ответ не получает ключа `warnings`). */
export function mergeWarnings(...lists: (readonly string[] | undefined)[]): string[] | undefined {
  let merged: string[] | undefined;
  for (const list of lists) {
    if (list !== undefined && list.length > 0) {
      merged = [...(merged ?? []), ...list];
    }
  }
  return merged;
}

/** Только заданные поля: batch-ответ не получает ключей агентской ветки со значением `undefined`. */
export function definedFields(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
