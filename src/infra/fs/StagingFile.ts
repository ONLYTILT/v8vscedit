import * as fs from 'fs';

/**
 * Файловые операции переноса. Шов нужен ради ветки EXDEV: она возникает только при
 * staging и цели на разных томах, и без подмены `renameSync` в тестовом окружении
 * её не воспроизвести.
 */
export type StagingFileOps = Pick<typeof fs, 'existsSync' | 'rmSync' | 'renameSync' | 'copyFileSync'>;

/**
 * Переносит успешно полученный staging-файл на целевой путь.
 *
 * ЕДИНСТВЕННАЯ реализация переноса: одиночная и пакетная выгрузка CF/CFE в CLI и
 * выходные файлы пакетного конфигуратора (`DesignerBatchResult.outputs`) в UI обязаны
 * вести себя одинаково — разошедшиеся копии никто бы не поймал, они исполняются
 * только рядом с реальной платформой. На Windows `rename` поверх существующего файла
 * падает, поэтому цель удаляется явно (перезапись к этому моменту уже подтверждена
 * вызывающим).
 */
export function moveStagingToTarget(stagingPath: string, targetPath: string, ops: StagingFileOps = fs): void {
  if (ops.existsSync(targetPath)) {
    ops.rmSync(targetPath, { force: true });
  }
  try {
    ops.renameSync(stagingPath, targetPath);
  } catch (error) {
    // staging исполнителя лежит во временном каталоге ОС, а цель выбирает пользователь —
    // разные тома штатны, и rename через границу тома невозможен.
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      ops.copyFileSync(stagingPath, targetPath);
      ops.rmSync(stagingPath, { force: true });
      return;
    }
    throw error;
  }
}
