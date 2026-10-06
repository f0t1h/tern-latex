--!strict
-- Helpers both halves of the ternlatex plugin require: the install config
-- (which ternlatex to run), project lookup and the dev block's status
-- title.

local common = {}

-- The project marker `ternlatex` looks for when walking up from a directory.
local MARKER = "ternlatex.toml"

-- How the plugin runs ternlatex (what `ternlatex tern-config --json`
-- prints). Read from the package's `config.json`, which ternlatex writes
-- into packages it links (`ternlatex setup-tern`), else from the data
-- folder's: a package Tern installed is ternlatex's whole source and runs
-- it with Bun (common.cli); the window half writes that config.json from
-- `tern-config --json`, as does a ternlatex run from the package.
export type Config = {
	-- ternlatex's argv prefix: bun (with its flags) and src/cli.ts, or a compiled binary.
	bin: { string },
	-- Realpath of the directory ternlatex writes IPC requests into.
	ipc: string,
	version: string,
}

-- The data folder's config.json.
function common.data_config(): string
	return common.join(tern.plugin.data, "config.json")
end

-- The package's files don't change while it is loaded (a change reloads
-- it), so these are read once.
local from_source_cached: boolean? = nil
local version_cached: string? = nil

-- Whether this package runs ternlatex from its own source: one Tern
-- installed (a copy of the repo) holds `src/cli.ts`; a package ternlatex
-- links holds only the plugin.
function common.from_source(): boolean
	if from_source_cached == nil then
		from_source_cached = tern.fs.exists("src/cli.ts")
	end
	return from_source_cached :: boolean
end

-- This package's src/cli.ts (common.from_source).
function common.cli(): string
	return common.join(common.join(tern.plugin.dir, "src"), "cli.ts")
end

-- The manifest version: the ternlatex a source package is, and each version
-- shows its key hints once.
function common.version(): string
	if version_cached == nil then
		local ok, text = pcall(tern.fs.read, "plugin.toml", 64 * 1024)
		version_cached = if ok then string.match(text, '\nversion%s*=%s*"([^"]*)"') or "" else ""
	end
	return version_cached :: string
end

-- A Config from JSON text (config.json, `tern-config --json`), or nil and
-- what is wrong with it.
function common.parse_config(text: string): (Config?, string?)
	local decoded, data = pcall(tern.json.decode, text)
	if not decoded or type(data) ~= "table" then
		return nil, "not JSON"
	end
	local bin: { string } = {}
	if type(data.bin) == "table" then
		for _, part in data.bin do
			if type(part) ~= "string" then
				bin = {}
				break
			end
			table.insert(bin, part)
		end
	end
	if #bin == 0 or type(data.ipc) ~= "string" then
		return nil, "lacks bin or ipc"
	end
	return { bin = bin, ipc = data.ipc, version = tostring(data.version or "") }, nil
end

-- Whether `config` runs this source package's ternlatex: Bun and its
-- cli.ts (Windows paths compare case-insensitively), at the manifest's
-- version, with the dependencies installed beside it (a reinstalled package
-- of the same version has none until the setup runs again).
function common.runs_this(config: Config): boolean
	if #config.bin ~= 2 or not tern.fs.exists("node_modules") then
		return false
	end
	local cli, own = common.normalize(config.bin[2]), common.normalize(common.cli())
	if tern.runtime.os == "windows" then
		cli, own = string.lower(cli), string.lower(own)
	end
	return cli == own and config.version == common.version()
end

-- Why a source package has no config yet: the window half is still setting
-- it up, or could not (it tells the user why).
common.NOT_READY = "ternlatex is getting ready (its first run installs its dependencies with Bun); try again in a moment"

