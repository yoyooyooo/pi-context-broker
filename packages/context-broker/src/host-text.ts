import type { ExtensionAPI } from "./types";

export type HostTextComponent = { render(width: number): string[]; invalidate(): void };
export type HostTextConstructor = new (text: string, paddingX: number, paddingY: number) => HostTextComponent;

export async function hostTextComponent(api: ExtensionAPI): Promise<HostTextConstructor> {
  const host = api as ExtensionAPI & { pi?: { Text?: HostTextConstructor } };
  if (host.pi?.Text) return host.pi.Text;
  const packageName = "@earendil-works/pi-tui";
  // The optional TUI package is supplied by Pi; OMP uses its own host export.
  const tui = await import(packageName) as { Text: HostTextConstructor };
  return tui.Text;
}
