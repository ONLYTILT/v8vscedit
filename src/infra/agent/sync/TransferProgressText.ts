/**
 * Тексты прогресса передачи (plan-large-files.md §3.1): объём, скорость, оставшееся время. Основание 1024,
 * десятичная запятая. Знаков после запятой: Б — без, КБ и МБ — один, ГБ — два (гигабайт без сотых шагает
 * слишком крупно: 1,1 → 1,2 ГБ — это ~100 МБ). Чистые функции.
 */

const UNITS: readonly (readonly [string, number])[] = [
  ['Б', 0],
  ['КБ', 1],
  ['МБ', 1],
  ['ГБ', 2],
];

export function formatByteSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  // Единица повышается по ОКРУГЛЁННОМУ значению: не «1024,0 КБ», а «1,0 МБ».
  while (unit < UNITS.length - 1 && roundTo(value, UNITS[unit][1]) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  const [name, digits] = UNITS[unit];
  return `${roundTo(value, digits).toFixed(digits).replace('.', ',')} ${name}`;
}

export function formatRate(bytesPerSec: number): string {
  return `${formatByteSize(bytesPerSec)}/с`;
}

/** `~12 с`, `~3 мин 31 с`, `~1 ч 05 мин`: часы без секунд — их точность при оценке всё равно мнимая. */
export function formatEta(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) {
    return `~${String(total)} с`;
  }
  if (total < 3600) {
    return `~${String(Math.floor(total / 60))} мин ${String(total % 60)} с`;
  }
  const minutes = Math.floor((total % 3600) / 60);
  return `~${String(Math.floor(total / 3600))} ч ${String(minutes).padStart(2, '0')} мин`;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** `1 файл`, `2 файла`, `5 файлов`, `21 файл`, `11 файлов`. */
export function formatFileCount(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (last === 1 && lastTwo !== 11) {
    return `${String(count)} файл`;
  }
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) {
    return `${String(count)} файла`;
  }
  return `${String(count)} файлов`;
}