-- The install config, or nil and why it is unusable. Read on every call:
-- the data folder's copy changes under running VMs (the window half's
-- setup, `ternlatex dev`), and it is a few hundred bytes.
function common.config(): (Config?, string?)
	for _, file in { "config.json", common.data_config() } do
		if tern.fs.exists(file) then
			local ok, text = pcall(tern.fs.read, file, 64 * 1024)
			if not ok then
				return nil, "cannot read " .. file .. ": " .. tostring(text)
			end
			local config, why = common.parse_config(text)
			if common.from_source() then
				-- The data folder's config.json is a cache: another package or version wrote it.
				if config == nil or not common.runs_this(config :: Config) then
					return nil, common.NOT_READY
				end
			elseif config == nil then
				return nil, file .. " " .. tostring(why) .. ": run `ternlatex setup-tern`"
			end
			return config, nil
		end
	end
	if common.from_source() then
		return nil, common.NOT_READY
	end
	return nil, "ternlatex has not set this plugin up: run `ternlatex setup-tern`"
end

-- `{...bin, ...args}`: ternlatex never comes from PATH.
function common.argv(config: Config, args: { string }): { string }
	local argv = table.clone(config.bin)
	for _, a in args do
		table.insert(argv, a)
	end
	return argv
end

-- `path` with `/` separators and no trailing separator.
function common.normalize(path: string): string
	local clean = string.gsub(string.gsub(path, "\\", "/"), "/+$", "")
	if clean == "" then
		return "/"
	end
	return if string.match(clean, "^%a:$") then clean .. "/" else clean
end

-- The directory above `path`, nil at a root.
function common.parent(path: string): string?
	local dir = common.normalize(path)
	if dir == "/" or string.match(dir, "^%a:/$") then
		return nil
	end
	local up = string.match(dir, "^(.*)/[^/]*$")
	if up == nil then
		return nil
	end
	return if up == "" then "/" else common.normalize(up)
end

function common.basename(path: string): string
	return string.match(common.normalize(path), "([^/]+)$") or path
end

function common.join(dir: string, name: string): string
	return if string.sub(dir, -1) == "/" then dir .. name else dir .. "/" .. name
end

-- Whether `path` is `root` or below it.
function common.inside(path: string, root: string): boolean
	local p, r = common.normalize(path), common.normalize(root)
	return p == r or r == "/" or string.sub(p, 1, #r + 1) == r .. "/"
end

-- The project directory holding `path` (a file or directory): the nearest
-- one with a ternlatex.toml.
function common.project(path: string): string?
	if path == "" then
		return nil
	end
	local dir: string? = common.normalize(path)
	while dir do
		if tern.fs.exists(common.join(dir, MARKER)) then
			return dir
		end
		dir = common.parent(dir)
	end
	return nil
end

-- Title prefixes `ternlatex dev` sets (OSC 2) for each build state.
local STATES = {
	{ prefix = "⟳ ", state = "building", tone = "muted" },
	{ prefix = "✓ ", state = "ok", tone = "ok" },
	{ prefix = "✗ ", state = "failed", tone = "error" },
}
local NAME = "ternlatex · "

-- The dev state a pane title shows, nil for any other title.
function common.status(title: string): DevStatus?
	for _, s in STATES do
		if string.sub(title, 1, #s.prefix + #NAME) == s.prefix .. NAME then
			local text = string.sub(title, #s.prefix + 1)
			local rest = string.sub(text, #NAME + 1)
			local doc = string.match(rest, "^(.-) · ") or rest
			return { state = s.state, text = text, doc = doc, tone = s.tone }
		end
	end
	return nil
end

-- The first `n` non-empty lines of `text`.
function common.first_lines(text: string, n: number): string
	local out = {}
	for line in string.gmatch(text, "[^\r\n]+") do
		table.insert(out, line)
		if #out == n then
			break
		end
	end
	return table.concat(out, "\n")
end

-- What a finished ternlatex run printed, for a toast: stderr when it
-- failed (else stdout).
function common.outcome(result: ProcessResult): string
	if result.timed_out then
		return "ternlatex did not answer in time"
	end
	local text = if result.status ~= 0 and string.find(result.stderr, "%S") then result.stderr else result.stdout
	if not string.find(text, "%S") then
		text = result.stderr
	end
	return common.first_lines(text, 4)
end

return common
