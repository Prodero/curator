import fs from "node:fs/promises";
import path from "node:path";

/** Validate and retain the selected boundary; only CLI implicit discovery searches ancestors. */
export async function explicitProjectRoot(value: string): Promise<string> {
  if (!value.trim() || !path.isAbsolute(value)) throw new Error("Project root must be an absolute existing directory.");
  const root = path.resolve(value);
  if (!(await fs.stat(root).catch(() => null))?.isDirectory()) throw new Error("Project root is not an existing directory. Select an absolute existing directory.");
  // A new project inside a Git working tree would dirty that parent on init.
  // Existing nested Prodero projects and standalone Git/worktree roots retain their boundary.
  if (await fs.stat(path.join(root, ".git")).catch(() => null) || await fs.stat(path.join(root, ".prodero/config.json")).catch(() => null)) return root;
  let parent = path.dirname(root);
  while (true) {
    if (await fs.stat(path.join(parent, ".git")).catch(() => null)) {
      throw new Error("PRODERO_NESTED_ROOT: The selected directory is inside another Git repository and is not an initialized Prodero project. Select the intended repository root explicitly or create a standalone Git repository in the selected directory. The parent was not selected or changed.");
    }
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return root;
}

export async function cliProjectRoot(value?: string): Promise<string> {
  if (value !== undefined) return explicitProjectRoot(value);
  let current = process.cwd();
  while (true) {
    if (await fs.stat(path.join(current, ".git")).catch(() => null) || await fs.stat(path.join(current, ".prodero/config.json")).catch(() => null)) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("No project found. Use --root /absolute/project to select an existing directory explicitly.");
    current = parent;
  }
}
