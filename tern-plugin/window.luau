--!strict
-- ternlatex, window half: the IPC route `ternlatex dev` drives (layout, ask
-- omp, click-to-source, viewers, review), the program (a package Tern
-- installed runs ternlatex from its own source with Bun), Start here / New
-- project / Copy path / Add to PATH / Uninstall, forward search and the other palette
-- commands (outline, citation picker, rewrite alternatives and PDF peek
-- blocks, keys from keys.json), the `ternlatex://` links those blocks open
-- (edits, and outline/review blocks "Open with" started), key hints, the
-- dev block's state (or why ternlatex is not usable) in the status line,
-- and Carly exports.

local common = require("./common")

local REVIEW = "ternlatex.review"
local OUTLINE = "ternlatex.outline"
local CITE = "ternlatex.cite"
local REWRITE = "ternlatex.rewrite"
local PEEK = "ternlatex.peek"
local SHOW_VIEWER = "plugin.ternlatex.show-viewer"
local GROUP = "ternlatex"
-- Default chords: cmd+alt+<key> on macOS, ctrl+alt+<key> elsewhere.
local MACOS = tern.runtime.os == "macos"
local CHORD = if MACOS then "cmd+alt+" else "ctrl+alt+"
-- How often the caret is sampled for a PDF peek.
local PEEK_MS = 300
-- Requests are a few hundred bytes; anything this large is not ours.
local MAX_REQUEST = 1024 * 1024
local CLI_TIMEOUT_MS = 120 * 1000

-- What `layout` built for a dev block, kept in `tern.kv` under `projects`
-- (keyed by the dev pane id as a string) for the other features.
type Project = {
	dev: number,
	dir: string,
	url: string,
	viewer: number?,
	editor: number?,
	agent: number?,
	-- Height of the tab in rows when it was laid out (the dev block's height while it was alone).
	rows: number?,
}

type Reply = { [string]: any }
type Done = (reply: Reply) -> ()

-- Ops answer through `done` (possibly from a later callback); raising
-- answers `{error}`.
type Op = (args: { [string]: any }, cx: WindowCx, done: Done) -> ()

local function ends(s: string, suffix: string): boolean
	return #s >= #suffix and string.sub(s, -#suffix) == suffix
end

local function number_arg(args: { [string]: any }, name: string): number
	local v = args[name]
	if type(v) ~= "number" then
		error(name .. " must be a block id", 0)
	end
	return v
end

local function string_arg(args: { [string]: any }, name: string): string
	local v = args[name]
	if type(v) ~= "string" or v == "" then
		error(name .. " must be a non-empty string", 0)
	end
	return v
end

---------------------------------------------------------------------------
-- Remembered projects

local function load_projects(): { [string]: Project }
	local ok, data = pcall(tern.kv.get, "projects")
	local out: { [string]: Project } = {}
	if not ok or type(data) ~= "table" then
		return out
	end
	for key, rec in data do
		if type(key) == "string" and type(rec) == "table" and type(rec.dir) == "string" and type(rec.url) == "string" then
			local dev = tonumber(key)
			if dev then
				out[key] = {
					dev = dev,
					dir = rec.dir,
					url = rec.url,
					viewer = if type(rec.viewer) == "number" then rec.viewer else nil,
					editor = if type(rec.editor) == "number" then rec.editor else nil,
					agent = if type(rec.agent) == "number" then rec.agent else nil,
					rows = if type(rec.rows) == "number" then rec.rows else nil,
				}
			end
		end
	end
	return out
end

-- Stores `rec`, replacing any earlier record of the same project.
local function remember(rec: Project)
	local all = load_projects()
	local out: { [string]: any } = {}
	for key, other in all do
		if other.dir ~= rec.dir and other.dev ~= rec.dev then
			out[key] = { dir = other.dir, url = other.url, viewer = other.viewer, editor = other.editor, agent = other.agent, rows = other.rows }
		end
	end
	out[tostring(rec.dev)] = { dir = rec.dir, url = rec.url, viewer = rec.viewer, editor = rec.editor, agent = rec.agent, rows = rec.rows }
	tern.kv.set("projects", out)
end

-- The pane `id` when it still exists in this window and is of `kind`.
local function live(cx: WindowCx, id: number?, kind: PaneKind?): PaneInfo?
	if id == nil then
		return nil
	end
	local p = cx.session:pane(id)
	if p == nil or (kind ~= nil and p.kind ~= kind) then
		return nil
	end
	return p
end

-- The project laid out in tab `tab`.
local function project_in_tab(cx: WindowCx, tab: number?): Project?
	if tab == nil then
		return nil
	end
	for _, rec in load_projects() do
		if cx.session:tab_of(rec.dev) == tab then
			return rec
		end
	end
	return nil
end

-- The project whose dev block is `dev`, else the one for `dir`.
local function project_for(cx: WindowCx, dev: number?, dir: string?): Project?
	local all = load_projects()
	if dev then
		local rec = all[tostring(dev)]
		if rec and (dir == nil or rec.dir == dir) then
			return rec
		end
	end
	if dir then
		for _, rec in all do
			if rec.dir == dir and live(cx, rec.dev) then
				return rec
			end
		end
	end
	return nil
end

local function focused_pane(cx: WindowCx): PaneInfo?
	local id = cx.session:focused()
	return if id then cx.session:pane(id) else nil
end

-- The project the focused pane belongs to: the one laid out in its tab,
-- else the one above its file or directory.
local function focused_project(cx: WindowCx): (string?, Project?)
	local pane = focused_pane(cx)
	if pane == nil then
		return nil, nil
	end
	local rec = project_in_tab(cx, pane.tab)
	if rec then
		return rec.dir, rec
	end
	local from = if pane.kind == "file" and pane.path then pane.path else pane.cwd
	local dir = if from then common.project(from) else nil
	return dir, if dir then project_for(cx, nil, dir) else nil
end

local function panes_in_tab(cx: WindowCx, tab: number): { PaneInfo }
	local out: { PaneInfo } = {}
	for _, p in cx.session:panes() do
		if p.tab == tab then
			table.insert(out, p)
		end
	end
	return out
end

---------------------------------------------------------------------------
-- Agents

-- The omp block running in `dir`, preferring one in `tab`; with `only_tab`,
-- one in `tab` or nil (the layout builds its own omp block rather than
-- borrow one the user opened in another tab). Tern lists more than omp as
-- agents (the dev block it started for Start ternlatex here was one), so a
-- block showing a ternlatex dev title never counts.
local function find_agent(cx: WindowCx, dir: string, tab: number?, only_tab: boolean?): AgentBlock?
	local best: AgentBlock? = nil
	for _, a in cx.agents:list() do
		local info = cx.session:pane(a.pane)
		local is_dev = info ~= nil and common.status(info.title) ~= nil
		if not is_dev and a.state ~= "exited" and type(a.cwd) == "string" and common.normalize(a.cwd) == dir then
			if tab and cx.session:tab_of(a.pane) == tab then
				return a
			end
			best = best or a
		end
	end
	return if only_tab then nil else best
end

local function agent_entry(cx: WindowCx, pane: number): AgentBlock?
	for _, a in cx.agents:list() do
		if a.pane == pane then
			return a
		end
	end
	return nil
end

---------------------------------------------------------------------------
-- Ops

local function origin_of(url: string): string
	return string.match(url, "^(%a[%w+.%-]*://[^/?#]+)") or url
end

-- Creating a block takes Tern longer than a window hook's 50 ms budget
-- (tens of milliseconds with Tern in front, a few hundred behind other
-- apps). The budget is checked only when Lua calls a function or loops, so
-- a creation that is the last thing a handler does completes: `create` runs
-- last here (callers return right after, calling nothing more), and
-- `after(block, why, c)` places, focuses and records it, or reports why it
-- failed, from a timer with a fresh budget.
local function create_last(create: () -> number?, after: (block: number?, why: any, c: WindowCx) -> ())
	local made: number? = nil
	local failed: any = nil
	tern.timer(0, function(c: WindowCx?)
		if c then
			after(made, failed, c)
		end
	end)
	local ok, result = pcall(create)
	if ok then
		made = result
	else
		failed = result
	end
end

---------------------------------------------------------------------------
-- Proportions: a short dev block, the rest to the editor and omp.

-- Text rows the dev block shows: enough for the latest build lines.
local DEV_ROWS = 5
-- Rows a block spends on its title bar and divider (measured in Tern on macOS: 3–4).
local BLOCK_CHROME = 4
-- The dev block's share of the column when the tab's height is unknown.
local DEV_SHARE = 0.17
-- The editor's share of what the dev block leaves to the editor and omp.
local EDITOR_SHARE = 0.6

-- The split holding `pane` as a direct child, and the side (1 or 2) it is on.
local function parent_split(node: TabTree, pane: number): (TabTree?, number?)
	for side = 1, 2 do
		local child = node[side]
		if child then
			if child.pane == pane then
				return node, side
			end
			local found, at = parent_split(child, pane)
			if found then
				return found, at
			end
		end
	end
	return nil, nil
end

-- `pane`'s current share of its split, the split's direction, and its side.
local function share_of(cx: WindowCx, tab: number, pane: number): (number?, string?, number?)
	local layout = cx.session:layout(tab)
	if layout == nil then
		return nil, nil, nil
	end
	local split, side = parent_split(layout.root, pane)
	if split == nil or side == nil or split.split == nil then
		return nil, nil, nil
	end
	local ratio = split.ratio or 0.5
	return if side == 1 then ratio else 1 - ratio, split.split, side
end

-- Moves the divider beside `pane` until the pane holds `share` of its split.
-- resize moves "about" N cells, so every step is measured and corrected.
local function set_share(cx: WindowCx, tab: number, pane: number, share: number)
	local per_cell = 1 / 36 -- a first guess at what one cell is worth; measured from then on
	for _ = 1, 6 do
		local now, split, side = share_of(cx, tab, pane)
		if now == nil or split == nil or side == nil then
			return
		end
		local gap = share - now
		local cells = if gap > 0 then math.floor(gap / per_cell + 0.5) else math.ceil(gap / per_cell - 0.5)
		if cells == 0 then
			return
		end
		local toward: Dir = if split == "down" then (if side == 1 then "down" else "up") else (if side == 1 then "right" else "left")
		if not cx.layout:resize(pane, toward, cells) then
			return
		end
		local after = share_of(cx, tab, pane)
		if after == nil or after == now then
			return
		end
		per_cell = math.abs(after - now) / math.abs(cells)
	end
end

-- Sizes a project's column: the dev block DEV_ROWS of text (or DEV_SHARE of
-- the column), the editor EDITOR_SHARE of the rest and omp the remainder.
local function proportion(cx: WindowCx, rec: Project)
	local editor = live(cx, rec.editor, "file")
	local tab = cx.session:tab_of(rec.dev)
	if editor == nil or tab == nil then
		return
	end
	local rows = rec.rows
	-- `rows` is the text height of a block filling the tab; the column also holds that block's chrome.
	local dev_share = if rows and rows > 0 then math.clamp((DEV_ROWS + BLOCK_CHROME) / (rows + BLOCK_CHROME), 0.08, 0.3) else DEV_SHARE
	if live(cx, rec.agent) then
		local editor_share = (1 - dev_share) * EDITOR_SHARE
		set_share(cx, tab, editor.pane, editor_share)
		-- The dev block now shares the rest with omp.
		set_share(cx, tab, rec.dev, dev_share / (1 - editor_share))
	else
		set_share(cx, tab, rec.dev, dev_share)
	end
