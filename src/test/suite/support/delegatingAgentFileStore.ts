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
