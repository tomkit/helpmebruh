import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { defineDynamic, defineSkill } from "eve/skills";

import { inheritedSkillSources } from "../lib/plugins";
import { getSettings } from "../lib/settings";

async function filesFor(root: string, dir = root, out: Record<string, string> = {}, budget = { bytes: 0 }) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(root, path).split("/").length <= 3) await filesFor(root, path, out, budget);
    } else if (entry.isFile() && /\.(md|txt|json|ya?ml|ts|js|sh|py|css|html)$/i.test(entry.name)) {
      const size = (await stat(path)).size;
      if (size > 128_000 || budget.bytes + size > 512_000) continue;
      out[relative(root, path)] = await readFile(path, "utf8");
      budget.bytes += size;
    }
  }
  return out;
}

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (!getSettings().capabilities.inheritEnabled || ctx.session.auth.current?.attributes.role !== "owner") return null;
      const entries: Record<string, ReturnType<typeof defineSkill>> = {};
      for (const source of await inheritedSkillSources()) {
        const raw = await readFile(source.path, "utf8").catch(() => "");
        if (!raw || raw.length > 128_000) continue;
        const frontmatter = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
        const body = frontmatter ? raw.slice(frontmatter[0].length) : raw;
        const match = frontmatter?.[1].match(/^description:\s*(.+)$/m);
        const description = match?.[1] && match[1] !== "|" && match[1] !== ">"
          ? match[1].replace(/^['"]|['"]$/g, "")
          : body.split("\n").find(line => line.trim() && !line.startsWith("#"))?.trim().slice(0, 240) ?? `Instructions for ${source.id}`;
        const files = await filesFor(dirname(source.path));
        delete files["SKILL.md"];
        const key = source.id.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 100);
        entries[key] = defineSkill({ description, markdown: body, ...(Object.keys(files).length ? { files } : {}) });
      }
      return Object.keys(entries).length ? entries : null;
    },
  },
});
