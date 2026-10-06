# Contributing to ternlatex

## Setup

You need [Bun](https://bun.sh) 1.4.2 or newer, and git.

```sh
bun install
bun src/cli.ts --help    # run from source (or: bun run ternlatex …)
```

## The Tern plugin

The repository is the Tern plugin package: `plugin.toml` at the root, its Luau files and `keys.json` in
`tern-plugin/`, so `tern plugin install github.com/f0t1h/tern-latex` installs it from a clone. From a
checkout, `bun src/cli.ts setup-tern` (and `dev` inside Tern) copies `plugin.toml` and `tern-plugin/` into
ternlatex's data folder (`~/Library/Application Support/ternlatex/tern-plugin` on macOS) and links that copy,
never the repository itself: Tern watches a linked folder, and `node_modules/` or `dist/` would keep
reloading it. After editing the Luau files, run `bun src/cli.ts setup-tern` again (or restart `dev`) to copy
the changes into Tern. A git checkout replaces a plugin installed from Tern with this link; an installed
package or a compiled ternlatex leaves an installed plugin alone.

A plugin Tern installed is a copy of the whole repository (minus `.git`), so it runs ternlatex from its own
folder: `bun --install=force <plugins>/ternlatex/src/cli.ts`. With no `node_modules` there, Bun fetches the
dependencies at the versions `package.json` pins into its own cache and writes nothing into the plugin
folder; `--install=force` keeps Bun from using a `node_modules` further up instead (a home folder's, say).
The plugin finds the user's Bun, runs `tern-config --json` once and keeps its answer in
`<plugin data>/config.json`. A ternlatex running from that folder (its `dev`, say) leaves the plugin as it
is and only writes that file. `install-cli` writes a `ternlatex` launcher for the plugin's **Add ternlatex
to PATH**.

To test that locally, install a plain copy of the working tree's files (what a clone has, without
`node_modules`):

```sh
mkdir -p /tmp/tl/ternlatex
git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf - | tar -xf - -C /tmp/tl/ternlatex
tern plugin unlink ternlatex && tern plugin install /tmp/tl/ternlatex
```

Afterwards, `tern plugin remove ternlatex`, delete `config.json` in the plugin's data folder, and run
`bun src/cli.ts setup-tern` to link the checkout again.

## Checks

```sh
bun test                 # unit tests
bunx tsc -p .            # type-check (or: bun run check)
```

CI (`.github/workflows/ci.yml`) type-checks, tests, compiles and smoke-tests the binary on macOS, Linux
and Windows. It also runs a plain copy of the tracked files with `bun --install=force` (as a plugin Tern
installed does), and installs the checkout as a Bun package (`bun pm pack`, then `bun add -g` into a
temporary `BUN_INSTALL`), to smoke-test ternlatex as users get it.

## Building

ternlatex ships as a Bun package; a compiled binary is only for local use (the build checks it embeds no
paths from this machine).

```sh
bun run build            # dist/ternlatex-<os>-<arch> for this machine
bun scripts/build.ts --target bun-linux-x64 --target bun-linux-arm64   # cross-compile
```

Targets: `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64`.
The build embeds the git-tracked viewer, templates, omp kit and Tern plugin, and pdf.js, into the
executable.

## Releasing

A release is a git tag; there are no release binaries.

1. Set the new version in `package.json` and `plugin.toml`. A test checks they agree.
2. Commit, tag the commit `v<version>`, and push the tag.
3. Create the GitHub release for the tag, with release notes only.

## Layout

- `src/`: CLI, builder, dev server, tool resolver, Tern integration.
- `viewer/`: the pdf.js viewer.
- `plugin.toml`, `tern-plugin/`: the Tern plugin.
- `templates/`: project templates.
- `agent/`: the omp kit (project rules and skills).
- `scripts/build.ts`: compiles a local binary.
- `test/`: tests and fixtures.