end

-- The tab's layout:
-- editor | viewer
-- omp    |
-- dev    |
-- Creating a block takes longer than a window hook's 50 ms budget (browser,
-- file and shell blocks alike), so ternlatex creates them with the tern CLI
-- and this op only finds and places them. Each call places the blocks it is
-- given (`viewer`, `editor`, `agent`: just created by ternlatex), finds the
-- rest in the tab, and when something is still missing answers what
-- (`needsViewer`, `needsEditor`, `needsAgent`, with the blocks it found and
-- `tabRows`). ternlatex creates the viewer first (over the dev block, docked
-- right of it while the dev block is alone in its column), then the editor
-- (below the dev block) and omp (below the editor), calling again after
-- each step. An existing viewer is ternlatex's to navigate.
local function op_layout(args: { [string]: any }, cx: WindowCx, done: Done)
	local dev = number_arg(args, "devPane")
	local url = string_arg(args, "url")
	local dir = common.normalize(string_arg(args, "dir"))
	local root = string_arg(args, "root")
	local tab = cx.session:tab_of(dev)
	if tab == nil then
		error("block " .. dev .. " is not in this window", 0)
	end
	local new_viewer: number? = if type(args.viewer) == "number" then args.viewer else nil
	local new_editor: number? = if type(args.editor) == "number" then args.editor else nil
	local new_agent: number? = if type(args.agent) == "number" then args.agent else nil
	local created = new_viewer ~= nil or new_editor ~= nil or new_agent ~= nil

	local viewer, editor, agent = new_viewer, new_editor, new_agent
	local origin = origin_of(url)
	for _, p in panes_in_tab(cx, tab) do
		local at = p.url
		if new_viewer == nil and p.kind == "browser" and at and string.sub(at, 1, #origin) == origin then
			-- Popped-out viewers carry ?doc=; the main one does not.
			local main = if viewer then cx.session:pane(viewer :: number) else nil
			if main == nil or (string.find(main.url or "", "?doc=", 1, true) and not string.find(at, "?doc=", 1, true)) then
				viewer = p.pane
			end
		elseif editor == nil and p.kind == "file" and p.path == root then
			editor = p.pane
		end
	end
	if agent == nil then
		local found = find_agent(cx, dir, tab, true)
		agent = if found then found.pane else nil
	end
	-- Alone in its tab, the dev block is as tall as the tab: remember that for sizing.
	if type(args.tabRows) ~= "number" and #panes_in_tab(cx, tab) == 1 and type(args.rows) == "number" then
		args.tabRows = args.rows
	end
	if new_viewer then
		cx.layout:dock(new_viewer :: number, dev, "right")
	end
	if new_editor then
		cx.layout:move(new_editor :: number, dev, "up")
	end
	if new_agent then
		cx.layout:move(dev, new_agent :: number, "down")
	end
	if viewer == nil or editor == nil or agent == nil then
		done({
			needsViewer = viewer == nil,
			needsEditor = editor == nil,
			needsAgent = agent == nil,
			viewer = viewer,
			editor = editor,
			agent = agent,
			tabRows = args.tabRows,
		})
		return
	end
	for _, t in cx.session:tabs() do
		if t.id == tab and (t.name == nil or t.name == "" or t.name == common.basename(dir)) then
			cx.layout:name_tab(tab, common.basename(dir))
		end
	end
	if created then
		cx.layout:focus(editor :: number)
	end
	-- The tab's height: measured when dev started alone in it, else what the project had.
	local prior = project_for(cx, dev, dir)
	local rows = if type(args.tabRows) == "number" then args.tabRows else if prior then prior.rows else nil
	local rec: Project = { dev = dev, dir = dir, url = url, viewer = viewer :: number, editor = editor :: number, agent = agent, rows = rows }
	remember(rec)
	-- Only a layout built now is sized; one the user already arranged keeps its sizes.
	if created then
		proportion(cx, rec)
	end
	done({ viewer = viewer, editor = editor, agent = agent })
end

-- The project's live omp block (the one `layout` started, else one running
-- in `dir`), refusing one that cannot take prompts.
local function project_agent(args: { [string]: any }, cx: WindowCx): AgentBlock
	local dev = if type(args.devPane) == "number" then args.devPane else nil
	local dir = common.normalize(string_arg(args, "dir"))
	local rec = project_for(cx, dev, dir)
	local agent: AgentBlock? = nil
	if rec and rec.agent then
		local entry = agent_entry(cx, rec.agent)
		if entry and entry.state ~= "exited" then
			agent = entry
		end
	end
	agent = agent or find_agent(cx, dir, if dev then cx.session:tab_of(dev) else nil)
	if agent == nil then
		error("no omp block for this project; run ternlatex restart to bring it back", 0)
	end
	local found = agent :: AgentBlock
	if type(found.delivery_error) == "string" then
		error(found.delivery_error, 0)
	end
	return found
end

local function op_ask(args: { [string]: any }, cx: WindowCx, done: Done)
	local text = string_arg(args, "text")
	local target = project_agent(args, cx).pane
	cx.agents:ask(target, text)
	local after = agent_entry(cx, target)
	if after and type(after.delivery_error) == "string" then
		error(after.delivery_error, 0)
	end
	done({ agent = target })
end

-- Opens `path` (at `line`) for the viewer: focuses a block already showing
-- it, preferring the dev block's tab (`shown`); else shows it in the
-- project's editor block in place of what that block shows (`opened`), so a
-- trip from the PDF to the source doesn't pile up blocks; an editor with
-- unsaved edits keeps them and Tern opens a new block beside it. Without an
-- editor block it answers where ternlatex should open one with `tern open`
-- (a new file block takes longer than this hook's budget): `near`, the block
-- to split below, or above (`above`, its omp block), never the dev block or
-- the viewer; else nothing (a tab).
local function op_open(args: { [string]: any }, cx: WindowCx, done: Done)
	local dev = number_arg(args, "devPane")
	local path = string_arg(args, "path")
	local line = if type(args.line) == "number" then args.line else nil
	local tab = cx.session:tab_of(dev)
	local shown: PaneInfo? = nil
	for _, p in cx.session:panes() do
		if p.kind == "file" and p.path == path and (shown == nil or p.tab == tab) then
			shown = p
		end
	end
	if shown then
		done({ shown = shown.pane })
		return
	end
	local rec = project_for(cx, dev, nil)
	local editor: PaneInfo? = if rec then live(cx, rec.editor, "file") else nil
	if editor == nil and tab then
		for _, p in panes_in_tab(cx, tab) do
			if p.kind == "file" then
				editor = p
				break
			end
		end
	end
	if editor then
		cx.layout:focus(editor.pane)
		cx:open(if line then path .. "#L" .. line else path, "replace")
		local now = cx.session:focused()
		-- The editor is now the block showing `path` (the same one, or a new one beside an unsaved editor).
		if rec and now and editor.pane == rec.editor then
			rec.editor = now
			remember(rec)
		end
		done({ opened = true })
		return
	end
	local agent = if rec then live(cx, rec.agent) else nil
	done(if agent then { near = agent.pane, above = true } else {})
end

-- The main viewer of the dev block `dev`.
local function main_viewer(cx: WindowCx, dev: number?): PaneInfo?
	local rec = if dev then project_for(cx, dev, nil) else nil
	local viewer = if rec then live(cx, rec.viewer, "browser") else nil
	if viewer or dev == nil or rec == nil then
		return viewer
	end
	local tab = cx.session:tab_of(dev)
	local origin = origin_of(rec.url)
	for _, p in (if tab then panes_in_tab(cx, tab) else {}) do
		local at = p.url or ""
		if p.kind == "browser" and string.sub(at, 1, #origin) == origin and not string.find(at, "?doc=", 1, true) then
			return p
		end
	end
	return nil
end

-- A second viewer right of the main one (else of the dev block). Like
-- layout, it leaves the browser call to ternlatex: the reply names the block
-- to open it over (`needsViewer`, `owner`), and ternlatex asks again with
-- the block it opened (`pane`), docked here.
local function op_popout(args: { [string]: any }, cx: WindowCx, done: Done)
	local dev = number_arg(args, "devPane")
	local url = string_arg(args, "url")
	local owner = main_viewer(cx, dev)
	local anchor = if owner then owner.pane else dev
	if type(args.pane) == "number" then
		cx.layout:dock(args.pane, anchor, "right")
		done({ pane = args.pane })
		return
	end
	for _, p in cx.session:panes() do
		if p.kind == "browser" and p.url == url then
			cx.layout:focus(p.pane)
			done({ pane = p.pane })
			return
		end
	end
	done({ needsViewer = true, owner = anchor })
end

-- One `kind` block per project (pane ids by dir in `tern.kv` under `key`),
-- so a second request focuses the first.
local function project_block(cx: WindowCx, key: string, kind: string, dir: string): number?
	local ok, known = pcall(tern.kv.get, key)
	local existing = if ok and type(known) == "table" then known[dir] else nil
	if type(existing) == "number" then
		local p = cx.session:pane(existing)
		if p and p.block == kind then
			return existing
		end
	end
	return nil
end

local function remember_block(key: string, dir: string, pane: number)
	local ok, known = pcall(tern.kv.get, key)
	local all: { [string]: any } = if ok and type(known) == "table" then known else {}
	all[dir] = pane
	tern.kv.set(key, all)
end

local function host_block(pane: number?): number
	if pane == nil then
		error("the ternlatex plugin's host half is not loaded on this host", 0)
	end
	return pane :: number
end

-- The project's review block: below its viewer (else beside the focused
-- block). Callers return right after (create_last).
local function open_review(cx: WindowCx, dir: string, dev: number?)
	local existing = project_block(cx, "reviews", REVIEW, dir)
	if existing then
		cx.layout:focus(existing)
		return
	end
	local rec = project_for(cx, dev, dir)
	local viewer = if rec then live(cx, rec.viewer, "browser") else nil
	create_last(function(): number?
		return if viewer
			then cx.layout:split(viewer.pane, "down", { block = REVIEW, args = { dir }, cwd = dir })
			else cx:new_block(REVIEW, { dir }, "beside")
	end, function(block: number?, why: any, c: WindowCx)
		local ok, err = pcall(function()
			local pane = host_block(block)
			c.layout:focus(pane)
			remember_block("reviews", dir, pane)
		end)
		if not ok then
			c:toast("error", "Review did not open", tostring(why or err))
		end
	end)
end

-- The outline docks right of the editor column: the focused file block's,
-- else the project's editor. Callers return right after (create_last).
local function open_outline(cx: WindowCx, dir: string, rec: Project?)
	local existing = project_block(cx, "outlines", OUTLINE, dir)
	if existing then
		cx.layout:focus(existing)
		return
	end
	local focused = focused_pane(cx)
	local editor = if focused and focused.kind == "file" then focused elseif rec then live(cx, rec.editor, "file") else nil
	create_last(function(): number?
		return cx:new_block(OUTLINE, { dir }, "beside", { focus = false })
	end, function(block: number?, why: any, c: WindowCx)
		local ok, err = pcall(function()
			local pane = host_block(block)
			if editor and live(c, editor.pane, "file") then
				c.layout:move(pane, editor.pane, "right", { focus = false })
			end
			c.layout:focus(pane)
			remember_block("outlines", dir, pane)
		end)
		if not ok then
			c:toast("error", "Outline did not open", tostring(why or err))
		end
	end)
end

local OPS: { [string]: Op } = {
	layout = op_layout,
	ask = op_ask,
	open = op_open,
	popout = op_popout,
}

---------------------------------------------------------------------------
-- IPC route: ternlatex writes `<ipc>/<uuid>.ternlatex` and `tern open`s it.

local function write_reply(path: string, reply: Reply)
	if reply.error == nil then
		reply.ok = true
	end
	local ok, err = pcall(tern.fs.write, path, tern.json.encode(reply))
	if not ok then
		tern.log.error("ternlatex: cannot write reply", path, err)
	end
end

local function handle(req_path: string, ipc: string, cx: WindowCx)
	local text = tern.fs.read(req_path, MAX_REQUEST)
	pcall(tern.fs.remove, req_path)
	local data = tern.json.decode(text)
	if type(data) ~= "table" then
		error("request is not a JSON object", 0)
	end
	local reply = data.reply
	if type(reply) ~= "string" or not common.inside(reply, ipc) then
		error("request has no reply path inside the IPC directory", 0)
	end
	local reply_path = reply :: string
	local answered = false
	local function done(r: Reply)
		if not answered then
			answered = true
			write_reply(reply_path, r)
		end
	end
	local op = if type(data.op) == "string" then OPS[data.op] else nil
	local args = if type(data.args) == "table" then data.args else {}
	local ok, err = pcall(function()
		if op == nil then
			error("unknown op " .. tostring(data.op), 0)
		end
		op(args, cx, done)
	end)
	if not ok then
		done({ error = tostring(err) })
	end
end

tern.route.open(function(req: OpenRequest, cx: WindowCx): RouteDecision?
	if req.origin ~= "cli" or not ends(req.path, ".ternlatex") then
		return nil
	end
	local config = common.config()
	if config == nil or not common.inside(req.path, config.ipc) then
		return nil
	end
	local ok, err = pcall(handle, req.path, config.ipc, cx)
	if not ok then
		tern.log.error("ternlatex: IPC request failed", req.path, err)
	end
	return { handled = true }
end)

---------------------------------------------------------------------------
-- Commands

-- The editor commands' keys, titles and hints: `tern-plugin/keys.json` (paths
-- are relative to the package root), which ternlatex also shows in the
-- viewer's help. Cite is b and peek v because Tern's own
-- ⌘⌥C (SQLite copy name) and ⌘⌥P (Insert path) win over plugin binds.
type KeyDef = { id: string, key: string, title: string, hint: string }

