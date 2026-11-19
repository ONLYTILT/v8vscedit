import type { AgentFileEntry, AgentFileStore, AgentStreamOptions } from '../../../infra/agent/files/AgentFileStore';

/**
 * Обёртка над настоящим хранилищем: все методы контракта (включая потоковые `downloadToFile`/
 * `uploadFromFile`) делегируются внутреннему, подклассы переопределяют только то, что им нужно
 * (счётчики, отказ, отмена по числу операций). Заводить такой класс в каждом тесте нельзя: при
 * расширении контракта `AgentFileStore` пришлось бы править каждую копию.
 */
export class DelegatingAgentFileStore implements AgentFileStore {
  constructor(protected readonly inner: AgentFileStore) {}
  get kind(): 'local' | 'sftp' { return this.inner.kind; }
  stat(rel: string): Promise<AgentFileEntry | undefined> { return this.inner.stat(rel); }
  readFile(rel: string): Promise<Buffer> { return this.inner.readFile(rel); }
  writeFile(rel: string, data: Uint8Array | string): Promise<void> { return this.inner.writeFile(rel, data); }
  downloadToFile(rel: string, localPath: string, options?: AgentStreamOptions): Promise<void> {
    return this.inner.downloadToFile(rel, localPath, options);
  }
  uploadFromFile(localPath: string, rel: string, options?: AgentStreamOptions): Promise<void> {
    return this.inner.uploadFromFile(localPath, rel, options);
  }
  remove(rel: string, options?: { readonly recursive?: boolean }): Promise<void> { return this.inner.remove(rel, options); }
  list(relDir: string, options?: { readonly recursive?: boolean }): Promise<AgentFileEntry[]> { return this.inner.list(relDir, options); }
  mkdirp(rel: string): Promise<void> { return this.inner.mkdirp(rel); }
  dispose(): Promise<void> { return this.inner.dispose(); }
}

export type CountedStoreMethod = 'readFile' | 'writeFile' | 'downloadToFile' | 'uploadFromFile';

/**
 * Считает вызовы по ПУТИ хранилища: приёмка «ни одного `readFile`/`writeFile` размером с архив» —
 * это нулевое число вызовов этих методов по `exchange/**` `/full.zip`, а не замер памяти процесса.
 */
export class CountingAgentFileStore extends DelegatingAgentFileStore {
  /** `localPath` — локальный файл потоковых методов (по нему проверяется место локального обмена). */
  readonly calls: { method: CountedStoreMethod; path: string; localPath?: string }[] = [];

  override readFile(rel: string): Promise<Buffer> {
    this.calls.push({ method: 'readFile', path: rel });
    return super.readFile(rel);
  }
  override writeFile(rel: string, data: Uint8Array | string): Promise<void> {
    this.calls.push({ method: 'writeFile', path: rel });
    return super.writeFile(rel, data);
  }
  override downloadToFile(rel: string, localPath: string, options?: AgentStreamOptions): Promise<void> {
    this.calls.push({ method: 'downloadToFile', path: rel, localPath });
    return super.downloadToFile(rel, localPath, options);
  }
  override uploadFromFile(localPath: string, rel: string, options?: AgentStreamOptions): Promise<void> {
    this.calls.push({ method: 'uploadFromFile', path: rel, localPath });
    return super.uploadFromFile(localPath, rel, options);
  }

  count(method: CountedStoreMethod, pathPattern: RegExp): number {
    return this.calls.filter((call) => call.method === method && pathPattern.test(call.path)).length;
  }
}

export interface MtimeShapingOptions {
  /** Срезать `mtimeMs` у всех записей `stat`/`list` (хранилище не сообщает времена). */
  readonly stripMtime?: boolean;
  /** Запись пути, содержащего эту подстроку, отказывает (метка времени сервера недоступна). */
  readonly failWriteIncluding?: string;
}

/**
 * Хранилище, которое искажает метаданные времени или отказывает на записи метки: проверка откатов отбора по
 * времени изменения. Остальное делегируется настоящему хранилищу.
 */
export class MtimeShapingAgentFileStore extends DelegatingAgentFileStore {
  constructor(inner: AgentFileStore, private readonly options: MtimeShapingOptions) {
    super(inner);
  }

  override async stat(rel: string): Promise<AgentFileEntry | undefined> {
    const entry = await super.stat(rel);
    return entry && this.shape(entry);
  }

  override async list(relDir: string, options?: { readonly recursive?: boolean }): Promise<AgentFileEntry[]> {
    return (await super.list(relDir, options)).map((entry) => this.shape(entry));
  }

  override writeFile(rel: string, data: Uint8Array | string): Promise<void> {
    if (this.options.failWriteIncluding !== undefined && rel.includes(this.options.failWriteIncluding)) {
      return Promise.reject(new Error('запись метки отказала'));
    }
    return super.writeFile(rel, data);
  }

  private shape(entry: AgentFileEntry): AgentFileEntry {
    if (this.options.stripMtime !== true) {
      return entry;
    }
    return { path: entry.path, type: entry.type, size: entry.size };
  }
}
