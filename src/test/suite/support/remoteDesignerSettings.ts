/**
 * Настройки `v8vscedit.remote.*` (Global) для тестов Э9: запись и полный сброс.
 * Настройки настоящие (Extension Host), поэтому каждый сьют обязан вернуть их в teardown.
 */
import * as vscode from 'vscode';

export const REMOTE_SETTING_KEYS = ['computerName', 'authentication', 'user', 'useSsl', 'port', 'v8Path', 'ibConnection'] as const;

export async function setRemoteSetting(key: (typeof REMOTE_SETTING_KEYS)[number], value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('v8vscedit.remote').update(key, value, vscode.ConfigurationTarget.Global);
}

export async function resetRemoteSettings(): Promise<void> {
  for (const key of REMOTE_SETTING_KEYS) {
    await setRemoteSetting(key, undefined);
  }
}