local function load_keys(): { KeyDef }
	local out: { KeyDef } = {}
	local ok, data = pcall(function(): any
		return tern.json.decode(tern.fs.read("tern-plugin/keys.json", 64 * 1024))
	end)
	if not ok or type(data) ~= "table" or type(data.commands) ~= "table" then
		tern.log.error("ternlatex: keys.json is unreadable; editor commands have no keys", if ok then "bad shape" else data)
		return out
	end
	for _, c in data.commands do
		if type(c) == "table" and type(c.id) == "string" and type(c.key) == "string" and type(c.title) == "string" then
			table.insert(out, { id = c.id, key = c.key, title = c.title, hint = if type(c.hint) == "string" then c.hint else "" })
		end
	end
	return out
end

local KEYS = load_keys()

local function key_def(id: string): KeyDef?
	for _, def in KEYS do
		if def.id == id then
			return def
		end
	end
	return nil
end

-- How a chord reads to the user: ⌘⌥J on macOS, Ctrl+Alt+J elsewhere.
local function key_display(key: string): string
	return (if MACOS then "⌘⌥" else "Ctrl+Alt+") .. string.upper(key)
end

-- An editor command; `keyed` adds its title and chord from keys.json.
type Keyed = { id: string, icon: string, available: (cx: WindowCx) -> boolean, run: (cx: WindowCx) -> () }

local function keyed(c: Keyed): CommandDef
	local def = key_def(c.id)
	return {
		id = c.id,
		title = if def then def.title else c.id,
		icon = c.icon,
		group = GROUP,
		keys = if def then { CHORD .. def.key } else nil,
		available = c.available,
		run = c.run,
	}
end

---------------------------------------------------------------------------
-- Status line: the state of the dev block in the focused pane's tab, read
-- from its title, or, while ternlatex is not usable, why when the focused
-- block is in a project. The formatter only reads these tables.

type Segment = { text: string, tone: string }

local pane_tab: { [number]: number } = {}
local tab_dev: { [number]: Segment } = {}
-- The focused pane when it is in a ternlatex project, only while ternlatex is not usable.
local pane_missing: { [number]: boolean } = {}
local signature = ""
-- While this source package has no usable ternlatex (set by recheck): the
-- segment saying why and the command that helps.
type Unusable = { text: string, tone: string, command: string }
local unusable: Unusable? = nil
-- Whether a directory is in a ternlatex project, while ternlatex is not
-- usable: a lookup walks up to the root, too slow for every title change
-- (recheck starts it afresh).
local dir_in_project: { [string]: boolean } = {}

local function rescan(cx: WindowCx)
	local tabs: { [number]: number } = {}
	local devs: { [number]: Segment } = {}
	local missing: { [number]: boolean } = {}
	local focused = if unusable then cx.session:focused() else nil
	local sig: { string } = {}
	for _, p in cx.session:panes() do
		local tab = p.tab
		if tab then
			tabs[p.pane] = tab
			table.insert(sig, p.pane .. ":" .. tab)
			local status = common.status(p.title)
			if status and devs[tab] == nil then
				devs[tab] = { text = status.text, tone = status.tone }
				table.insert(sig, status.tone .. status.text)
			end
		end
		if p.pane == focused then
			local path = p.path
			local dir = if p.kind == "file" and path then common.parent(path :: string) else p.cwd
			if dir and dir ~= "" then
				local known = dir_in_project[dir]
				if known == nil then
					known = common.project(dir) ~= nil
					dir_in_project[dir] = known
				end
				if known then
					missing[p.pane] = true
					table.insert(sig, "!" .. p.pane .. (unusable :: Unusable).text)
				end
			end
		end
	end
	local now = table.concat(sig, "\n")
	pane_tab, tab_dev, pane_missing = tabs, devs, missing
	if now ~= signature then
		signature = now
		tern.chrome.refresh()
	end
end

