import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { freeDiskSpaceOf } from '../../infra/fs/FreeDiskSpace';
import { removeTreeSync } from './support/tempTree';

/** Свободное место тома для проверки перед скачиванием больших файлов: настоящая statfs, без подмен. */
suite('freeDiskSpaceOf', () => {
  let dir: string;
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-free-space-')); });
  teardown(() => { removeTreeSync(dir); });

  test('существующий каталог: положительное число байт', async () => {
    const free = await freeDiskSpaceOf(dir);
    assert.ok(free !== undefined && free > 0, String(free));
  });

  test('отсутствующий каталог: undefined (неизвестность не роняет операцию)', async () => {
    assert.strictEqual(await freeDiskSpaceOf(path.join(dir, 'нет', 'такого')), undefined);
  });
});
