declare module "@oh-my-pi/pi-coding-agent/config/registry" {
  export function lookup(id: string): {
    get(settings: unknown): unknown;
    override(settings: unknown, value: unknown): void;
  } | undefined;
}