---------------------------------------------------------------------------
-- The program: the ternlatex the plugin runs (common.config). A package
-- ternlatex linked names it in its own config.json. A package Tern
-- installed is ternlatex's whole source (common.from_source): the window
-- half finds the user's Bun once per VM, installs the dependencies bun.lock
-- pins into the package's node_modules (`bun install --frozen-lockfile
-- --production`; Bun's auto-install would take whatever versions its cache
-- has), and asks that ternlatex for its config (`tern-config --json`: the
-- IPC dir and version), which it keeps in the data folder's config.json for
-- both halves; commands that need the program wait for it.

type Ready = (config: common.Config?, err: string?, cx: WindowCx) -> ()

local IOS = tern.runtime.os == "ios"
local WINDOWS = tern.runtime.os == "windows"
-- kv: the Bun the last setup found, and the launcher Add ternlatex to PATH wrote.
local BUN_KEY = "bun"
local LAUNCHER_KEY = "launcher"
-- The first run fetches ternlatex's dependencies.
local SETUP_TIMEOUT_MS = 5 * 60 * 1000
local SHELL_TIMEOUT_MS = 30 * 1000
-- Why setup failed when no Bun was found; not_installed shows it with NO_BUN_HINT.
local NO_BUN = "ternlatex needs Bun"
local NO_BUN_HINT = "Palette: Install Bun"

-- The config when its program (Bun or a compiled ternlatex) and its last
-- part (cli.ts or that binary) exist, else nil and why.
local function program(): (common.Config?, string?)
	local config, why = common.config()
	if config == nil then
		return nil, why
	end
	for _, part in { config.bin[1], config.bin[#config.bin] } do
		if not tern.fs.exists(part) then
			return nil, part .. " is gone"
		end
	end
	return config, nil
end

local resolving = false
local waiters: { Ready } = {}
-- Why the last setup failed, nil after one succeeded.
local setup_error: string? = nil

-- Updates whether ternlatex is usable and the status line.
local function recheck(cx: WindowCx)
	local now: Unusable? = nil
	if not IOS and common.from_source() and program() == nil then
		if resolving then
			now = { text = "ternlatex getting ready…", tone = "muted", command = "plugin.ternlatex.start" }
		elseif setup_error == NO_BUN then
			now = { text = NO_BUN, tone = "error", command = "plugin.ternlatex.install-bun" }
		else
			now = { text = "ternlatex not ready", tone = "error", command = "plugin.ternlatex.start" }
		end
	end
	unusable = now
	dir_in_project = {}
	rescan(cx)
end

-- `argv` as one command line for the user's shell (like ternlatex's
-- shellLine): single quotes, cmd.exe double quotes on Windows.
local function shell_line(argv: { string }): string
	local out: { string } = {}
	for _, a in argv do
		if WINDOWS then
			table.insert(out, '"' .. string.gsub(a, '"', '""') .. '"')
		else
			table.insert(out, "'" .. string.gsub(a, "'", "'\\''") .. "'")
		end
	end
	return table.concat(out, " ")
end

local function native(path: string): string
	return if WINDOWS then (string.gsub(path, "/", "\\")) else path
end

-- The user's home directory: HOME, else (Windows) USERPROFILE.
local function home(): string?
	local h = tern.getenv("HOME")
	if h == nil or h == "" then
		h = tern.getenv("USERPROFILE")
	end
	return if h == nil or h == "" then nil else h
end

-- The user's login shell (SHELL, else sh); not on Windows.
local function login_shell(): string
	local shell = tern.getenv("SHELL")
	return if shell and shell ~= "" then shell else "sh"
end

-- Bun, in order: the one found before (kv), then where Bun's installer and
-- package managers put it: $BUN_INSTALL/bin, ~/.bun/bin, Homebrew's and
-- /usr/local's bin. Tern's daemon runs plugins with a bare PATH, so PATH is
-- no help.
local function bun_candidates(): { string }
	local exe = if WINDOWS then "bun.exe" else "bun"
	local out: { string } = {}
	local ok, kept = pcall(tern.kv.get, BUN_KEY)
	if ok and type(kept) == "string" and kept ~= "" then
		table.insert(out, kept)
	end
	local install = tern.getenv("BUN_INSTALL")
	if install and install ~= "" then
		table.insert(out, common.join(common.join(install, "bin"), exe))
	end
	local h = home()
	if h then
		table.insert(out, common.join(common.join(common.join(h, ".bun"), "bin"), exe))
	end
	if not WINDOWS then
		table.insert(out, "/opt/homebrew/bin/bun")
		table.insert(out, "/usr/local/bin/bun")
	end
	return out
end

-- Calls `next` with the user's Bun: the first bun_candidates entry that
-- exists, else what the login shell finds (`command -v bun`; `where bun`
-- on Windows), else nil. A found Bun is kept in kv.
local function find_bun(cx: WindowCx, next: (string?, WindowCx) -> ())
	local function found(path: string, c: WindowCx)
		pcall(tern.kv.set, BUN_KEY, path)
		next(native(path), c)
	end
	for _, path in bun_candidates() do
		if tern.fs.exists(path) then
			found(path, cx)
			return
		end
	end
	local argv = if WINDOWS then { "where", "bun" } else { login_shell(), "-lc", "command -v bun" }
	local ok = pcall(function()
		tern.process.run(argv, { timeout_ms = SHELL_TIMEOUT_MS }, function(result, fresh)
			local c = fresh :: WindowCx
			if result.status == 0 then
				-- Login scripts may print first; take the first line that is an existing absolute path.
				for line in string.gmatch(result.stdout, "[^\r\n]+") do
					local path = string.match(line, "^%s*(.-)%s*$") or ""
					if (string.sub(path, 1, 1) == "/" or string.match(path, "^%a:[\\/]")) and tern.fs.exists(path) then
						found(path, c)
						return
					end
				end
			end
			next(nil, c)
		end)
	end)
	if not ok then
		next(nil, cx)
	end
end

-- Ends a setup: keeps why it failed (or clears it), updates the status
-- line, and answers every waiter.
local function finish(config: common.Config?, err: string?, cx: WindowCx)
	resolving = false
	setup_error = if config then nil else err or common.NOT_READY
	if err then
		tern.log.warn("ternlatex: setup failed", err)
	end
	local ok, e = pcall(recheck, cx)
	if not ok then
		tern.log.error("ternlatex: after the setup", e)
	end
	-- Each waiter from its own timer: one may create a block, which must be
	-- the last thing its call does (create_last).
	for _, ready in waiters do
		tern.timer(0, function(c: WindowCx?)
			local done, failed = pcall(ready, config, err, c or cx)
			if not done then
				tern.log.error("ternlatex: after the setup", failed)
			end
		end)
	end
	waiters = {}
end

-- The config a finished `tern-config --json` printed, after checking it is
-- this package's ternlatex; errors say why not.
local function printed_config(result: ProcessResult): common.Config
	if result.status ~= 0 then
		local text = if result.timed_out then "timed out" else common.first_lines(if string.find(result.stderr, "%S") then result.stderr else result.stdout, 3)
		error(text, 0)
	end
	local config, bad = common.parse_config(result.stdout)
	if config == nil then
		error("tern-config printed something else (" .. tostring(bad) .. ")", 0)
	end
	local c = config :: common.Config
	if not common.runs_this(c) then
		error("tern-config named " .. c.bin[#c.bin] .. " " .. c.version .. ", not " .. common.cli() .. " " .. common.version(), 0)
	end
	return c
end

-- Finds Bun, installs the dependencies, runs this package's ternlatex for
-- its config and writes the data folder's config.json.
local function set_up(cx: WindowCx)
	find_bun(cx, function(found: string?, c: WindowCx)
		if found == nil then
			finish(nil, NO_BUN, c)
			return
		end
		local bun = found :: string
		local function configure(c1: WindowCx)
			local argv = { bun, native(common.cli()), "tern-config", "--json" }
			tern.process.run(argv, { timeout_ms = SETUP_TIMEOUT_MS }, function(result, fresh)
				local c2 = fresh :: WindowCx
				local got, config = pcall(function(): common.Config
					local printed = printed_config(result)
					tern.fs.write(common.data_config(), result.stdout)
					return printed
				end)
				if got then
					finish(config, nil, c2)
				else
					finish(nil, "ternlatex did not run: " .. tostring(config), c2)
				end
			end)
		end
		local ok, err = pcall(function()
			local install = { bun, "install", "--frozen-lockfile", "--production" }
			tern.process.run(install, { cwd = native(tern.plugin.dir), timeout_ms = SETUP_TIMEOUT_MS }, function(result, fresh)
				local c1 = fresh :: WindowCx
				if result.status ~= 0 then
					local text = if result.timed_out then "timed out" else common.first_lines(if string.find(result.stderr, "%S") then result.stderr else result.stdout, 3)
					finish(nil, "installing ternlatex's dependencies failed: " .. text, c1)
					return
				end
				local ran, failed = pcall(configure, c1)
				if not ran then
					finish(nil, "ternlatex did not run: " .. tostring(failed), c1)
				end
			end)
		end)
		if not ok then
			finish(nil, "installing ternlatex's dependencies failed: " .. tostring(err), c)
		end
	end)
end

-- Calls `ready` with a usable config: at once when there is one, else, in a
-- source package, after the setup. Otherwise `ready` gets why.
local function with_program(cx: WindowCx, ready: Ready)
	local config, why = program()
	if config then
		ready(config, nil, cx)
		return
	end
	if IOS then
		ready(nil, "ternlatex runs on desktop Tern only", cx)
		return
	end
	if not common.from_source() then
		ready(nil, why, cx)
		return
	end
	table.insert(waiters, ready)
	if not resolving then
		resolving = true
		pcall(recheck, cx)
		local ok, err = pcall(set_up, cx)
		if not ok then
			finish(nil, tostring(err), cx)
		end
	end
end

-- Tells the user `what` failed because ternlatex is not usable (`err`);
-- without Bun, how to get it instead.
local function not_installed(cx: WindowCx, what: string, err: string?)
	if err == NO_BUN then
		cx:toast("error", NO_BUN, NO_BUN_HINT)
		return
	end
	cx:toast("error", what, err or common.NOT_READY)
end

-- Runs `ternlatex args…` in `cwd`, after the setup when this source package
-- needs it; `done` gets the result and a fresh cx (a failed result when no
-- ternlatex could be had; without Bun, the user is told how to get it
-- instead). Returns why it could not start.
local function run_cli(cx: WindowCx, args: { string }, cwd: string, done: (ProcessResult, WindowCx) -> ()): string?
	local function launch(config: common.Config): string?
		local ok, err = pcall(function()
			tern.process.run(common.argv(config, args), { cwd = cwd, timeout_ms = CLI_TIMEOUT_MS }, function(result, fresh)
				done(result, fresh :: WindowCx)
			end)
		end)
		return if ok then nil else tostring(err)
	end
	local config, why = program()
	if config then
		return launch(config)
	end
	if IOS or not common.from_source() then
		return why
	end
	with_program(cx, function(got: common.Config?, err: string?, c: WindowCx)
		if err == NO_BUN then
			not_installed(c, "", err)
			return
		end
		local failed = if got then launch(got) else err or common.NOT_READY
		if failed then
			done({ status = -1, stdout = "", stderr = failed, timed_out = false }, c)
		end
	end)
	return nil
end

local function toast_result(cx: WindowCx, result: ProcessResult, ok_text: string, fail_text: string)
	if result.status == 0 then
		cx:toast("success", ok_text, common.outcome(result))
	else
		cx:toast("error", fail_text, common.outcome(result))
	end
end

type Spot = { line: number, col: number }

local function spot(v: any): Spot?
	if type(v) == "table" and type(v.line) == "number" and type(v.col) == "number" then
		return { line = v.line, col = v.col }
	end
	return nil
end

-- The focused `.tex` file block and its project; nil for anything else.
local function focused_tex(cx: WindowCx): (PaneInfo?, string?)
	local pane = focused_pane(cx)
	local path = if pane and pane.kind == "file" then pane.path else nil
	if pane == nil or path == nil or not ends(path, ".tex") then
		return nil, nil
	end
	local dir = common.project(path)
	if dir == nil then
		return nil, nil
	end
	return pane, dir
end

-- The caret of file block `pane`, and its selection as 0-based byte offsets
-- into the document (`anchor`/`head` of the read, ordered) when one shows.
local function caret(cx: WindowCx, pane: number): (Spot, number?, number?)
	local read: any = cx.session:read(pane, { lines = 1 })
	if type(read) ~= "table" or read.kind ~= "file" then
		return { line = 1, col = 1 }, nil, nil
	end
	local at = spot(read.caret) or { line = 1, col = 1 }
	local sel = read.selection
	if type(sel) ~= "table" or type(sel.anchor) ~= "number" or type(sel.head) ~= "number" or sel.anchor == sel.head then
		return at, nil, nil
	end
	return at, math.min(sel.anchor, sel.head), math.max(sel.anchor, sel.head)
end

-- The 1-based line and column (Unicode characters) of 0-based byte
-- `offset` in `text`.
local function spot_at(text: string, offset: number): Spot
	local before = string.sub(text, 1, offset)
	local _, newlines = string.gsub(before, "\n", "")
	local start = (string.match(before, "^.*()\n") or 0) + 1
	local col = utf8.len(string.sub(before, start)) or #before - start + 1
	return { line = newlines + 1, col = col + 1 }
end

local function not_tex(cx: WindowCx, what: string)
	cx:toast("error", what .. " needs a .tex file block", "Focus a .tex file of a ternlatex project (ternlatex.toml above it).")
end

-- Forward search: the PDF spot of the caret's line in the live viewer.
local function show_in_pdf(cx: WindowCx)
	local pane = focused_pane(cx)
	local path = if pane and pane.kind == "file" then pane.path else nil
	if pane == nil or path == nil then
		not_tex(cx, "Show in PDF")
		return
	end
	local line = caret(cx, pane.pane).line
	local file = path :: string
	local err = run_cli(cx, { "show", file .. ":" .. line }, common.parent(file) or file, function(result, c)
		if result.status ~= 0 then
			c:toast("error", "Show in PDF failed", common.outcome(result))
		end
	end)
	if err then
		cx:toast("error", "Show in PDF failed", err)
	end
end

tern.command(keyed({
	id = "show-in-pdf",
	icon = "file",
	available = function(cx: WindowCx): boolean
		local pane = focused_pane(cx)
		return pane ~= nil and pane.kind == "file" and pane.path ~= nil and ends(pane.path :: string, ".tex")
	end,
	run = show_in_pdf,
}))

-- `available` runs under a 4 ms budget whenever Tern builds the palette or checks a key, so it only looks at the
-- focused block (no ternlatex.toml walk, which can be slow on network or synced folders); `run` checks the
-- project and says so when there is none.
local function tex_available(cx: WindowCx): boolean
	local pane = focused_pane(cx)
	return pane ~= nil and pane.kind == "file" and pane.path ~= nil and ends(pane.path :: string, ".tex")
end

-- Opens host block `kind` docked below editor `under`, sharing its height, and focuses it; `what` titles the
-- toast when it does not open. Rewrite uses it: its alternatives need more room than a picture in picture,
-- which Tern gives plugins no way to size. Callers return right after (create_last).
local function dock_below(cx: WindowCx, kind: string, args: { string }, under: number, what: string)
	create_last(function(): number?
		return cx:new_block(kind, args, "beside", { focus = false })
	end, function(block: number?, why: any, c: WindowCx)
		local ok, err = pcall(function()
			local pane = host_block(block)
			if not c.layout:move(pane, under, "down", { focus = true }) then
				c.layout:close(pane)
				error("the block did not move below the editor", 0)
			end
			c.layout:focus(pane)
		end)
		if not ok then
			c:toast("error", what, tostring(why or err))
		end
	end)
end

-- Opens host block `kind` floating at `corner` over editor `over`; `what`
-- titles the toast when it does not. Callers return right after
-- (create_last).
local function float_block(cx: WindowCx, kind: string, args: { string }, over: number, corner: Corner, focus: boolean, what: string)
	create_last(function(): number?
		return cx:new_block(kind, args, "beside", { focus = false })
	end, function(block: number?, why: any, c: WindowCx)
		local ok, err = pcall(function()
			local pane = host_block(block)
			local floated, refused = c.layout:float(pane, over, corner, { focus = focus })
			if not floated then
				c.layout:close(pane)
				error(refused or "the block did not float", 0)
			end
			if focus then
				c.layout:focus(pane)
			end
		end)
		if not ok then
			c:toast("error", what, tostring(why or err))
		end
	end)
end

tern.command(keyed({
	id = "outline",
	icon = "list",
	-- Any block may be in a project; run() looks for it (see tex_available).
	available = function(cx: WindowCx): boolean
		return focused_pane(cx) ~= nil
	end,
	run = function(cx: WindowCx)
		local dir, rec = focused_project(cx)
		if dir == nil then
			cx:toast("error", "Not in a ternlatex project", "No ternlatex.toml above the focused block.")
			return
		end
		local ok, err = pcall(open_outline, cx, dir :: string, rec)
		if not ok then
			cx:toast("error", "Outline did not open", tostring(err))
		end
	end,
}))

tern.command(keyed({
	id = "cite",
	icon = "book",
	available = tex_available,
	run = function(cx: WindowCx)
		local pane, dir = focused_tex(cx)
		if pane == nil or dir == nil then
			not_tex(cx, "Insert citation")
			return
		end
		local at = caret(cx, pane.pane)
		local args = { dir, pane.path or "", tostring(at.line), tostring(at.col), tostring(pane.pane) }
		float_block(cx, CITE, args, pane.pane, "br", true, "Insert citation did not open")
	end,
}))

tern.command(keyed({
	id = "rewrite",
	icon = "sparkle",
	available = tex_available,
	run = function(cx: WindowCx)
		local pane, dir = focused_tex(cx)
		if pane == nil or dir == nil then
			not_tex(cx, "Rewrite sentence")
			return
		end
		local editor = pane.pane
		local path = pane.path or ""
		local function open(c: WindowCx, from: Spot, to: Spot?)
			local args = {
				dir :: string,
				path,
				tostring(from.line),
				tostring(from.col),
				if to then tostring(to.line) else "",
				if to then tostring(to.col) else "",
				tostring(editor),
			}
			dock_below(c, REWRITE, args, editor, "Rewrite sentence did not open")
		end
		-- The CLI reads the file from disk: save unsaved edits first so the sentence matches the buffer.
		cx.docs:save(path):next(function(_saved, save_err, c0)
			local cx1 = c0 :: WindowCx
			if save_err then
				cx1:toast("error", "Rewrite sentence did not open", "could not save " .. path .. ": " .. tostring(save_err))
				return
			end
			local at, a, b = caret(cx1, editor)
			if a == nil or b == nil then
				open(cx1, at, nil)
				return
			end
			-- The selection comes as byte offsets: place them in the live text.
			cx1.docs:read(path):next(function(text, err, c)
				local fresh = c :: WindowCx
				if err or type(text) ~= "string" then
					fresh:toast("error", "Rewrite sentence did not open", err or ("cannot read " .. path))
					return
				end
				open(fresh, spot_at(text, a :: number), spot_at(text, b :: number))
			end)
		end)
	end,
}))

---------------------------------------------------------------------------
-- PDF peek: while a peek block is open in this window, the focused `.tex`
-- block's caret goes to `tern.kv` key `peek` for it to follow.

local peek_timer: TimerHandle? = nil
-- The `path:line` last stored.
local peek_at = ""

local function peek_blocks(cx: WindowCx, tab: number?): { number }
	local out: { number } = {}
	for _, p in cx.session:panes() do
		if p.block == PEEK and (tab == nil or p.tab == tab) then
			table.insert(out, p.pane)
		end
	end
	return out
end

local function peek_follow(cx: WindowCx)
	local pane = focused_pane(cx)
	local path = if pane and pane.kind == "file" then pane.path else nil
	if pane == nil or path == nil or not ends(path, ".tex") then
		return
	end
	local line = caret(cx, pane.pane).line
	local key = path .. ":" .. line
	if key ~= peek_at then
		peek_at = key
		local ok, err = pcall(tern.kv.set, "peek", { path = path, line = line })
		if not ok then
			tern.log.warn("ternlatex: cannot store the peek position", err)
		end
	end
end

-- Samples the caret every PEEK_MS until no peek block is left.
local function peek_schedule()
	if peek_timer then
		return
	end
	peek_timer = tern.timer(PEEK_MS, function(c: WindowCx?)
		peek_timer = nil
		if c and #peek_blocks(c, nil) > 0 then
			peek_follow(c)
			peek_schedule()
		end
	end)
end

tern.command(keyed({
	id = "peek",
	icon = "eye",
	available = tex_available,
	run = function(cx: WindowCx)
		local pane, dir = focused_tex(cx)
		if pane == nil or dir == nil then
			not_tex(cx, "PDF peek")
			return
		end
		local open = peek_blocks(cx, pane.tab)
		if #open > 0 then
			for _, p in open do
				cx.layout:close(p)
			end
			return
		end
		peek_at = ""
		peek_follow(cx)
		peek_schedule()
		float_block(cx, PEEK, { dir }, pane.pane, "tr", false, "PDF peek did not open")
	end,
}))

---------------------------------------------------------------------------
-- Edits from the cite and rewrite blocks: `ternlatex://insert/<id>` and
-- `ternlatex://replace/<id>`, each with its `<ipc>/<id>.json`, applied to the
-- live buffer (unsaved edits and undo kept).

