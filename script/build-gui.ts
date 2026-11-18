/**
 * Builds `gui-experimental.cjs`, the bundle the desktop app evaluates in each window.
 *
 * ## Why Bun and not the Vite preset
 *
 * The SDK publishes an official preset, `gui()` from `@opencode/plugin/gui/vite`, and it is the
 * better tool when the plugin has its own `node_modules`. This plugin deliberately has none: its
 * `package.json` is parked as `package.json.disabled` so it cannot collide with the globally
 * installed copy, and adding a Vite + `vite-plugin-solid` tree beside it would be a second
 * dependency tree to keep in step with the app.
 *
 * Bun is already this plugin's runtime and test runner, so the build uses it and keeps the same
 * output shape the preset produces: one CommonJS file, every dynamic import inlined, and every
 * module the app shares left `require`d instead of copied.
 *
 * ## What stays external, and why it must
 *
 * The window host hands a bundle exactly the modules listed in `@opencode/plugin/gui/host`'s
 * `pluginSharedModules` and `pluginWindowModules`; requiring anything else throws. Those modules
 * must also stay external because they carry the app's own instances: a copied `solid-js` would
 * have its own owner/scheduler, and a copied `effect` would produce schema objects the host does
 * not recognize.
 *
 * The bundle therefore contains this plugin's code only: the panel, the keyboard mapping, the
 * screen renderer and the RPC contract.
 *
 * Run it with: `bun script/build-gui.ts`
 */
import path from "node:path"

/** Modules both processes of the app provide, from `packages/plugin/src/gui/modules.ts`. */
const shared = [
  "effect",
  "@opencode/plugin/gui",
  "@opencode/plugin/gui/main",
  "@opencode/plugin/rpc",
  "@opencode/client",
  "@opencode/client/effect",
]

/** Modules only a window provides. */
const windowOnly = [
  "solid-js",
  "solid-js/web",
  "solid-js/store",
  "@opencode/plugin/gui/file",
  "@opencode/plugin/gui/review",
  "@opencode/plugin/gui/browser",
  "@opencode/client/solid",
]

const plugin = path.resolve(import.meta.dir, "..")
const output = path.join(plugin, "gui-experimental.cjs")

const built = await Bun.build({
  entrypoints: [path.join(plugin, "src", "gui", "index.ts")],
  target: "browser",
  format: "cjs",
  // The app loads one file: no chunks to fetch, no second request to a path it does not serve.
  splitting: false,
  minify: false,
  sourcemap: "none",
  external: [...shared, ...windowOnly],
  naming: "gui-experimental.cjs",
  outdir: plugin,
})

if (!built.success) {
  for (const log of built.logs) console.error(String(log))
  throw new Error("gui-experimental.cjs was not built")
}

const file = Bun.file(output)
const code = await file.text()

// The host evaluates the bundle as CommonJS text and reads `module.exports.default`; a bundle that
// silently turned into an ES module would fail only at load time inside the app.
if (!code.includes("module.exports")) {
  throw new Error("the bundle is not CommonJS: it has no `module.exports`")
}

const required = [...code.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1] ?? "")
const unknown = [...new Set(required)].filter((name) => ![...shared, ...windowOnly].includes(name))
if (unknown.length > 0) {
  throw new Error(`the bundle requires modules the app does not provide: ${unknown.join(", ")}`)
}

console.log(
  [
    `built ${path.relative(process.cwd(), output)}`,
    `  ${code.length} bytes`,
    `  requires: ${[...new Set(required)].join(", ") || "(none)"}`,
  ].join("\n"),
)
