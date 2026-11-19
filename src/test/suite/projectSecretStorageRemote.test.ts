/**
 * Э9: пароль учётной записи PSSession (`v8vscedit.remote.user`) в SecretStorage — запрет №9 CLAUDE.md:
 * в settings.json/env.json пароль не хранится никогда.
 *
 * Контракт ProjectSecretStorage (infra/environment/ProjectSecretStorage.ts):
 *   getRemotePassword(): Promise<string | undefined>
 *   setRemotePassword(value: string): Promise<void>     // пустое/пробельное — удаление; иначе хранится КАК ЕСТЬ: пробелы
 *                                                         // по краям доменного пароля значимы (ревью Э9, B2), в отличие от
 *                                                         // пароля БД/хранилища
 *   hasRemotePassword(): Promise<boolean>
 * Ключ неймспейсится хэшем корня workspace (пароли разных проектов не пересекаются) и своим префиксом
 * `remote-`: не пересекается ни с паролем БД, ни с паролями хранилища ни при каких scopeKey.
 */
import * as assert from 'assert';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';

function fakeSecretStore(): SecretStore & { keys: () => string[]; raw: (key: string) => string | undefined } {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
    keys: () => [...map.keys()],
    raw: (key: string) => map.get(key),
  };
}

suite('Э9: ProjectSecretStorage — пароль PSSession (remote)', () => {
  test('set/get/has: сохранённый пароль читается, has отражает наличие', async () => {
    const storage = new ProjectSecretStorage(fakeSecretStore(), '/workspace/one');
    assert.strictEqual(await storage.hasRemotePassword(), false);
    assert.strictEqual(await storage.getRemotePassword(), undefined);

    await storage.setRemotePassword('Пар"оль $1');
    assert.strictEqual(await storage.getRemotePassword(), 'Пар"оль $1');
    assert.strictEqual(await storage.hasRemotePassword(), true);
  });

  test('пустое и пробельное значение удаляет пароль, запись не остаётся', async () => {
    const store = fakeSecretStore();
    const storage = new ProjectSecretStorage(store, '/workspace/one');
    await storage.setRemotePassword('secret');
    await storage.setRemotePassword('   ');
    assert.strictEqual(await storage.getRemotePassword(), undefined);
    assert.strictEqual(await storage.hasRemotePassword(), false);
    assert.deepStrictEqual(store.keys(), []);
  });

  test('пробелы по краям пароля сохраняются как есть (значимы для доменной учётки); пароль БД по-прежнему обрезается', async () => {
    const storage = new ProjectSecretStorage(fakeSecretStore(), '/workspace/one');
    await storage.setRemotePassword('  pw  ');
    assert.strictEqual(await storage.getRemotePassword(), '  pw  ');
    await storage.setDbPassword('  db  ');
    assert.strictEqual(await storage.getDbPassword(), 'db');
  });

  test('пароли разных workspace-корней не пересекаются', async () => {
    const store = fakeSecretStore();
    const one = new ProjectSecretStorage(store, '/workspace/one');
    const two = new ProjectSecretStorage(store, '/workspace/two');
    await one.setRemotePassword('pw-one');
    await two.setRemotePassword('pw-two');
    assert.strictEqual(await one.getRemotePassword(), 'pw-one');
    assert.strictEqual(await two.getRemotePassword(), 'pw-two');
  });

  test('remote-ключ не пересекается с паролем БД и паролями хранилища: пять секретов — пять разных ключей, значения не смешиваются', async () => {
    const store = fakeSecretStore();
    const storage = new ProjectSecretStorage(store, '/workspace/one');
    await storage.setDbPassword('db-secret');
    await storage.setRepoPassword('scope-a', 'repo-a');
    await storage.setRepoPassword('remote', 'repo-named-remote');
    await storage.setRepoPassword('remote-scope', 'repo-remote-scope');
    await storage.setRemotePassword('remote-secret');

    assert.strictEqual(new Set(store.keys()).size, 5);
    assert.strictEqual(await storage.getDbPassword(), 'db-secret');
    assert.strictEqual(await storage.getRepoPassword('scope-a'), 'repo-a');
    assert.strictEqual(await storage.getRepoPassword('remote'), 'repo-named-remote');
    assert.strictEqual(await storage.getRemotePassword(), 'remote-secret');
  });

  test('удаление remote-пароля не трогает пароль БД и хранилища', async () => {
    const storage = new ProjectSecretStorage(fakeSecretStore(), '/workspace/one');
    await storage.setDbPassword('db');
    await storage.setRepoPassword('s', 'repo');
    await storage.setRemotePassword('r');
    await storage.setRemotePassword('');
    assert.strictEqual(await storage.getDbPassword(), 'db');
    assert.strictEqual(await storage.getRepoPassword('s'), 'repo');
  });

  test('ключ несёт префикс remote- и не содержит ни пароля, ни корня workspace открытым текстом', async () => {
    const store = fakeSecretStore();
    const storage = new ProjectSecretStorage(store, '/workspace/one');
    await storage.setRemotePassword('very-secret-password');
    const [key] = store.keys();
    assert.match(key, /remote-/);
    assert.ok(!key.includes('very-secret-password'));
    assert.ok(!key.includes('/workspace/one'));
  });
});
