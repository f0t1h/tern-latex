import { ensureTernPlugin, pluginConfig } from "../ternplugin.ts";

/**
 * Links (or updates) the ternlatex Tern plugin and reloads Tern's plugins; `dev` inside Tern does this by itself.
 * A plugin installed from Tern's Plugins page stays; this ternlatex is written into its data folder's config.
 */
export async function setupTern(): Promise<number> {
  const r = await ensureTernPlugin({ reload: true });
  for (const a of r.actions) console.log(a);
  if (r.warning) console.error(`ternlatex: warning: ${r.warning}`);
  console.log(`ternlatex Tern plugin ready (${r.dir})`);
  return 0;
}

/**
 * `tern-config [--json]`: how the Tern plugin runs this ternlatex (bin, ipc, version); creates the IPC directory.
 * A plugin Tern installed runs it from its own source and writes the JSON as it is to its data folder's
 * config.json, so it is the very text ternlatex writes there.
 */
export function ternConfig(json: boolean): number {
  const c = pluginConfig();
  console.log(json ? JSON.stringify(c, null, 2) : `bin      ${c.bin.join(" ")}\nipc      ${c.ipc}\nversion  ${c.version}`);
  return 0;
}
