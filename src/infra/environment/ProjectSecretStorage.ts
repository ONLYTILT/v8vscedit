import * as crypto from 'crypto';
import type { SecretStore } from '../ai/AiSecretStorage';

/**
 * Обёртка над `vscode.SecretStorage` для секретов проекта (пароль подключения к
 * базе и пароли хранилища конфигурации). Хранит реальные значения в ОС-keychain,
 * а не в `env.json`, чтобы пароли не утекали в git вместе с настройками проекта.
 *
 * Ключи неймспейсятся так, чтобы:
 *  - пароль БД разных workspace-корней не пересекался (хэш корня в ключе);
 *  - пароли хранилища разных областей (scopeKey) не пересекались;
 *  - db-, repo- и remote-ключи не коллизировали между собой (разные префиксы).
 */
export class ProjectSecretStorage {
  private readonly workspaceHash: string;

  constructor(
    private readonly secrets: SecretStore,
    workspaceRoot: string
  ) {
    // Хэш корня в ключе изолирует пароль БД между разными открытыми проектами,
    // использующими один и тот же общий SecretStorage расширения.
    this.workspaceHash = crypto.createHash('sha1').update(workspaceRoot).digest('hex');
  }

  async getDbPassword(): Promise<string | undefined> {
    return this.secrets.get(this.dbPasswordKey());
  }

  async setDbPassword(value: string): Promise<void> {
    await this.writeSecret(this.dbPasswordKey(), value);
  }

  async hasDbPassword(): Promise<boolean> {
    return Boolean(await this.getDbPassword());
  }

  async getRepoPassword(scopeKey: string): Promise<string | undefined> {
    return this.secrets.get(this.repoPasswordKey(scopeKey));
  }

  async setRepoPassword(scopeKey: string, value: string): Promise<void> {
    await this.writeSecret(this.repoPasswordKey(scopeKey), value);
  }

  async hasRepoPassword(scopeKey: string): Promise<boolean> {
    return Boolean(await this.getRepoPassword(scopeKey));
  }

  /** Пароль учётной записи PSSession (`v8vscedit.remote.user`) удалённого сервера 1С. */
  async getRemotePassword(): Promise<string | undefined> {
    return this.secrets.get(this.remotePasswordKey());
  }

  /**
   * В отличие от прочих секретов проекта, пароль доменной учётки хранится КАК ЕСТЬ: пробелы по
   * краям в нём значимы, и обрезка дала бы неверный пароль и неудачные входы (риск блокировки
   * учётки политикой домена). Пустое и пробельное значение — удаление.
   */
  async setRemotePassword(value: string): Promise<void> {
    const key = this.remotePasswordKey();
    if (value.trim()) {
      await this.secrets.store(key, value);
    } else {
      await this.secrets.delete(key);
    }
  }

  async hasRemotePassword(): Promise<boolean> {
    return Boolean(await this.getRemotePassword());
  }

  private async writeSecret(key: string, value: string): Promise<void> {
    // Пустое значение (после trim) трактуем как удаление, чтобы не хранить
    // пустые записи и чтобы «стереть пароль» было явным действием.
    const trimmed = value.trim();
    if (trimmed) {
      await this.secrets.store(key, trimmed);
    } else {
      await this.secrets.delete(key);
    }
  }

  private dbPasswordKey(): string {
    return `v8vscedit.env.${this.workspaceHash}.dbPassword`;
  }

  // Пространство `v8vscedit.remote-` не пересекается с `v8vscedit.repository.<scope>.` ни при каком scopeKey
  // (у repo-ключей после префикса всегда точка), а хэш корня изолирует проекты, как у пароля БД.
  private remotePasswordKey(): string {
    return `v8vscedit.remote-${this.workspaceHash}.password`;
  }

  private repoPasswordKey(scopeKey: string): string {
    return `v8vscedit.repository.${scopeKey}.password`;
  }
}
