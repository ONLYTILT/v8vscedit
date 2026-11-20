import * as assert from 'assert';
import { formatFileCount } from '../../infra/agent/sync/TransferProgressText';

/** Склонение числа файлов в строках журнала дельты («Скачивается 2 файла, …»): все ветки русского правила. */
suite('TransferProgressText: formatFileCount', () => {
  const CASES: readonly (readonly [number, string])[] = [
    [0, '0 файлов'],
    [1, '1 файл'],
    [2, '2 файла'],
    [4, '4 файла'],
    [5, '5 файлов'],
    [11, '11 файлов'],
    [12, '12 файлов'],
    [14, '14 файлов'],
    [21, '21 файл'],
    [22, '22 файла'],
    [25, '25 файлов'],
    [111, '111 файлов'],
    [112, '112 файлов'],
    [122, '122 файла'],
  ];
  for (const [count, expected] of CASES) {
    test(`${String(count)} → ${expected}`, () => {
      assert.strictEqual(formatFileCount(count), expected);
    });
  }
});
