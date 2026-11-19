// Перенесено из ExtensionCommandRunner.ts (Э2) без изменения поведения; публичный API реэкспортируется оттуда.

export interface ConfigurationProgressHooks {
  readonly onProgressMessage?: (message: string) => void;
}

export interface ConfigurationImportHooks extends ConfigurationProgressHooks {
  readonly beforeProjectFilesChanged?: (filePaths: string[]) => void;
}
