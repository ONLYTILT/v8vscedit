import * as fs from 'fs';
import * as path from 'path';
import { nodeHashScanFs, type HashScanFs } from '../../../infra/cache/HashScanner';
import type { FileFingerprint } from '../../../infra/cache/HashStatMemo';

/**
 * Обёртка над НАСТОЯЩИМ `nodeHashScanFs`: считает обращения и даёт хуки «перед вызовом», чтобы
 * воспроизводить гонки ФС реальными действиями (удалить файл между readdir и stat и т.п.).
 * Это не мок: каждое обращение уходит в реальную ФС временного каталога. Счётчик `readFile` —
 * поведенческий критерий «неизменённые файлы не читаются» из ТЗ (а не замер времени).
 */
export interface CountingFs extends HashScanFs {
  readonly counts: { readdir: number; stat: number; readFile: number };
  readonly readPaths: string[];
  beforeReaddir?: (dir: string) => void | Promise<void>;
  beforeStat?: (filePath: string) => void | Promise<void>;
  beforeReadFile?: (filePath: string) => void | Promise<void>;
  reset(): void;
}

export function countingFs(base: HashScanFs = nodeHashScanFs): CountingFs {
  const wrapper: CountingFs = {
    counts: { readdir: 0, stat: 0, readFile: 0 },
    readPaths: [],
    async readdir(dir: string): Promise<readonly fs.Dirent[]> {
      wrapper.counts.readdir += 1;
      await wrapper.beforeReaddir?.(dir);
      return base.readdir(dir);
    },
    async stat(filePath: string): Promise<FileFingerprint> {
      wrapper.counts.stat += 1;
      await wrapper.beforeStat?.(filePath);
      return base.stat(filePath);
    },
    async readFile(filePath: string): Promise<Buffer> {
      wrapper.counts.readFile += 1;
      wrapper.readPaths.push(filePath);
      await wrapper.beforeReadFile?.(filePath);
      return base.readFile(filePath);
    },
    reset(): void {
      wrapper.counts.readdir = 0;
      wrapper.counts.stat = 0;
      wrapper.counts.readFile = 0;
      wrapper.readPaths.length = 0;
    },
  };
  return wrapper;
}

/**
 * «Часы» на минуту вперёд: только что записанный файл (его ctime — «сейчас») иначе всегда racy, и
 * его отпечаток в мемо не попал бы. Детерминизм racy-логики достигается подменой `now`, а не ожиданием.
 */
export const futureNow = (): number => Date.now() + 60_000;

/** Ошибка ФС с кодом, как её бросает Node (`EBUSY`, `ENOENT`, …). */
export function fsError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** Пишет файл по POSIX-относительному пути, создавая каталоги. */
export function writeRel(root: string, rel: string, content: string | Buffer): string {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** Минимальный Configuration.xml, который разбирает `parseConfigXml` (имя + префикс для cfe). */
export function buildMinimalConfigXml(name: string, extension = false): string {
  const extProps = extension
    ? '\n\t\t\t<ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose>\n\t\t\t<NamePrefix>Расш_</NamePrefix>'
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20">
\t<Configuration uuid="00000000-0000-0000-0000-000000000001">
\t\t<Properties>
\t\t\t<Name>${name}</Name>${extProps}
\t\t\t<Synonym/>
\t\t\t<Comment/>
\t\t</Properties>
\t\t<ChildObjects/>
\t</Configuration>
</MetaDataObject>
`;
}
