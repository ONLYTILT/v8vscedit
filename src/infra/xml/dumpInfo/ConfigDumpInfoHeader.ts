import * as fs from 'fs';

/**
 * Заголовок файла версий выгрузки (`ConfigDumpInfo.xml`): формат и версия формата.
 *
 * Файл версий настоящей выгрузки — десятки мегабайт, а решение о пригодности выгрузки проекта для
 * посева зеркала агента нужно до вопроса пользователю, поэтому читается только префикс: корневой
 * элемент платформа пишет в самом начале файла.
 */
export interface ConfigDumpInfoHeader {
  readonly format: string;
  readonly version: string;
}

const PREFIX_BYTES = 8 * 1024;

/** `undefined` — файла нет, он не читается или префикс не начинается с корня с обоими атрибутами. */
export function readConfigDumpInfoHeader(filePath: string): ConfigDumpInfoHeader | undefined {
  let prefix: string;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(PREFIX_BYTES);
      const count = fs.readSync(fd, buffer, 0, PREFIX_BYTES, 0);
      prefix = buffer.subarray(0, count).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  return parseConfigDumpInfoHeader(prefix);
}

/**
 * Тот же разбор по тексту: им проверяется свежий файл версий из архива агента (страж «формат и версия
 * совпадают с зеркалом»), который уже прочитан в память и второй раз с диска не читается.
 */
export function parseConfigDumpInfoHeader(prefix: string): ConfigDumpInfoHeader | undefined {
  const root = /<ConfigDumpInfo\b([^>]*)>/.exec(prefix)?.[1];
  if (root === undefined) {
    return undefined;
  }
  const format = /\sformat="([^"]*)"/.exec(root)?.[1];
  const version = /\sversion="([^"]*)"/.exec(root)?.[1];
  return format === undefined || version === undefined ? undefined : { format, version };
}
