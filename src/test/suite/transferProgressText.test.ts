import * as assert from 'assert';
import { formatByteSize, formatEta, formatRate } from '../../infra/agent/sync/TransferProgressText';

/**
 * Чистые форматтеры прогресса передачи (plan-large-files.md §3.1). Десятичная запятая; основание 1024.
 * Знаков после запятой: Б — без, КБ и МБ — один, ГБ — два. Единица повышается, когда округлённое значение
 * достигло 1024 (не «1024,0 КБ», а «1,0 МБ»).
 */
suite('TransferProgressText: formatByteSize', () => {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const CASES: readonly (readonly [number, string])[] = [
    [0, '0 Б'],
    [1, '1 Б'],
    [512, '512 Б'],
    [KB - 1, '1023 Б'],
    [KB, '1,0 КБ'],
    [300 * KB, '300,0 КБ'],
    [1.5 * KB, '1,5 КБ'],
    [1023 * KB + 972, '1023,9 КБ'],
    [MB - 1, '1,0 МБ'],
    [MB, '1,0 МБ'],
    [327_575_142, '312,4 МБ'],
    [GB - 1, '1,00 ГБ'],
    [GB, '1,00 ГБ'],
    [1_267_015_352, '1,18 ГБ'],
    [10 * GB, '10,00 ГБ'],
  ];
  for (const [bytes, expected] of CASES) {
    test(`${String(bytes)} → ${expected}`, () => {
      assert.strictEqual(formatByteSize(bytes), expected);
    });
  }
});

suite('TransferProgressText: formatRate', () => {
  const CASES: readonly (readonly [number, string])[] = [
    [0, '0 Б/с'],
    [512, '512 Б/с'],
    [300 * 1024, '300,0 КБ/с'],
    [6_081_741, '5,8 МБ/с'],
    [2 * 1024 * 1024 * 1024, '2,00 ГБ/с'],
  ];
  for (const [rate, expected] of CASES) {
    test(`${String(rate)} Б/с → ${expected}`, () => {
      assert.strictEqual(formatRate(rate), expected);
    });
  }
});

suite('TransferProgressText: formatEta', () => {
  const CASES: readonly (readonly [number, string])[] = [
    [0, '~0 с'],
    [12, '~12 с'],
    [11.6, '~12 с'],
    [59, '~59 с'],
    [60, '~1 мин 0 с'],
    [211, '~3 мин 31 с'],
    [3599, '~59 мин 59 с'],
    [3600, '~1 ч 00 мин'],
    [3900, '~1 ч 05 мин'],
    [3920, '~1 ч 05 мин'],
    [7 * 3600 + 23 * 60, '~7 ч 23 мин'],
  ];
  for (const [seconds, expected] of CASES) {
    test(`${String(seconds)} с → ${expected}`, () => {
      assert.strictEqual(formatEta(seconds), expected);
    });
  }
});
