/**
 * Стенды UI-уровня для агентских операций с расширениями/CF-файлами: `remote` — `RemoteHarness`
 * (настоящий ssh2 + SFTP, env.json с файловой базой), `local` — запись реестра с настоящим
 * `AgentOperationService` поверх эмулятора и локального хранилища. Подменяется только агент 1С.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { disposeCachedAgentOperationServices, ensureAgentService, type CachedAgentService } from '../../../ui/commands/ext/agent/AgentServiceRegistry';
import type { AgentConfigEmulator } from './agentConfigEmulator';
import { createServiceStand, type ServiceStand } from './agentExtensionsStands';
import { RemoteHarness, resetAgentSettings, setAgentSetting } from './agentRemoteHarness';

type WindowRef = Record<string, unknown>;
const windowRef = vscode.window as unknown as WindowRef;

export interface UiStand {
  readonly folder: vscode.WorkspaceFolder;
  readonly channel: vscode.OutputChannel;
  readonly emulator: AgentConfigEmulator;
  readonly workDir: string;
  readonly lines: string[];
  readonly errors: string[];
  readonly infos: string[];
  readonly warnings: string[];
  commandLog(): string[];
  everythingShown(): string;
  dispose(): Promise<void>;
}

export async function setOperationMode(value: string | undefined): Promise<void> {
  await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', value, vscode.ConfigurationTarget.Global);
}

export async function openRemote(): Promise<UiStand & { readonly harness: RemoteHarness }> {
  const harness = new RemoteHarness();
  await harness.start();
  const workDir = path.join(harness.base, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  return {
    harness,
    folder: harness.folder,
    channel: harness.channel,
    emulator: harness.emulator,
    workDir,
    get lines() { return harness.lines; },
    get errors() { return harness.errors; },
    get infos() { return harness.infos; },
    get warnings() { return harness.warnings; },
    commandLog: () => harness.server.shellLog.flat().filter((line) => !line.startsWith('options set')),
    everythingShown: () => harness.everythingShown(),
    dispose: () => harness.dispose(),
  };
}

export async function openLocal(): Promise<UiStand & { readonly service: ServiceStand }> {
  const service = await createServiceStand('local');
  const lines: string[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const warnings: string[] = [];
  const saved: Record<string, unknown> = {};
  for (const key of ['showErrorMessage', 'showInformationMessage', 'showWarningMessage']) {
    saved[key] = windowRef[key];
  }
  windowRef.showErrorMessage = (message: string) => { errors.push(message); return Promise.resolve(undefined); };
  windowRef.showInformationMessage = (message: string) => { infos.push(message); return Promise.resolve(undefined); };
  windowRef.showWarningMessage = (message: string) => { warnings.push(message); return Promise.resolve(undefined); };
  await disposeCachedAgentOperationServices();
  await resetAgentSettings();
  await setAgentSetting('location', 'local');
  await setOperationMode('agent');
  const entry = { service: service.service, sessions: { disposeAll: () => Promise.resolve() } } as unknown as CachedAgentService;
  await ensureAgentService(service.projectRoot, () => Promise.resolve(entry));
  return {
    service,
    folder: { uri: vscode.Uri.file(service.projectRoot), name: 'ext-local', index: 0 },
    channel: { appendLine: (line: string) => { lines.push(line); } } as unknown as vscode.OutputChannel,
    emulator: service.emulator,
    workDir: service.workDir,
    lines, errors, infos, warnings,
    commandLog: () => service.commandLog(),
    everythingShown: () => [...lines, ...infos, ...warnings, ...errors].join('\n'),
    dispose: async () => {
      for (const key of Object.keys(saved)) {
        windowRef[key] = saved[key];
      }
      // Запись реестра подсеяна готовой: сервис закрывает стенд сам, реестр — только очищается.
      await disposeCachedAgentOperationServices().catch(() => undefined);
      await resetAgentSettings();
      await service.dispose();
    },
  };
}
