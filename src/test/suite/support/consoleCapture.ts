type ConsoleMethod = 'log' | 'error';

export interface ConsoleCapture {
  readonly log: string[];
  readonly error: string[];
  restore(): void;
}

/**
 * Перехват console.log/error. В Extension Host эти методы — свойства-аксессоры, и
 * простое присваивание молча игнорируется, поэтому подмена идёт через defineProperty
 * с возвратом исходного дескриптора в `restore`.
 */
export function captureConsole(): ConsoleCapture {
  const capture = { log: [] as string[], error: [] as string[] };
  const saved = new Map<ConsoleMethod, PropertyDescriptor | undefined>();
  for (const method of ['log', 'error'] as const) {
    saved.set(method, Object.getOwnPropertyDescriptor(console, method));
    Object.defineProperty(console, method, {
      value: (...items: unknown[]) => { capture[method].push(items.join(' ')); },
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }
  return {
    ...capture,
    restore: () => {
      for (const [method, descriptor] of saved) {
        if (descriptor) {
          Object.defineProperty(console, method, descriptor);
        }
      }
    },
  };
}