local EDIT_FAILED: { [string]: string } = {
	insert = "Citation not inserted",
	replace = "Sentence not replaced",
}

-- The byte offset in `text` of 1-based `line`:`col` (Unicode characters),
-- clamped to the line's end; nil past the last line.
local function offset_of(text: string, line: number, col: number): number?
	local start = 1
	for _ = 2, line do
		local nl = string.find(text, "\n", start, true)
		if nl == nil then
			return nil
		end
		start = nl + 1
	end
	local stop = string.find(text, "\n", start, true) or (#text + 1)
	if stop > start and string.sub(text, stop - 1, stop - 1) == "\r" then
		stop -= 1
	end
	local at = utf8.offset(string.sub(text, start, stop - 1), math.max(1, col))
	if at == nil or start + at - 1 > stop then
		return stop
	end
	return start + at - 1
end

-- The line holding byte `offset`.
local function line_at(text: string, offset: number): number
	local _, newlines = string.gsub(string.sub(text, 1, offset - 1), "\n", "")
	return newlines + 1
end

-- `text` with the edit applied, and the line to show; nil and why when it
-- cannot apply.
local function apply(verb: string, edit: { [string]: any }, text: string): (string?, number | string)
	local new = edit.text
	if verb == "insert" then
		local at = spot(edit)
		local offset = if at then offset_of(text, at.line, at.col) else nil
		if at == nil or offset == nil then
			return nil, "the caret's line is gone"
		end
		return string.sub(text, 1, offset - 1) .. new .. string.sub(text, offset), at.line
	end
	local expect = edit.expect
	if type(expect) ~= "string" or expect == "" then
		return nil, "the edit request has no original text"
	end
	local from, to = spot(edit.from), spot(edit.to)
	local a = if from then offset_of(text, from.line, from.col) else nil
	local b = if to then offset_of(text, to.line, to.col) else nil
	if a == nil or b == nil or string.sub(text, a, b - 1) ~= expect then
		-- The text moved: a unique occurrence will do.
		a = string.find(text, expect, 1, true)
		if a == nil or string.find(text, expect, a + 1, true) then
			return nil, "the sentence changed; rewrite again"
		end
		b = a + #expect
	end
	local start, stop = a :: number, b :: number
	return string.sub(text, 1, start - 1) .. new .. string.sub(text, stop), line_at(text, start)
end

-- Closes the picture-in-picture block `pip` (when it is one of ours) and
-- shows `path` at `line` in the editor it floated over (else any block
-- showing `path`).
local function reveal(cx: WindowCx, path: string, line: number, pip: number?)
	local tab = if pip then cx.session:tab_of(pip) else nil
	local layout = if tab then cx.session:layout(tab) else nil
	local over: number? = nil
	for _, f in (if layout then layout.floats else {}) do
		if f.pane == pip then
			over = f.over
		end
	end
	local p = if pip then cx.session:pane(pip) else nil
	if p and (p.block == CITE or p.block == REWRITE) then
		cx.layout:close(p.pane)
	end
	local editor = live(cx, over, "file")
	if editor == nil or editor.path ~= path then
		editor = nil
		for _, q in cx.session:panes() do
			if q.kind == "file" and q.path == path and (editor == nil or q.tab == tab) then
				editor = q
			end
		end
	end
	if editor then
		cx.layout:focus(editor.pane)
	end
	cx.docs:open(path, { how = "default", line = line })
end

-- Reads and deletes the request file of link `id`.
local function read_link(id: string): { [string]: any }
	local config, why = common.config()
	if config == nil then
		error(why, 0)
	end
	local file = common.join(config.ipc, id .. ".json")
	local ok, raw = pcall(tern.fs.read, file, MAX_REQUEST)
	if not ok then
		error("this link carries no request (used already, or not from ternlatex)", 0)
	end
	pcall(tern.fs.remove, file)
	local decoded, data = pcall(tern.json.decode, raw)
	if not decoded or type(data) ~= "table" then
		error("the request is malformed", 0)
	end
	return data
end

-- Reads the edit file of link `id`, then applies it.
local function edit_link(verb: string, id: string, cx: WindowCx)
	local edit = read_link(id)
	if type(edit.path) ~= "string" or type(edit.text) ~= "string" then
		error("the edit request is malformed", 0)
	end
	local path: string = edit.path
	local pip = if type(edit.pane) == "number" then edit.pane else nil
	cx.docs:read(path):next(function(text, err, c)
		local fresh = c :: WindowCx
		if err or type(text) ~= "string" then
			fresh:toast("error", EDIT_FAILED[verb], err or ("cannot read " .. path))
			return
		end
		local new, line = apply(verb, edit, text)
		if new == nil then
			fresh:toast("error", EDIT_FAILED[verb], tostring(line))
			return
		end
		fresh.docs:write(path, new):next(function(_range, werr, c2)
			local after = c2 :: WindowCx
			if werr then
				after:toast("error", EDIT_FAILED[verb], werr)
				return
			end
			reveal(after, path, line :: number, pip)
		end)
	end)
end

---------------------------------------------------------------------------
-- LaTeX editing: wrap the selection (or the caret) in a command, inline math
-- or an environment, in the live buffer of the focused `.tex` file block.
-- Tern gives plugins no editing calls for file blocks, so the buffer is read,
-- written back whole (it stays unsaved), and the caret put back with a
-- `#L<line>C<col>` open, which places it in the existing block.

-- What an edit makes of the buffer: the new text and the 0-based byte offset
-- for the caret, or nil and why it cannot.
type Change = (text: string, s: number, e: number) -> (string?, number | string)

-- The focused block when it is a `.tex` file (no project needed).
local function focused_tex_file(cx: WindowCx): PaneInfo?
	local pane = focused_pane(cx)
	if pane ~= nil and pane.kind == "file" and pane.path ~= nil and ends(pane.path :: string, ".tex") then
		return pane
	end
	return nil
end

-- Applies `change` to the selection of `pane` (0-based byte offsets s..e, the
-- caret when nothing is selected) and puts the caret where it says.
local function edit_buffer(cx: WindowCx, pane: PaneInfo, what: string, change: Change)
	local path = pane.path :: string
	local at, a, b = caret(cx, pane.pane)
	cx.docs:read(path):next(function(text, err, c)
		local fresh = c :: WindowCx
		if err or type(text) ~= "string" then
			fresh:toast("error", what .. " failed", err or ("cannot read " .. path))
			return
		end
		local s, e = a, b
		if s == nil or e == nil then
			local o = offset_of(text, at.line, at.col)
			if o == nil then
				fresh:toast("error", what .. " failed", "the caret's line is gone")
				return
			end
			s, e = o - 1, o - 1
		end
		local new, where = change(text, s :: number, e :: number)
		if new == nil then
			fresh:toast("error", what .. " failed", tostring(where))
			return
		end
		fresh.docs:write(path, new):next(function(_range, werr, c2)
			local after = c2 :: WindowCx
			if werr then
				after:toast("error", what .. " failed", werr)
				return
			end
			local to = spot_at(new :: string, where :: number)
			after:open(path .. "#L" .. to.line .. "C" .. to.col)
		end)
	end)
end

-- Wraps s..e in `open`/`close` (selection without its outer whitespace), or
-- unwraps it when the markup is already there (around or inside the
-- selection); with no selection, inserts both with the caret between.
local function wrapping(open: string, close: string): Change
	return function(text: string, s: number, e: number): (string?, number | string)
		while e > s and string.find(string.sub(text, e, e), "^%s$") do
			e -= 1
		end
		while e > s and string.find(string.sub(text, s + 1, s + 1), "^%s$") do
			s += 1
		end
		local before, inner, after = string.sub(text, 1, s), string.sub(text, s + 1, e), string.sub(text, e + 1)
		if e == s then
			return before .. open .. close .. after, s + #open
		end
		if ends(before, open) and string.sub(after, 1, #close) == close then
			return string.sub(before, 1, #before - #open) .. inner .. string.sub(after, #close + 1), s - #open + #inner
		end
		if #inner >= #open + #close and string.sub(inner, 1, #open) == open and ends(inner, close) then
			local bare = string.sub(inner, #open + 1, #inner - #close)
			return before .. bare .. after, s + #bare
		end
		return before .. open .. inner .. close .. after, s + #open + #inner + #close
	end
end

-- Environments whose lines are list items: wrapping adds `\item` where a line has none.
local LIST_ENVS: { [string]: boolean } = { itemize = true, enumerate = true, description = true }

-- Wraps the whole lines of s..e (the caret's line when nothing is selected)
-- in `\begin{name}`…`\end{name}`, the body indented two spaces; on a blank
-- line, inserts an empty environment with the caret inside.
local function environment(name: string): Change
	return function(text: string, s: number, e: number): (string?, number | string)
		if e > s and string.sub(text, e, e) == "\n" then
			e -= 1 -- a selection of whole lines ends at the next line's start
		end
		local start = string.match(string.sub(text, 1, s), "^.*()\n") or 0
		local nl = string.find(text, "\n", e + 1, true)
		local stop = if nl then nl - 1 else #text
		local block = string.sub(text, start + 1, stop)
		local indent = string.match(block, "^[ \t]*") or ""
		local list = LIST_ENVS[name] == true
		local first = indent .. "\\begin{" .. name .. "}\n"
		local last = indent .. "\\end{" .. name .. "}"
		if string.find(block, "^%s*$") then
			local middle = indent .. "  " .. (if list then "\\item " else "")
			local new = string.sub(text, 1, start) .. first .. middle .. "\n" .. last .. string.sub(text, stop + 1)
			return new, start + #first + #middle
		end
		local body: { string } = {}
		for line in string.gmatch(block .. "\n", "(.-)\n") do
			if string.find(line, "^%s*$") then
				table.insert(body, line)
			else
				local lead, rest = string.match(line, "^([ \t]*)(.*)$")
				if list and string.sub(rest :: string, 1, 5) ~= "\\item" then
					rest = "\\item " .. (rest :: string)
				end
				table.insert(body, "  " .. (lead :: string) .. (rest :: string))
			end
		end
		local wrapped = first .. table.concat(body, "\n") .. "\n" .. last
		return string.sub(text, 1, start) .. wrapped .. string.sub(text, stop + 1), start + #wrapped
	end
end

-- Keys `Use LaTeX editing keys` binds in the user's keybinds (a plugin may not
-- bind keys Tern's defaults use). ⌘ never reaches terminal programs; elsewhere
-- Ctrl+Shift keeps Ctrl+B and Ctrl+I for them.
type EditKey = { chord: string, id: string, title: string }
local EDIT_KEYS: { EditKey } = if MACOS
	then {
		{ chord = "cmd+b", id = "bold", title = "bold" },
		{ chord = "cmd+i", id = "emph", title = "emphasis" },
		{ chord = "cmd+shift+m", id = "math", title = "inline math" },
		{ chord = "cmd+shift+e", id = "environment", title = "environment" },
	}
	else {
		{ chord = "ctrl+shift+b", id = "bold", title = "bold" },
		{ chord = "ctrl+shift+i", id = "emph", title = "emphasis" },
		{ chord = "ctrl+shift+m", id = "math", title = "inline math" },
		{ chord = "ctrl+shift+e", id = "environment", title = "environment" },
	}
local EDIT_KEYS_KV = "edit_keys"

-- What `Use LaTeX editing keys` bound, by command id: the chord, the user's own
-- binding of it before (restored on removal), and the action the key ran
-- outside view-specific contexts (it runs it outside `.tex` files: a plugin
-- action in a key's list always takes the key, wherever focus is).
type EditKeyRecord = { chord: string, previous: any, fallback: string? }
local edit_keys: { [string]: EditKeyRecord }? = nil

local function load_edit_keys(): { [string]: EditKeyRecord }
	if edit_keys == nil then
		local out: { [string]: EditKeyRecord } = {}
		local ok, data = pcall(tern.kv.get, EDIT_KEYS_KV)
		if ok and type(data) == "table" then
			for id, rec in data do
				if type(id) == "string" and type(rec) == "table" and type(rec.chord) == "string" then
					out[id] = { chord = rec.chord, previous = rec.previous, fallback = if type(rec.fallback) == "string" then rec.fallback else nil }
				end
			end
		end
		edit_keys = out
	end
	return edit_keys :: { [string]: EditKeyRecord }
end

-- Outside `.tex` files a LaTeX editing key runs what it did before (the key's
-- global action, quietly): its ternlatex action takes the key wherever focus is.
local function key_fallback(cx: WindowCx, id: string)
	local rec = load_edit_keys()[id]
	if rec and rec.fallback then
		cx:action(rec.fallback :: string)
	end
end

-- Runs edit `change` on the focused `.tex` file, else key_fallback.
local function latex_edit(cx: WindowCx, id: string, what: string, change: Change)
	local pane = focused_tex_file(cx)
	if pane == nil then
		key_fallback(cx, id)
		return
	end
	edit_buffer(cx, pane, what, change)
end

type WrapCommand = { id: string, title: string, open: string, close: string }
local WRAP_COMMANDS: { WrapCommand } = {
	{ id = "bold", title = "Bold (\\textbf)", open = "\\textbf{", close = "}" },
	{ id = "emph", title = "Emphasis (\\emph)", open = "\\emph{", close = "}" },
	{ id = "monospace", title = "Monospace (\\texttt)", open = "\\texttt{", close = "}" },
	{ id = "math", title = "Inline math ($…$)", open = "$", close = "$" },
}

for _, w in WRAP_COMMANDS do
	tern.command({
		id = w.id,
		title = w.title,
		group = GROUP,
		available = tex_available,
		run = function(cx: WindowCx)
			latex_edit(cx, w.id, w.title, wrapping(w.open, w.close))
		end,
	})
end

local ENVIRONMENTS = { "itemize", "enumerate", "description", "equation", "equation*", "align", "align*", "figure", "table", "center", "quote", "abstract", "proof", "minipage" }
local OTHER_ENVIRONMENT = "Other…"

tern.command({
	id = "environment",
	title = "Wrap in environment…",
	group = GROUP,
	available = tex_available,
	run = function(cx: WindowCx)
		if focused_tex_file(cx) == nil then
			key_fallback(cx, "environment")
			return
		end
		local items: { PickItem } = {}
		for _, name in ENVIRONMENTS do
			table.insert(items, { label = name })
		end
		table.insert(items, { label = OTHER_ENVIRONMENT, detail = "type a name" })
		local function wrap_in(c: WindowCx, name: string)
			local pane = focused_tex_file(c)
			if pane and string.find(name, "^[%a@]+%*?$") then
				edit_buffer(c, pane, "Wrap in " .. name, environment(name))
			elseif pane then
				c:toast("error", "Not wrapped", "“" .. name .. "” is not an environment name")
			end
		end
		cx:pick({ items = items, placeholder = "Wrap the selected lines in…", action = "wrap" }):next(function(item, _err, c0)
			local c1 = c0 :: WindowCx
			if item == nil then
				return
			end
			if item.label ~= OTHER_ENVIRONMENT then
				wrap_in(c1, item.label)
				return
			end
			c1:prompt({ placeholder = "Environment name, e.g. theorem", action = "wrap" }):next(function(name, _e, c2)
				if type(name) == "string" and name ~= "" then
					wrap_in(c2 :: WindowCx, (string.gsub(name, "^%s*(.-)%s*$", "%1")))
				end
			end)
		end)
	end,
})

-- A chord as `cx.actions:keys()` spells it: modifiers in Tern's order
-- (ctrl, alt, shift, cmd: "shift+cmd+m", "alt+cmd+1"), then the key.
local MODIFIER_ORDER: { [string]: number } = { ctrl = 1, alt = 2, shift = 3, cmd = 4 }
local function keymap_chord(chord: string): string
	local parts = string.split(chord, "+")
	local key = table.remove(parts) :: string
	table.sort(parts, function(a: string, b: string): boolean
		return (MODIFIER_ORDER[a] or 9) < (MODIFIER_ORDER[b] or 9)
	end)
	table.insert(parts, key)
	return table.concat(parts, "+")
end

-- ⌘⇧M on macOS, Ctrl+Shift+M elsewhere.
local function chord_label(chord: string): string
	local names: { [string]: string } = if MACOS
		then { cmd = "⌘", shift = "⇧", alt = "⌥", ctrl = "⌃" }
		else { cmd = "Super+", shift = "Shift+", alt = "Alt+", ctrl = "Ctrl+" }
	local out = ""
	local parts = string.split(chord, "+")
	for i, p in parts do
		out ..= if i == #parts then string.upper(p) else (names[p] or (p .. "+"))
	end
	return out
end

tern.command({
	id = "edit-keys-on",
	title = "Use LaTeX editing keys",
	group = GROUP,
	available = function(_cx: WindowCx): boolean
		return not IOS and next(load_edit_keys()) == nil
	end,
	run = function(cx: WindowCx)
		local effective = cx.actions:keys()
		local overrides = cx.settings:keybinds()
		local saved: { [string]: EditKeyRecord } = {}
		local bound: { string } = {}
		local skipped: { string } = {}
		for _, k in EDIT_KEYS do
			local action = "plugin.ternlatex." .. k.id
			local list: { string } = {}
			local fallback: string? = nil
			local clash: string? = nil
			for _, a in effective[keymap_chord(k.chord)] or {} do
				if string.sub(a, 1, 5) == "edit." or string.sub(a, 1, 7) == "editor." or string.sub(a, 1, 7) == "plugin." then
					clash = a -- it would win in file blocks, or (a plugin's) everywhere
				elseif string.find(a, ".", 1, true) then
					table.insert(list, a) -- another view's (markdown.bold, git.new_branch): it keeps the key there
				elseif fallback == nil then
					fallback = a -- the key's global action (toggle_sidebar): ternlatex runs it outside .tex files
				end
			end
			if clash then
				table.insert(skipped, chord_label(k.chord) .. " (" .. clash .. ")")
			else
				table.insert(list, action)
				saved[k.id] = { chord = k.chord, previous = overrides[k.chord], fallback = fallback }
				cx.settings:bind(k.chord, list)
				table.insert(bound, chord_label(k.chord) .. " " .. k.title)
			end
		end
		pcall(tern.kv.set, EDIT_KEYS_KV, saved)
		edit_keys = saved
		local sub = table.concat(bound, " · ") .. " in .tex files; elsewhere the keys work as before."
		if #skipped > 0 then
			sub ..= " Left alone, already in use: " .. table.concat(skipped, ", ") .. "."
		end
		cx:toast("success", "LaTeX editing keys on", sub)
	end,
})

tern.command({
	id = "edit-keys-off",
	title = "Remove LaTeX editing keys",
	group = GROUP,
	available = function(_cx: WindowCx): boolean
		return not IOS and next(load_edit_keys()) ~= nil
	end,
	run = function(cx: WindowCx)
		local map = table.clone(cx.settings:keybinds())
		for id, rec in load_edit_keys() do
			local current = map[rec.chord]
			-- Only a binding that still holds ternlatex's action: a key the user rebound since stays theirs.
			if type(current) == "table" and table.find(current, "plugin.ternlatex." .. id) then
				map[rec.chord] = rec.previous
			end
		end
		cx.settings:set("keybinds", map)
		pcall(tern.kv.set, EDIT_KEYS_KV, {})
		edit_keys = {}
		cx:toast("success", "LaTeX editing keys off", "The keys are back to what they did before.")
	end,
})

---------------------------------------------------------------------------
-- Review and outline blocks Tern's "Open with" menu started on a `.tex`
-- file announce themselves as `ternlatex://block/<id>`: the window keeps one
-- per project, as its own commands do.

local ANNOUNCED: { [string]: { key: string, kind: string, title: string } } = {
	outline = { key = "outlines", kind = OUTLINE, title = "Outline" },
	review = { key = "reviews", kind = REVIEW, title = "Review" },
}

local function block_link(id: string, cx: WindowCx)
	local req = read_link(id)
	local spec = if type(req.block) == "string" then ANNOUNCED[req.block] else nil
	if spec == nil or type(req.dir) ~= "string" or type(req.pane) ~= "number" then
		error("the block announcement is malformed", 0)
	end
	local dir = common.normalize(req.dir)
	local pane: number = req.pane
	local existing = project_block(cx, spec.key, spec.kind, dir)
	if existing and existing ~= pane then
		local p = cx.session:pane(pane)
		if p and p.block == spec.kind then
			cx.layout:close(pane)
		end
		cx.layout:focus(existing)
		cx:toast("info", spec.title .. " is already open for " .. common.basename(dir))
		return
	end
	remember_block(spec.key, dir, pane)
end

tern.route.link(function(link: LinkRequest, cx: WindowCx): RouteDecision?
	if string.sub(link.url, 1, 12) ~= "ternlatex://" then
		return nil
	end
	local verb, id = string.match(link.url, "^ternlatex://(%a+)/([0-9a-f%-]+)$")
	if verb == "block" and id then
		local ok, err = pcall(block_link, id, cx)
		if not ok then
			cx:toast("error", "ternlatex block not registered", tostring(err))
		end
		return { handled = true }
	end
	if verb == nil or id == nil or EDIT_FAILED[verb] == nil then
		cx:toast("error", "Unknown ternlatex link", link.url)
		return { handled = true }
	end
	local ok, err = pcall(edit_link, verb, id, cx)
	if not ok then
		cx:toast("error", EDIT_FAILED[verb], tostring(err))
	end
	return { handled = true }
end)

tern.command({
	id = "review",
	title = "Review changes",
	group = GROUP,
	run = function(cx: WindowCx)
		local dir, rec = focused_project(cx)
		if dir == nil then
			cx:toast("error", "Not in a ternlatex project", "No ternlatex.toml above the focused block.")
			return
		end
		local ok, err = pcall(open_review, cx, dir :: string, if rec then rec.dev else nil)
		if not ok then
			cx:toast("error", "Review did not open", tostring(err))
		end
	end,
})

tern.command({
	id = "fix",
	title = "Fix build errors with omp",
	group = GROUP,
	run = function(cx: WindowCx)
		local dir = focused_project(cx)
		if dir == nil then
			cx:toast("error", "Not in a ternlatex project", "No ternlatex.toml above the focused block.")
			return
		end
		local err = run_cli(cx, { "fix" }, dir :: string, function(result, c)
			toast_result(c, result, "Fix with omp", "Fix with omp failed")
		end)
		if err then
			cx:toast("error", "Fix with omp failed", err)
		end
	end,
})

tern.command({
	id = "show-viewer",
	title = "Show PDF viewer",
	group = GROUP,
	run = function(cx: WindowCx)
		local _, rec = focused_project(cx)
		local viewer = if rec then main_viewer(cx, rec.dev) else nil
		if viewer == nil then
			cx:toast("error", "No PDF viewer", "Run `ternlatex dev` in the project.")
			return
		end
		cx.layout:focus(viewer.pane)
	end,
})

tern.command({
	id = "reset-layout",
	title = "Reset layout sizes",
	group = GROUP,
	run = function(cx: WindowCx)
		local _, rec = focused_project(cx)
		if rec == nil or live(cx, rec.dev) == nil then
			cx:toast("error", "No ternlatex layout here", "Run `ternlatex dev` in the project.")
			return
		end
		proportion(cx, rec :: Project)
	end,
})

-- The focused block's directory: a file block's folder, else its cwd.
local function focused_dir(cx: WindowCx): string?
	local pane = focused_pane(cx)
	if pane == nil then
		return nil
	end
	if pane.kind == "file" and pane.path then
		return common.parent(pane.path :: string)
	end
	return pane.cwd
end

-- A new tab in `dir` running `ternlatex dev`; its layout op builds the tab.
local function start_dev(cx: WindowCx, dir: string)
	with_program(cx, function(config: common.Config?, err: string?, c: WindowCx)
		if config == nil then
			not_installed(c, "ternlatex did not start", err)
			return
		end
		create_last(function(): number?
			return c.layout:new_tab({ cwd = dir, command = shell_line(common.argv(config, { "dev" })) })
		end, function(tab: number?, why: any, c1: WindowCx)
			if tab == nil then
				c1:toast("error", "ternlatex did not start", if why then tostring(why) else "Tern opened no tab")
			end
		end)
	end)
end

local function desktop(_cx: WindowCx?): boolean
	return not IOS
end

tern.command({
	id = "start",
	title = "Start ternlatex here",
	group = GROUP,
	available = desktop,
	run = function(cx: WindowCx)
		local here = focused_dir(cx)
		local dir = if here then common.project(here) else nil
		if dir == nil then
			cx:toast("error", "No ternlatex project here", "No ternlatex.toml above " .. (here or "the focused block") .. "; New LaTeX project here… creates one.")
			return
		end
		start_dev(cx, dir :: string)
	end,
})

tern.command({
	id = "new-project",
	title = "New LaTeX project here… (or adopt this folder)",
	group = GROUP,
	available = desktop,
	run = function(cx: WindowCx)
		local here = focused_dir(cx)
		if here == nil then
			cx:toast("error", "New LaTeX project needs a folder", "Focus a terminal or file block in the folder to use.")
			return
		end
		local dir = here :: string
		local listed, names = pcall(tern.fs.list, dir)
		if not listed then
			cx:toast("error", "New LaTeX project not created", tostring(names))
			return
		end
		-- A folder with files already (a cloned Overleaf project, a co-author's repo) is adopted in place:
		-- `import` finds its root .tex and keeps ternlatex's own files out of its git repository.
		local adopt = false
		for _, name in names do
			if string.sub(name, 1, 1) ~= "." then
				adopt = true
				break
			end
		end
		local what = if adopt then "LaTeX project not adopted" else "New LaTeX project not created"
		local err = run_cli(cx, { if adopt then "import" else "init", dir }, dir, function(result, c)
			if result.status ~= 0 then
				c:toast("error", what, common.outcome(result))
				return
			end
			c:toast("success", if adopt then "Adopted LaTeX project" else "New LaTeX project", dir)
			start_dev(c, dir)
		end)
		if err then
			not_installed(cx, what, err)
		end
	end,
})

-- The launcher Add ternlatex to PATH wrote, while it exists.
local function launcher(): string?
	local ok, path = pcall(tern.kv.get, LAUNCHER_KEY)
	return if ok and type(path) == "string" and tern.fs.exists(path) then path else nil
end

tern.command({
	id = "copy-path",
	title = "Copy ternlatex path",
	group = GROUP,
	available = desktop,
	run = function(cx: WindowCx)
		with_program(cx, function(config: common.Config?, err: string?, c: WindowCx)
			if config == nil then
				not_installed(c, "Nothing copied", err)
				return
			end
			local installed = launcher()
			c:copy(shell_line(if installed then { installed :: string } else config.bin))
			c:toast("success", "Copied ternlatex's path", "Run it in a terminal block: paste, then a command such as doctor.")
		end)
	end,
})

tern.command({
	id = "install-cli",
	title = "Add ternlatex to PATH",
	group = GROUP,
	available = function(_cx: WindowCx): boolean
		return desktop() and common.from_source()
	end,
	run = function(cx: WindowCx)
		local err = run_cli(cx, { "install-cli" }, home() or tern.plugin.data, function(result, c)
			if result.status == 0 then
				-- `wrote <launcher>` per file; on Windows the last is ternlatex.cmd.
				local wrote: string? = nil
				for line in string.gmatch(result.stdout, "[^\r\n]+") do
					wrote = string.match(line, "^wrote (.+)$") or wrote
				end
				if wrote then
					pcall(tern.kv.set, LAUNCHER_KEY, wrote)
				end
			end
			toast_result(c, result, "Added ternlatex to PATH", "ternlatex was not added to PATH")
		end)
		if err then
			not_installed(cx, "ternlatex was not added to PATH", err)
		end
	end,
})

-- bun.sh's installer in a terminal block the user watches; on macOS and
-- Linux a shell stays open after it (a command block that succeeds closes).
local BUN_INSTALLER = if WINDOWS
	then 'powershell -NoExit -c "irm bun.sh/install.ps1|iex"'
	else 'curl -fsSL https://bun.sh/install | bash && echo && echo "Next: palette › Start ternlatex here"; exec "$SHELL" -l'

tern.command({
	id = "install-bun",
	title = "Install Bun",
	group = GROUP,
	available = function(_cx: WindowCx): boolean
		return desktop() and common.from_source()
	end,
	run = function(cx: WindowCx)
		create_last(function(): number?
			return cx.layout:new_tab({ cwd = home(), command = BUN_INSTALLER })
		end, function(tab: number?, why: any, c: WindowCx)
			if tab == nil then
				c:toast("error", "Bun's installer did not start", if why then tostring(why) else "Tern opened no tab")
			else
				c:toast("info", "Installing Bun in the new tab", "When it is done: Palette: Start ternlatex here")
			end
		end)
	end,
})

-- `ternlatex uninstall` in a new tab, in the focused block's folder: it
-- lists what it removes and asks there. A shell stays open after it so the
-- user can read what it did (a command block that succeeds closes).
tern.command({
	id = "uninstall",
	title = "Uninstall ternlatex",
	group = GROUP,
	available = desktop,
	run = function(cx: WindowCx)
		local dir = focused_dir(cx) or home()
		with_program(cx, function(config: common.Config?, err: string?, c: WindowCx)
			if config == nil then
				not_installed(c, "ternlatex uninstall did not start", err)
				return
			end
			local line = shell_line(common.argv(config, { "uninstall" }))
			local command = if WINDOWS then 'cmd /k "' .. line .. '"' else line .. '; exec "$SHELL" -l'
			create_last(function(): number?
				return c.layout:new_tab({ cwd = dir, command = command })
			end, function(tab: number?, why: any, c1: WindowCx)
				if tab == nil then
					c1:toast("error", "ternlatex uninstall did not start", if why then tostring(why) else "Tern opened no tab")
				end
			end)
		end)
	end,
})

---------------------------------------------------------------------------
-- Key hints: a toast listing the editor keys once per plugin version, and
-- one per default chord Tern's preset already takes (the plugin bind is
-- then left out). A chord another app grabs system-wide is invisible here.

local hinted_this_load = false

-- `chord` with its modifiers sorted: `cmd+alt+j` is the keymap's `alt+cmd+j`.
local function chord_id(chord: string): string
	local parts = string.split(string.lower(chord), "+")
	local key = table.remove(parts)
	table.sort(parts)
	table.insert(parts, key)
	return table.concat(parts, "+")
end

-- Who holds a chord bound to `ids` instead of us.
local function holder(cx: WindowCx, ids: { string }?): string
	local first = if ids then ids[1] else nil
	if first == nil then
		return "another app"
	end
	local ok, action = pcall(function(): PaletteAction
		return cx.actions:describe(first)
	end)
	return if ok and type(action.label) == "string" then action.label else first
end

local function hint_keys(cx: WindowCx)
	if hinted_this_load or #KEYS == 0 then
		return
	end
	hinted_this_load = true
	local version = common.version()
	local ok, welcomed = pcall(tern.kv.get, "welcomed")
	if ok and welcomed ~= version and pcall(tern.kv.set, "welcomed", version) then
		local parts: { string } = {}
		for _, def in KEYS do
			table.insert(parts, key_display(def.key) .. " " .. def.title)
		end
		cx:toast("info", "ternlatex keys: " .. table.concat(parts, " · "), "Palette: type ternlatex · in the viewer press ?")
	end

	local read, keymap = pcall(function(): { [string]: { string } }
		return cx.actions:keys()
	end)
	local got, stored = pcall(tern.kv.get, "hinted")
	if not read or not got then
		tern.log.warn("ternlatex: cannot check key conflicts", if read then stored else keymap)
		return
	end
	-- Our actions bound anywhere: one the user moved to another chord is fine.
	local bound: { [string]: boolean } = {}
	local at: { [string]: { string } } = {}
	for chord, ids in keymap do
		at[chord_id(chord)] = ids
		for _, id in ids do
			bound[id] = true
		end
	end
	local hinted: { [string]: any } = if type(stored) == "table" then stored else {}
	local changed = false
	for _, def in KEYS do
		local action = "plugin.ternlatex." .. def.id
		local chord = chord_id(CHORD .. def.key)
		if not bound[action] and hinted[chord] ~= version then
			hinted[chord] = version
			changed = true
			cx:toast(
				"error",
				"ternlatex: " .. key_display(def.key) .. " is taken by " .. holder(cx, at[chord]),
				"Bind " .. action .. " in Settings → Keybindings"
			)
		end
	end
	if changed then
		pcall(tern.kv.set, "hinted", hinted)
	end
end

---------------------------------------------------------------------------
-- Window start and the status line's refresh (its tables: "Status line"
-- above).

-- Sets ternlatex up at once when this source package has none usable, so
-- it is ready before a command needs it; says why not once per VM (no Bun,
-- most often).
local told_setup = false
local function set_up_early(cx: WindowCx)
	if not desktop() or not common.from_source() or resolving or program() ~= nil then
		return
	end
	with_program(cx, function(got: common.Config?, err: string?, c: WindowCx)
		if got == nil and not told_setup then
			told_setup = true
			not_installed(c, "ternlatex is not ready", err)
		end
	end)
end

-- Also resumes caret sampling for peek blocks a restart or reload kept,
-- shows the key hints this version has not shown yet, and sets ternlatex
-- up (set_up_early).
local function start(cx: WindowCx)
	recheck(cx)
	if #peek_blocks(cx, nil) > 0 then
		peek_schedule()
	end
	hint_keys(cx)
	set_up_early(cx)
end

tern.on("window_start", start)
-- A reload doesn't run window_start again: scan once the VM is up.
tern.timer(0, function(cx: WindowCx?)
	if cx then
		start(cx)
	end
end)
for _, name in { "focus", "pane_created", "pane_closed", "tab_closed", "title" } do
	tern.on(name, function(_ev: any, cx: WindowCx)
		rescan(cx)
	end)
end

-- While ternlatex is not usable, notice a setup another window (or a
-- ternlatex run from this package) finished; file reads stay out of the
-- event hooks.
local RECHECK_MS = 5 * 1000
local function poll(cx: WindowCx?)
	if cx and unusable then
		recheck(cx)
	end
	tern.timer(RECHECK_MS, poll)
end
tern.timer(RECHECK_MS, poll)

tern.chrome.status(function(pane: StatusPaneInfo): { StatusSegment }?
	local tab = pane_tab[pane.pane]
	local dev = if tab then tab_dev[tab] else nil
	if dev then
		return { { text = dev.text, tone = dev.tone, command = SHOW_VIEWER } }
	end
	local missing = unusable
	if pane_missing[pane.pane] and missing then
		return { { text = missing.text, tone = missing.tone, command = missing.command } }
	end
	return nil
end)

---------------------------------------------------------------------------
-- Carly

-- The project Carly's calls act on: the focused tab's, else the focused
-- pane's.
local function carly_project(cx: WindowCx, call: ExportCall): string?
	local dir = focused_project(cx)
	if dir == nil then
		call:fail("the focused block is not in a ternlatex project")
	end
	return dir
end

-- Runs ternlatex for Carly and answers with `answer(result)`.
local function carly_run(cx: WindowCx, call: ExportCall, args: { string }, answer: (ProcessResult) -> any): any
	local dir = carly_project(cx, call)
	if dir == nil then
		return nil
	end
	local err = run_cli(cx, args, dir :: string, function(result, _c)
		local ok, value = pcall(answer, result)
		if ok then
			call:reply(value)
		else
			call:fail(tostring(value))
		end
	end)
	if err then
		call:fail(err)
		return nil
	end
	return call:wait(CLI_TIMEOUT_MS)
end

local function printed(result: ProcessResult): any
	return { status = result.status, output = result.stdout, errors = result.stderr }
end

tern.carly.export("build", {
	sig = "(doc: string?) -> {status: number, output: string, errors: string}",
	doc = "Builds the focused project's documents (or one) with `ternlatex build`; output lists `file:line: severity: message` diagnostics and an ok/FAILED summary per document.",
}, function(doc: any, cx: WindowCx, call: ExportCall): any
	local args = { "build" }
	if type(doc) == "string" and doc ~= "" then
		table.insert(args, "--doc")
		table.insert(args, doc)
	end
	return carly_run(cx, call, args, printed)
end)

tern.carly.export("show", {
	sig = "(file: string, line: number) -> {status: number, output: string, errors: string}",
	doc = "Scrolls the live PDF viewer to a source line (forward search) and highlights it; status 2 means no dev server is running.",
}, function(file: any, line: any, cx: WindowCx, call: ExportCall): any
	if type(file) ~= "string" or type(line) ~= "number" then
		call:fail("show(file, line) needs a path and a line number")
		return nil
	end
	return carly_run(cx, call, { "show", file .. ":" .. math.floor(line) }, printed)
end)

tern.carly.export("changes", {
	sig = "() -> {authors: {{id: string, name: string, color: string}}, items: {{id: string, kind: string, author: string?, file: string, line: number, text: string, old: string?, comment: string?}}}",
	doc = "Open tracked changes, comments and proofread suggestions of the focused project.",
}, function(cx: WindowCx, call: ExportCall): any
	return carly_run(cx, call, { "changes", "--json" }, function(result)
		if result.status ~= 0 then
			error(common.outcome(result), 0)
		end
		return tern.json.decode(result.stdout)
	end)
end)

tern.carly.export("refs_search", {
	sig = "(query: string) -> {status: number, output: string, errors: string}",
	doc = "Searches the Zotero library: one line per hit with key, year, creators and title.",
}, function(query: any, cx: WindowCx, call: ExportCall): any
	if type(query) ~= "string" or query == "" then
		call:fail("refs_search(query) needs a query")
		return nil
	end
	return carly_run(cx, call, { "refs", "search", query }, printed)
end)

-- Under Carly's tight per-call budget: no ternlatex.toml walk (slow on a busy or networked disk), only the dev block
-- of the focused tab and the project record ternlatex dev keeps for it.
tern.carly.context(function(cx: WindowCx): string?
	local id = cx.session:focused()
	local tab = if id then cx.session:tab_of(id) else nil
	local dev = if tab then tab_dev[tab] else nil
	if dev == nil then
		return nil
	end
	for _, rec in load_projects() do
		if cx.session:tab_of(rec.dev) == tab then
			return string.sub("ternlatex project " .. rec.dir .. " · " .. dev.text, 1, 400)
		end
	end
	return nil
end)
