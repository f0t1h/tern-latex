--!strict
-- ternlatex, host half: the `build` lens over `ternlatex build`/`lint`
-- output, the `review` block (tracked changes to accept or reject), the
-- `outline` block, the `cite`, `rewrite` and `peek` picture-in-picture
-- blocks, and a hint when a shell enters a project with no dev server
-- running.

local common = require("./common")

local ui = tern.ui

local CLI_TIMEOUT_MS = 120 * 1000

local function with(node: Node, props: { [string]: any }): Node
	local p: { [string]: any } = node.p or {}
	for k, v in props do
		p[k] = v
	end
	node.p = p
	return node
end

local function button(label: string, act: string, tone: string): Node
	return with(ui.badge(label, tone), { actions = { click = act } })
end

local function plural(n: number, word: string): string
	return n .. " " .. word .. (if n == 1 then "" else "s")
end

-- Starts `ternlatex args…` in `cwd`; returns why it could not start.
local function run_cli(args: { string }, cwd: string, done: (ProcessResult) -> ()): string?
	local config, why = common.config()
	if config == nil then
		return why
	end
	local ok, err = pcall(function()
		tern.process.run(common.argv(config, args), { cwd = cwd, timeout_ms = CLI_TIMEOUT_MS }, function(result, _)
			done(result)
		end)
	end)
	return if ok then nil else tostring(err)
end

---------------------------------------------------------------------------
-- Lens: `ternlatex build` / `ternlatex lint`

-- One document's part of the output (`── <doc> (<root>)` starts one when the
-- project has several).
type Section = {
	doc: string?,
	root: string?,
	diags: { Diag },
	-- `ok|FAILED: <root> in Ns — E errors, W warnings…`
	ok: boolean?,
	errors: number,
	warnings: number,
	took: string?,
	-- Lines that are neither (chktex's "no findings", stray output).
	other: { string },
}

type LensState = {
	-- Where the printed project-relative paths resolve.
	base: string?,
	build: boolean,
	sections: { Section },
	status: number?,
}

-- Rows per document before the rest fold into "… N more".
local MAX_DIAGS = 200

local SEVERITY: { [string]: Severity } = { error = "error", warning = "warning", info = "note" }

local function section(state: LensState): Section
	local last = state.sections[#state.sections]
	if last then
		return last
	end
	local fresh: Section = { diags = {}, errors = 0, warnings = 0, other = {} }
	table.insert(state.sections, fresh)
	return fresh
end

-- The project the command ran on: its DIR argument (build) or the shell's
-- directory, walked up to ternlatex.toml.
local function base_dir(run: LensRun): string?
	local cwd = run.cwd
	local dir: string? = cwd
	if run.args[1] == "build" then
		local i = 2
		while i <= #run.args do
			local a = run.args[i]
			if a == "--doc" then
				i += 1
			elseif string.sub(a, 1, 1) ~= "-" then
				local abs = string.sub(a, 1, 1) == "/" or string.match(a, "^%a:[/\\]") ~= nil
				dir = if abs or cwd == nil then a else common.join(cwd :: string, a)
				break
			end
			i += 1
		end
	end
	if dir == nil then
		return nil
	end
	return common.project(dir :: string) or dir
end

local function parse_line(state: LensState, text: string)
	local doc, root = string.match(text, "^── (.-) %((.*)%)$")
	if doc and root then
		table.insert(state.sections, { doc = doc, root = root, diags = {}, errors = 0, warnings = 0, other = {} })
		return
	end
	local s = section(state)
	-- The summary: `ok|FAILED: <root> in Ns — E errors, W warnings…`.
	local verdict, took, errors, warnings = string.match(text, "^(%a+): .- in ([%d%.]+s) — (%d+) errors, (%d+) warnings")
	if (verdict == "ok" or verdict == "FAILED") and took then
		s.ok = verdict == "ok"
		s.took = took
		s.errors = tonumber(errors) or 0
		s.warnings = tonumber(warnings) or 0
		return
	end
	-- `file:line[:col]: severity: message`, or `severity: message` without a place.
	local path, line, col, sev, message = string.match(text, "^(.-):(%d+):(%d+): (%a+): (.*)$")
	if not (sev and SEVERITY[sev]) then
		path, line, sev, message = string.match(text, "^(.-):(%d+): (%a+): (.*)$")
		col = nil
	end
	if not (sev and SEVERITY[sev]) then
		path, line, col = nil, nil, nil
		sev, message = string.match(text, "^(%a+): (.*)$")
	end
	if sev and SEVERITY[sev] and message then
		local code = string.match(message, "%[(chktex %d+)%]$")
		if code then
			message = string.gsub(message, "%s*%[chktex %d+%]$", "")
		end
		table.insert(s.diags, {
			severity = SEVERITY[sev],
			message = message,
			code = code,
			path = path,
			line = tonumber(line),
			col = tonumber(col),
		})
		return
	end
	if text ~= "" then
		local last = s.diags[#s.diags]
		if last and string.match(text, "^%s") then
			-- A wrapped message continues on indented lines.
			local notes = last.notes or {}
			table.insert(notes, (string.gsub(text, "^%s+", "")))
			last.notes = notes
		else
			table.insert(s.other, text)
		end
	end
end

local function counts(s: Section): (number, number)
	if s.ok ~= nil then
		return s.errors, s.warnings
	end
	local e, w = 0, 0
	for _, d in s.diags do
		if d.severity == "error" then
			e += 1
		elseif d.severity == "warning" then
			w += 1
		end
	end
	return e, w
end

local function section_badges(state: LensState, s: Section): { Node }
	local out: { Node } = {}
	if s.ok == true then
		table.insert(out, ui.badge("ok", "success"))
	elseif s.ok == false then
		table.insert(out, ui.badge("FAILED", "error"))
	end
	local e, w = counts(s)
	if e > 0 then
		table.insert(out, ui.badge(plural(e, "error"), "error"))
	end
	if w > 0 then
		table.insert(out, ui.badge(plural(w, "warning"), "warning"))
	end
	if s.took then
		table.insert(out, ui.text({ ui.span(s.took, "muted num") }))
	end
	if state.build and state.status ~= nil and (e > 0 or w > 0) then
		table.insert(out, button("Fix with omp", "fix=" .. (s.doc or ""), "accent"))
	end
	return out
end

local function section_body(state: LensState, s: Section): { Node }
	local out: { Node } = {}
	local badges = section_badges(state, s)
	if #badges > 0 then
		table.insert(out, ui.row(badges))
	end
	for i, d in s.diags do
		if i > MAX_DIAGS then
			table.insert(out, ui.overflow(#s.diags - MAX_DIAGS))
			break
		end
		table.insert(out, ui.diagnostic(d, state.base))
	end
	for _, line in s.other do
		table.insert(out, ui.text({ ui.span(line, "muted") }))
	end
	return out
end

local function lens_view(state: LensState): Node?
	local any = false
	for _, s in state.sections do
		any = any or #s.diags > 0 or s.ok ~= nil or #s.other > 0
	end
	if not any then
		if state.status == nil then
			return ui.col({ ui.progress(nil, if state.build then "Building…" else "Linting…") })
		end
		return nil
	end
	if #state.sections == 1 and state.sections[1].doc == nil then
		return ui.col(section_body(state, state.sections[1]))
	end
	local children: { Node } = {}
	for _, s in state.sections do
		local head: { Span | string } = { ui.span(s.doc or "output", "strong") }
		if s.root then
			table.insert(head, ui.span("  " .. s.root, "muted"))
		end
		local e = counts(s)
		table.insert(children, with(ui.section(head, section_body(state, s)), {
			key = s.doc or "output",
			collapsible = true,
			collapsed = s.ok == true and #s.diags == 0,
			tone = if s.ok == false or e > 0 then "error" else nil,
		}))
	end
	return ui.col(children)
end

tern.lens.define("build", {
	open = function(run: LensRun, _cx: EffectCx): LensState
		return { base = base_dir(run), build = run.args[1] == "build", sections = {}, status = nil }
	end,

	line = function(state: LensState, l: LensLine)
		parse_line(state, l.text)
	end,

	finish = function(state: LensState, status: number)
		state.status = status
	end,

	view = lens_view,

	event = function(state: LensState, ev: UiEvent, cx: EffectCx)
		if ev.ev ~= "action" or ev.act ~= "fix" then
			return
		end
		local dir = state.base
		if dir == nil then
			cx:toast("error", "Fix with omp failed", "The command's directory is unknown.")
			return
		end
		local args = { "fix" }
		if type(ev.value) == "string" and ev.value ~= "" then
			table.insert(args, "--doc")
			table.insert(args, ev.value)
		end
		local err = run_cli(args, dir :: string, function(result)
			if result.status == 0 then
				cx:toast("success", "Fix with omp", common.outcome(result))
			else
				cx:toast("error", "Fix with omp failed", common.outcome(result))
			end
		end)
		if err then
			cx:toast("error", "Fix with omp failed", err)
		end
	end,
})

---------------------------------------------------------------------------
-- Block runs: what the blocks below share.

-- What every block state carries.
type Run = { cx: BlockCx, timer: TimerHandle? }

-- A pane id survives Restart; the state object identifies a block run.
local runs: { [number]: Run } = {}

local function retire(state: Run)
	if runs[state.cx.pane] == state then
		runs[state.cx.pane] = nil
	end
	if state.timer then
		state.timer:cancel()
		state.timer = nil
	end
end

-- Registers `state` as its pane's run, retiring an earlier one.
local function adopt(state: Run)
	local previous = runs[state.cx.pane]
	if previous then
		retire(previous)
	end
	runs[state.cx.pane] = state
end

-- Blocks have no close hook, so callbacks retire a disappeared pane.
local function alive(state: Run): boolean
	if runs[state.cx.pane] ~= state then
		return false
	end
	for _, p in tern.pane.list() do
		if p.pane == state.cx.pane then
			return true
		end
	end
	retire(state)
	return false
end

-- Calls `tick` every `ms` while the block lives.
local function every(state: Run, ms: number, tick: () -> ())
	if not alive(state) or state.timer then
		return
	end
	state.timer = tern.timer(ms, function()
		if not alive(state) then
			return
		end
		state.timer = nil
		tick()
		every(state, ms, tick)
	end)
end

-- Ends a block from its own handler.
local function close(state: Run, cx: BlockCx)
	retire(state)
	cx:exit(0)
end

local function str(v: any): string?
	return if type(v) == "string" then v else nil
end

local function num(v: any): number?
	return if type(v) == "number" then v else nil
end

-- `file:line` linking to the line (`#L<line>`, as diagnostic cards link);
-- `file` is relative to `dir`.
local function source_link(dir: string, file: string, line: number): Span
	local span = ui.path(file, dir)
	span.t = file .. ":" .. line
	if span.href then
		span.href = span.href .. "#L" .. line
	end
	return span
end

-- Forward search to `file:line` in the running viewer; quiet when no dev
-- server runs (exit 2).
local function show_in_pdf(dir: string, file: string, line: number, cx: BlockCx)
	local err = run_cli({ "show", file .. ":" .. line }, dir, function(result)
		if result.status ~= 0 and result.status ~= 2 then
			cx:toast("error", "Show in PDF failed", common.outcome(result))
		end
	end)
	if err then
		cx:toast("error", "Show in PDF failed", err)
	end
end

-- How many rows a list shows before it scrolls itself (keeping its selected
-- row in view); `chrome` is the cells the rest of the view takes.
local function list_lines(cx: BlockCx, chrome: number): number
	return math.max(3, math.floor((cx.rows - chrome) * 0.72))
end

-- `path` relative to `dir` with `/`, as ternlatex prints and takes paths.
local function relative(path: string, dir: string): string
	local p, d = common.normalize(path), common.normalize(dir)
	return if string.sub(p, 1, #d + 1) == d .. "/" then string.sub(p, #d + 2) else p
end

---------------------------------------------------------------------------
-- Requests to the window half, which owns the layout and the live buffers:
-- `<ipc>/<id>.json` plus a `ternlatex://<verb>/<id>` link.

local links = 0

-- Writes `payload` (plus `pane`: this block; the link arrives from the
-- focused block, not necessarily this one) and opens
-- `ternlatex://<verb>/<id>`; returns why it could not.
local function send_link(cx: BlockCx, verb: string, payload: { [string]: any }): string?
	payload.pane = cx.pane
	local config, why = common.config()
	if config == nil then
		return why
	end
	links += 1
	local id = string.format("%x-%x-%x", math.floor(tern.now()), math.random(0, 0x7fffffff), links)
	local ok, err = pcall(tern.fs.write, common.join(config.ipc, id .. ".json"), tern.json.encode(payload))
	if not ok then
		return tostring(err)
	end
	cx:open("ternlatex://" .. verb .. "/" .. id)
	return nil
end

-- The project of a review or outline block: its first argument is the
-- project directory (ternlatex's commands) or, from Tern's "Open with" menu
-- on a `.tex` file, that file's absolute path, walked up to ternlatex.toml.
-- Returns the directory ("" when none) and the file no project holds.
local function block_project(cx: BlockCx, arg: string?, saved_dir: string?): (string, string?)
	if arg and string.lower(string.sub(arg, -4)) == ".tex" then
		local ok, dir = pcall(common.project, arg)
		if ok and dir then
			return dir, nil
		end
		return "", arg
	end
	return common.normalize(arg or saved_dir or cx.cwd or ""), nil
end

-- "Open with" always starts a new block: the window keeps one `block` per
-- project, focusing an earlier one and closing this one.
local function announce(cx: BlockCx, arg: string?, block: string, dir: string)
	if arg == nil or dir == "" or string.lower(string.sub(arg, -4)) ~= ".tex" then
		return
	end
	local err = send_link(cx, "block", { block = block, dir = dir })
	if err then
		tern.log.warn("ternlatex: cannot register the " .. block .. " block", err)
	end
end

-- The card a block opened on a `.tex` file outside any project shows.
local function outside_card(what: string, file: string): Node
	local card = ui.card({ ui.span("Not in a ternlatex project", "strong") }, {
		ui.text({ ui.span(file, "code") }),
		ui.text({
			ui.span("No ternlatex.toml in its folder or above, so there is no " .. what .. " to show. ", "muted"),
			ui.span("Run `ternlatex init` in the project folder, then open the " .. what .. " again.", "muted"),
		}),
	})
	return with(card, { tone = "warning" })
end

---------------------------------------------------------------------------
-- Block `review`: `ternlatex changes --json`, polled.

local POLL_MS = 3000

type Author = { id: string, name: string, color: string }
type Change = {
	id: string,
	kind: string,
	author: string?,
	file: string,
	line: number,
	text: string,
	old: string?,
	comment: string?,
}
type ReviewState = {
	cx: BlockCx,
	dir: string,
	authors: { [string]: Author },
	order: { string },
	items: { Change }?,
	cursor: string?,
	loading: boolean,
	again: boolean,
	pending: { [string]: string }, -- change id → "accept" | "reject" in flight
	problem: string?,
	-- The `.tex` file "Open with" named when no project holds it.
	outside: string?,
	timer: TimerHandle?,
}

-- xcolor names ternlatex gives authors, as the closest view tones.
local TONES: { [string]: string } = {
	red = "error",
	magenta = "error",
	orange = "warning",
	olive = "warning",
	brown = "warning",
	yellow = "warning",
	teal = "success",
	green = "success",
	cyan = "info",
	blue = "info",
	violet = "accent",
	purple = "accent",
}

-- `changes --json`, validated; nil when it isn't that shape.
local function parse_changes(stdout: string): ({ Author }?, { Change }?)
	local ok, data = pcall(tern.json.decode, stdout)
	if not ok or type(data) ~= "table" or type(data.items) ~= "table" then
		return nil, nil
	end
	local authors: { Author } = {}
	for _, a in (if type(data.authors) == "table" then data.authors else {}) do
		if type(a) == "table" and type(a.id) == "string" then
			table.insert(authors, { id = a.id, name = str(a.name) or a.id, color = str(a.color) or "" })
		end
	end
	local items: { Change } = {}
	for _, c in data.items do
		if type(c) == "table" and type(c.id) == "string" and type(c.file) == "string" and type(c.line) == "number" then
			table.insert(items, {
				id = c.id,
				kind = str(c.kind) or "change",
				author = str(c.author),
				file = c.file,
				line = c.line,
				text = str(c.text) or "",
				old = str(c.old),
				comment = str(c.comment),
			})
		end
	end
	return authors, items
end

local function index_of(state: ReviewState): number
	for i, c in state.items or {} do
		if c.id == state.cursor then
			return i
		end
	end
	return 0
end

local function keep_cursor(state: ReviewState)
	local items = state.items or {}
	if index_of(state) == 0 then
		state.cursor = if items[1] then items[1].id else nil
	end
end

local function refresh(state: ReviewState)
	if not alive(state) or state.outside then
		return
	end
	if state.loading then
		state.again = true -- an action finished mid-poll: poll once more after
		return
	end
	state.loading = true
	local err = run_cli({ "changes", "--json" }, state.dir, function(result)
		if not alive(state) then
			return
		end
		state.loading = false
		if result.status ~= 0 then
			state.problem = common.outcome(result)
		else
			local authors, items = parse_changes(result.stdout)
			if items == nil then
				state.problem = "`ternlatex changes --json` printed something else:\n" .. common.first_lines(result.stdout, 4)
			else
				state.problem = nil
				state.authors = {}
				state.order = {}
				for _, a in authors or {} do
					state.authors[a.id] = a
					table.insert(state.order, a.id)
				end
				state.items = items
				keep_cursor(state)
			end
		end
		if state.again then
			state.again = false
			refresh(state)
		end
		state.cx:render()
	end)
	if err then
		state.loading = false
		state.problem = err
	end
end

-- Accepts or rejects change `id`, then reloads the list.
local function decide(state: ReviewState, verb: string, id: string, cx: BlockCx)
	if state.pending[id] then
		return
	end
	state.pending[id] = verb
	local err = run_cli({ verb, id }, state.dir, function(result)
		state.pending[id] = nil
		if not alive(state) then
			return
		end
		if result.status ~= 0 then
			state.cx:toast("error", (if verb == "accept" then "Accept" else "Reject") .. " failed", common.outcome(result))
		end
		refresh(state)
		state.cx:render()
	end)
	if err then
		state.pending[id] = nil
		cx:toast("error", "ternlatex did not start", err)
	end
end

local function author_badge(state: ReviewState, id: string?): Node?
	if id == nil then
		return nil
	end
	local a = state.authors[id]
	return ui.badge(if a then a.name else id, if a then TONES[a.color] or "neutral" else "neutral")
end

local function change_card(state: ReviewState, c: Change, selected: boolean): Node
	local head: { Span | string } = {
		ui.span(if selected then "› " else "  ", "accent strong"),
		ui.span(c.kind, "strong"),
		"  ",
		source_link(state.dir, c.file, c.line),
	}
	local body: { Node } = {}
	if c.kind == "replaced" and c.old then
		table.insert(body, ui.text({ ui.span(c.old, "del"), ui.span("  →  ", "muted"), ui.span(c.text, "ins") }))
	elseif c.kind == "deleted" then
		table.insert(body, ui.text({ ui.span(c.text, "del") }))
	elseif c.kind == "added" then
		table.insert(body, ui.text({ ui.span(c.text, "ins") }))
	else
		table.insert(body, ui.text(c.text))
	end
	if c.comment then
		table.insert(body, ui.text({ ui.span("comment: ", "muted"), ui.span(c.comment :: string, "em") }))
	end
	local actions: { Node } = {}
	local badge = author_badge(state, c.author)
	if badge then
		table.insert(actions, badge)
	end
	local busy = state.pending[c.id]
	if busy then
		table.insert(actions, ui.badge(if busy == "accept" then "accepting…" else "rejecting…", "pending"))
	else
		table.insert(actions, button("Accept", "accept=" .. c.id, "success"))
		table.insert(actions, button("Reject", "reject=" .. c.id, "error"))
	end
	table.insert(body, ui.row(actions))
	return with(ui.card(head, body), {
		key = c.id,
		tone = if selected then "accent" else nil,
		actions = { click = "select=" .. c.id },
	})
end

local function review_dock(state: ReviewState): Node
	local per: { [string]: number } = {}
	local items = state.items or {}
	for _, c in items do
		local who = c.author or ""
		per[who] = (per[who] or 0) + 1
	end
	local row: { Node } = { ui.text({ ui.span(#items .. " open", "strong") }) }
	for _, id in state.order do
		if per[id] then
			local a = state.authors[id]
			table.insert(row, ui.badge(a.name .. " " .. per[id], TONES[a.color] or "neutral"))
			per[id] = nil
		end
	end
	for id, n in per do
		table.insert(row, ui.badge((if id == "" then "no author" else id) .. " " .. n, "neutral"))
	end
	local lines: { Node } = { ui.row(row) }
	if state.problem and state.items then
		table.insert(lines, ui.text({ ui.span(common.first_lines(state.problem :: string, 1), "warning"), ui.span("  showing the last list", "muted") }))
	end
	table.insert(lines, ui.text({ ui.span("j/k move · a accept · r reject · enter open source · R refresh", "dim") }))
	return ui.col(lines)
end

local function move(state: ReviewState, to: number)
	local items = state.items or {}
	local c = items[math.clamp(to, 1, math.max(1, #items))]
	if c then
		state.cursor = c.id
	end
end

tern.block.define("review", {
	init = function(cx: BlockCx, args: { string }, saved: any): ReviewState
		local dir, outside = block_project(cx, args[1], if type(saved) == "table" then str(saved.dir) else nil)
		local state: ReviewState = {
			cx = cx,
			dir = dir,
			authors = {},
			order = {},
			items = nil,
			cursor = if type(saved) == "table" then str(saved.cursor) else nil,
			loading = false,
			again = false,
			pending = {},
			problem = nil,
			outside = outside,
			timer = nil,
		}
		adopt(state)
		if outside then
			return state
		end
		announce(cx, args[1], "review", dir)
		refresh(state)
		every(state, POLL_MS, function()
			refresh(state)
		end)
		return state
	end,

	title = function(state: ReviewState): string?
		if state.items then
			return "Review · " .. #(state.items :: { Change }) .. " open"
		end
		return "Review"
	end,

	view = function(state: ReviewState, _cx: BlockCx): BlockView
		if state.outside then
			return { main = ui.col({ outside_card("tracked changes", state.outside :: string) }) }
		end
		local items = state.items
		if items == nil then
			if state.problem then
				local card = ui.card({ ui.span("Could not load the changes", "strong") }, {
					ui.code(state.problem :: string),
					ui.row({ button("Retry", "refresh", "accent") }),
				})
				return { main = ui.col({ with(card, { tone = "error" }) }) }
			end
			return { main = ui.col({ ui.progress(nil, "Loading changes…") }) }
		end
		local cards: { Node } = {}
		for _, c in items do
			table.insert(cards, change_card(state, c, c.id == state.cursor))
		end
		if #cards == 0 then
			table.insert(cards, ui.text({ ui.span("No open changes or comments.", "muted") }))
		end
		return { main = ui.col(cards), dock = review_dock(state) }
	end,

	key = function(state: ReviewState, key: Key, cx: BlockCx): boolean?
		if key.ctrl or key.alt or key.meta then
			return false
		end
		local i = index_of(state)
		local k = key.text or key.name
		local items = state.items or {}
		local current = items[i]
		if key.name == "up" or k == "k" then
			move(state, i - 1)
		elseif key.name == "down" or k == "j" then
			move(state, i + 1)
		elseif key.name == "home" or k == "g" then
			move(state, 1)
		elseif key.name == "end" or k == "G" then
			move(state, #items)
		elseif k == "a" and current then
			decide(state, "accept", current.id, cx)
		elseif k == "r" and current then
			decide(state, "reject", current.id, cx)
		elseif key.name == "enter" and current then
			local href = source_link(state.dir, current.file, current.line).href
			if href then
				cx:open(href)
			end
			return false
		elseif k == "R" then
			refresh(state)
		else
			return false
		end
		return true
	end,

	event = function(state: ReviewState, ev: UiEvent, cx: BlockCx)
		if ev.ev ~= "action" then
			return
		end
		local id = if type(ev.value) == "string" then ev.value else nil
		if ev.act == "refresh" then
			refresh(state)
		elseif id and (ev.act == "accept" or ev.act == "reject") then
			state.cursor = id
			decide(state, ev.act, id, cx)
		elseif id and ev.act == "select" then
			state.cursor = id
		end
	end,

	save = function(state: ReviewState): any
		return { dir = state.dir, cursor = state.cursor }
	end,
})

---------------------------------------------------------------------------
-- Block `outline`: `ternlatex outline --json`, polled.

type OutlineItem = {
	key: string,
	kind: string,
	level: number,
	title: string,
	number: string?,
	file: string,
	line: number,
	label: string?,
}
type OutlineProblem = { kind: string, key: string, file: string, line: number }
type OutlineState = {
	cx: BlockCx,
	timer: TimerHandle?,
	dir: string,
	doc: string?,
	items: { OutlineItem }?,
	problems: { OutlineProblem },
	cursor: string?,
	show_problems: boolean,
	loading: boolean,
	problem: string?,
	-- The `.tex` file "Open with" named when no project holds it.
	outside: string?,
}

-- The list is keyed `items`: each row's id is `main.items.<item key>`.
local OUTLINE_LIST = "main.items."

-- Floats and display math, badged among the sectioning items.
local FLOATS: { [string]: boolean } = { figure = true, table = true, equation = true }

local PROBLEM_TEXT: { [string]: string } = {
	["undefined-ref"] = "undefined reference",
	["unused-label"] = "unused label",
	["duplicate-label"] = "duplicate label",
	["missing-citation"] = "missing citation",
}

-- `outline --json`, validated: the document, its items (nil when the output
-- isn't that shape) and its problems.
local function parse_outline(stdout: string): (string?, { OutlineItem }?, { OutlineProblem })
	local problems: { OutlineProblem } = {}
	local ok, data = pcall(tern.json.decode, stdout)
	if not ok or type(data) ~= "table" or type(data.items) ~= "table" then
		return nil, nil, problems
	end
	local items: { OutlineItem } = {}
	local seen: { [string]: number } = {}
	for _, it in data.items do
		if type(it) == "table" and type(it.kind) == "string" and type(it.file) == "string" and type(it.line) == "number" then
			local label = str(it.label)
			-- Labels are stable across edits; positions are the fallback.
			local base = label or (it.kind .. ":" .. it.file .. ":" .. it.line)
			local n = (seen[base] or 0) + 1
			seen[base] = n
			table.insert(items, {
				key = if n == 1 then base else base .. "#" .. n,
				kind = it.kind,
				level = math.max(1, math.floor(num(it.level) or 1)),
				title = str(it.title) or "",
				number = str(it.number) or (if type(it.number) == "number" then tostring(it.number) else nil),
				file = it.file,
				line = it.line,
				label = label,
			})
		end
	end
	for _, p in (if type(data.problems) == "table" then data.problems else {}) do
		if type(p) == "table" and type(p.kind) == "string" and type(p.file) == "string" and type(p.line) == "number" then
			table.insert(problems, { kind = p.kind, key = str(p.key) or "", file = p.file, line = p.line })
		end
	end
	return str(data.doc), items, problems
end

local function outline_index(state: OutlineState): number
	for i, it in state.items or {} do
		if it.key == state.cursor then
			return i
		end
	end
	return 0
end

local function outline_move(state: OutlineState, to: number)
	local items = state.items or {}
	local it = items[math.clamp(to, 1, math.max(1, #items))]
	if it then
		state.cursor = it.key
	end
end

local function outline_refresh(state: OutlineState)
	if not alive(state) or state.loading or state.outside then
		return
	end
	state.loading = true
	local err = run_cli({ "outline", "--json" }, state.dir, function(result)
		if not alive(state) then
			return
		end
		state.loading = false
		if result.status ~= 0 then
			state.problem = common.outcome(result)
		else
			local doc, items, problems = parse_outline(result.stdout)
			if items == nil then
				state.problem = "`ternlatex outline --json` printed something else:\n" .. common.first_lines(result.stdout, 4)
			else
				state.problem = nil
				state.doc = doc
				state.items = items
				state.problems = problems
				if outline_index(state) == 0 then
					state.cursor = if items[1] then items[1].key else nil
				end
			end
		end
		state.cx:render()
	end)
	if err then
		state.loading = false
		state.problem = err
	end
end

-- Opens the item's source line and shows its spot in the PDF.
local function outline_open(state: OutlineState, it: OutlineItem, cx: BlockCx)
	local href = source_link(state.dir, it.file, it.line).href
	if href then
		cx:open(href)
	end
	show_in_pdf(state.dir, it.file, it.line, cx)
end

local function outline_row(it: OutlineItem): Item
	local label: { Span | string } = {}
	if it.level > 1 then
		table.insert(label, string.rep("  ", it.level - 1))
	end
	if it.number then
		table.insert(label, ui.span(it.number :: string .. "  ", "muted num"))
	end
	local title = if it.title ~= "" then it.title else it.label or it.kind
	table.insert(label, ui.span(title, if it.level == 1 and not FLOATS[it.kind] then "strong" else nil))
	return {
		label = label,
		value = if FLOATS[it.kind] then { ui.span(it.kind, "accent") } else nil,
	}
end

local function outline_list(state: OutlineState, items: { OutlineItem }, cx: BlockCx): Node
	local rows: { Item } = {}
	for _, it in items do
		table.insert(rows, outline_row(it))
	end
	local list = ui.list(rows)
	local kids = list.c or {}
	for i, it in items do
		with(kids[i], { key = it.key })
	end
	local shown = if state.show_problems then math.min(#state.problems, 8) else 0
	return with(list, {
		key = "items",
		selected = if state.cursor then OUTLINE_LIST .. state.cursor else nil,
		empty = { ui.span("No sections, floats or labelled equations yet.", "muted") },
		max = { lines = list_lines(cx, 6 + shown) },
	})
end

local function outline_problems(state: OutlineState): Node?
	if #state.problems == 0 then
		return nil
	end
	local rows: { Node } = {}
	for _, p in state.problems do
		table.insert(rows, ui.text({
			ui.span(PROBLEM_TEXT[p.kind] or p.kind, if p.kind == "unused-label" then "muted" else "warning"),
			"  ",
			ui.span(p.key, "mono"),
			"  ",
			source_link(state.dir, p.file, p.line),
		}))
	end
	return with(ui.section({ ui.span("Problems", "strong"), ui.span("  " .. #state.problems, "muted num") }, rows), {
		key = "problems",
		collapsible = true,
		collapsed = not state.show_problems,
	})
end

local function outline_dock(state: OutlineState): Node
	local n = #(state.items or {})
	local row: { Node } = { ui.text({ ui.span(plural(n, "item"), "strong") }) }
	local p = #state.problems
	table.insert(row, if p > 0 then ui.badge(plural(p, "problem"), "warning") else ui.badge("no problems", "success"))
	local lines: { Node } = { ui.row(row) }
	if state.problem and state.items then
		table.insert(lines, ui.text({ ui.span(common.first_lines(state.problem :: string, 1), "warning"), ui.span("  showing the last outline", "muted") }))
	end
	table.insert(lines, ui.text({ ui.span("j/k move · enter open source · p problems · R refresh", "dim") }))
	return ui.col(lines)
end

tern.block.define("outline", {
	init = function(cx: BlockCx, args: { string }, saved: any): OutlineState
		local last = if type(saved) == "table" then saved else {}
		local dir, outside = block_project(cx, args[1], str(last.dir))
		local state: OutlineState = {
			cx = cx,
			timer = nil,
			dir = dir,
			doc = nil,
			items = nil,
			problems = {},
			cursor = str(last.cursor),
			show_problems = last.problems ~= false,
			loading = false,
			problem = nil,
			outside = outside,
		}
		adopt(state)
		if outside then
			return state
		end
		announce(cx, args[1], "outline", dir)
		outline_refresh(state)
		every(state, POLL_MS, function()
			outline_refresh(state)
		end)
		return state
	end,

	title = function(state: OutlineState): string?
		return if state.doc then "Outline · " .. state.doc else "Outline"
	end,

	view = function(state: OutlineState, cx: BlockCx): BlockView
		if state.outside then
			return { main = ui.col({ outside_card("outline", state.outside :: string) }) }
		end
		local items = state.items
		if items == nil then
			if state.problem then
				local card = ui.card({ ui.span("Could not read the outline", "strong") }, {
					ui.code(state.problem :: string),
					ui.row({ button("Retry", "refresh", "accent") }),
				})
				return { main = ui.col({ with(card, { tone = "error" }) }) }
			end
			return { main = ui.col({ ui.progress(nil, "Reading the outline…") }) }
		end
		local main: { Node } = { outline_list(state, items, cx) }
		local problems = outline_problems(state)
		if problems then
			table.insert(main, problems)
		end
		return { main = ui.col(main), dock = outline_dock(state) }
	end,

	key = function(state: OutlineState, key: Key, cx: BlockCx): boolean?
		if key.ctrl or key.alt or key.meta then
			return false
		end
		local i = outline_index(state)
		local k = key.text or key.name
		local items = state.items or {}
		if key.name == "up" or k == "k" then
			outline_move(state, i - 1)
		elseif key.name == "down" or k == "j" then
			outline_move(state, i + 1)
		elseif key.name == "home" or k == "g" then
			outline_move(state, 1)
		elseif key.name == "end" or k == "G" then
			outline_move(state, #items)
		elseif key.name == "enter" and items[i] then
			outline_open(state, items[i], cx)
			return false
		elseif k == "p" then
			state.show_problems = not state.show_problems
		elseif k == "R" then
			outline_refresh(state)
		else
			return false
		end
		return true
	end,

	event = function(state: OutlineState, ev: UiEvent, cx: BlockCx)
		if ev.ev == "toggle" and ev.key == "problems" and type(ev.collapsed) == "boolean" then
			state.show_problems = not ev.collapsed
		elseif ev.ev == "action" and ev.act == "refresh" then
			outline_refresh(state)
		elseif (ev.ev == "select" or ev.ev == "activate") and type(ev.item) == "string" then
			state.cursor = string.sub(ev.item, #OUTLINE_LIST + 1)
			local it = (state.items or {})[outline_index(state)]
			if it then
				outline_open(state, it, cx)
			end
		end
	end,

	save = function(state: OutlineState): any
		return { dir = state.dir, cursor = state.cursor, problems = state.show_problems }
	end,
})

-- Typed text appended to a one-line input: newlines and tabs become spaces.
local function typed(input: string, text: string): string
	return input .. (string.gsub(text, "%s", " "))
end

-- `input` without its last character.
local function backspace(input: string): string
	local n = utf8.len(input)
	if n == nil or n == 0 then
		return string.sub(input, 1, -2)
	end
	return string.sub(input, 1, (utf8.offset(input, n) or #input) - 1)
end

-- A one-line input with a caret.
local function input_line(prompt: string, text: string, placeholder: string): Node
	return ui.text({
		ui.span(prompt, "accent strong"),
		if text == "" then ui.span(placeholder, "dim") else ui.span(text, "strong"),
		ui.span("▏", "accent"),
	})
end

---------------------------------------------------------------------------
-- Block `cite` (picture-in-picture over an editor): `ternlatex refs find`,
-- inserted at the caret the `cite` command saw.

type CiteItem = { key: string, year: string, creators: string, title: string, source: string }
type RefsFound = { cite: string, variants: { string }, items: { CiteItem }, zotero_error: string? }
type CiteState = {
	cx: BlockCx,
	timer: TimerHandle?, -- the search debounce
	dir: string,
	path: string,
	line: number,
	col: number,
	query: string,
	items: { CiteItem },
	searched: boolean,
	cursor: number,
	marked: { CiteItem },
	variants: { string },
	variant: number,
	zotero_error: string?,
	problem: string?,
	loading: boolean,
	again: boolean,
	-- ↑/↓ moved since the query last changed: space marks instead of typing.
	browsing: boolean,
	importing: boolean,
}

local CITE_DEBOUNCE_MS = 200
-- The list is keyed `results`: each row's id is `main.results.r<index>`.
local CITE_LIST = "main.results.r"

local function parse_refs(stdout: string): RefsFound?
	local ok, data = pcall(tern.json.decode, stdout)
	if not ok or type(data) ~= "table" or type(data.items) ~= "table" then
		return nil
	end
	local items: { CiteItem } = {}
	for _, it in data.items do
		if type(it) == "table" and type(it.key) == "string" and it.key ~= "" then
			table.insert(items, {
				key = it.key,
				year = str(it.year) or (if type(it.year) == "number" then tostring(it.year) else ""),
				creators = str(it.creators) or "",
				title = str(it.title) or "",
				source = str(it.source) or "bib",
			})
		end
	end
	local variants: { string } = {}
	for _, v in (if type(data.variants) == "table" then data.variants else {}) do
		if type(v) == "string" and v ~= "" then
			table.insert(variants, v)
		end
	end
	local cite = str(data.cite) or variants[1] or "\\cite"
	if table.find(variants, cite) == nil then
		table.insert(variants, 1, cite)
	end
	return { cite = cite, variants = variants, items = items, zotero_error = str(data.zotero_error) }
end

local function cite_search(state: CiteState)
	if not alive(state) then
		return
	end
	if state.loading then
		state.again = true -- the query changed mid-search: search once more after
		return
	end
	state.loading = true
	local args = { "refs", "find" }
	for word in string.gmatch(state.query, "%S+") do
		local w = string.gsub(word, "^%-+", "") -- never an option
		if w ~= "" then
			table.insert(args, w)
		end
	end
	table.insert(args, "--json")
	table.insert(args, "--limit")
	table.insert(args, "30")
	local err = run_cli(args, state.dir, function(result)
		if not alive(state) then
			return
		end
		state.loading = false
		if state.again then
			state.again = false
			cite_search(state)
			return
		end
		if result.status ~= 0 then
			state.problem = common.outcome(result)
		else
			local found = parse_refs(result.stdout)
			if found == nil then
				state.problem = "`ternlatex refs find --json` printed something else:\n" .. common.first_lines(result.stdout, 4)
			else
				local current = state.variants[state.variant]
				state.problem = nil
				state.items = found.items
				state.zotero_error = found.zotero_error
				state.searched = true
				state.cursor = 1
				state.variants = found.variants
				state.variant = (if current then table.find(found.variants, current) else nil)
					or table.find(found.variants, found.cite)
					or 1
			end
		end
		state.cx:render()
	end)
	if err then
		state.loading = false
		state.problem = err
	end
end

-- The query changed: search once typing pauses.
local function cite_schedule(state: CiteState)
	state.browsing = false
	if state.timer then
		state.timer:cancel()
	end
	state.timer = tern.timer(CITE_DEBOUNCE_MS, function()
		state.timer = nil
		cite_search(state)
	end)
end

local function marked_index(state: CiteState, key: string): number?
	for i, it in state.marked do
		if it.key == key then
			return i
		end
	end
	return nil
end

-- Inserts the marked entries (else the selected one), importing Zotero
-- entries into the project's .bib first.
local function cite_insert(state: CiteState, cx: BlockCx)
	if state.importing then
		return
	end
	local chosen: { CiteItem } = table.clone(state.marked)
	if #chosen == 0 then
		local current = state.items[state.cursor]
		if current == nil then
			return
		end
		chosen = { current }
	end
	local keys: { string } = {}
	local zotero: { string } = { "refs", "add" }
	for _, it in chosen do
		table.insert(keys, it.key)
		if it.source == "zotero" then
			table.insert(zotero, it.key)
		end
	end
	local text = (state.variants[state.variant] or "\\cite") .. "{" .. table.concat(keys, ",") .. "}"
	local function insert()
		local err = send_link(cx, "insert", { path = state.path, line = state.line, col = state.col, text = text })
		if err then
			cx:toast("error", "Citation not inserted", err)
		end
	end
	if #zotero == 2 then
		insert()
		return
	end
	state.importing = true
	local err = run_cli(zotero, state.dir, function(result)
		state.importing = false
		if not alive(state) then
			return
		end
		if result.status ~= 0 then
			cx:toast("error", "Zotero import failed", common.outcome(result))
			state.cx:render()
			return
		end
		insert()
	end)
	if err then
		state.importing = false
		cx:toast("error", "Zotero import failed", err)
	end
end

local function cite_list(state: CiteState, cx: BlockCx): Node
	local rows: { Item } = {}
	for _, it in state.items do
		local marked = marked_index(state, it.key) ~= nil
		local label: { Span | string } = {
			ui.span(if marked then "● " else "  ", "accent strong"),
			ui.span(it.key, "strong"),
		}
		if it.year ~= "" then
			table.insert(label, ui.span("  " .. it.year, "muted num"))
		end
		local detail: { Span | string } = {}
		if it.creators ~= "" then
			table.insert(detail, ui.span(it.creators .. "  ", "muted"))
		end
		table.insert(detail, it.title)
		table.insert(rows, {
			label = label,
			detail = detail,
			value = { ui.span(it.source, if it.source == "zotero" then "accent" else "muted") },
		})
	end
	local list = ui.list(rows)
	local kids = list.c or {}
	for i in state.items do
		with(kids[i], { key = "r" .. i })
	end
	return with(list, {
		key = "results",
		selected = if state.items[state.cursor] then CITE_LIST .. state.cursor else nil,
		empty = { ui.span(if state.searched then "No matching entries." else "Searching…", "muted") },
		max = { lines = list_lines(cx, 7) },
	})
end

tern.block.define("cite", {
	init = function(cx: BlockCx, args: { string }, _saved: any): CiteState
		local state: CiteState = {
			cx = cx,
			timer = nil,
			dir = common.normalize(args[1] or cx.cwd or ""),
			path = args[2] or "",
			line = tonumber(args[3]) or 1,
			col = tonumber(args[4]) or 1,
			query = "",
			items = {},
			searched = false,
			cursor = 1,
			marked = {},
			variants = {},
			variant = 1,
			zotero_error = nil,
			problem = nil,
			loading = false,
			again = false,
			browsing = false,
			importing = false,
		}
		adopt(state)
		cite_search(state)
		return state
	end,

	title = function(_state: CiteState): string?
		return "Insert citation"
	end,

	view = function(state: CiteState, cx: BlockCx): BlockView
		local variant = state.variants[state.variant] or "\\cite"
		local main: { Node } = {
			ui.row({ ui.badge(variant, "accent"), input_line("› ", state.query, "author, title, year or key") }),
		}
		if state.problem then
			table.insert(main, ui.text({ ui.span(common.first_lines(state.problem :: string, 2), "error") }))
		end
		if state.zotero_error then
			table.insert(main, ui.text({ ui.span("Zotero: " .. common.first_lines(state.zotero_error :: string, 1), "muted") }))
		end
		table.insert(main, cite_list(state, cx))
		local status: { Span | string } = {}
		if state.importing then
			table.insert(status, ui.span("importing from Zotero…  ", "accent"))
		elseif state.loading then
			table.insert(status, ui.span("searching…  ", "muted"))
		end
		if #state.marked > 0 then
			table.insert(status, ui.span(#state.marked .. " marked  ", "accent"))
		end
		table.insert(status, ui.span("↑/↓ move · space mark (after ↑/↓) · tab variant · enter insert · esc close", "dim"))
		return { main = ui.col(main), dock = ui.col({ ui.text(status) }) }
	end,

	key = function(state: CiteState, key: Key, cx: BlockCx): boolean?
		local name = key.name
		if name == "escape" then
			close(state, cx)
			return false
		elseif name == "up" then
			state.cursor = math.max(1, state.cursor - 1)
			state.browsing = true
		elseif name == "down" then
			state.cursor = math.min(math.max(1, #state.items), state.cursor + 1)
			state.browsing = true
		elseif name == "tab" then
			local n = math.max(1, #state.variants)
			state.variant = if key.shift then (state.variant - 2) % n + 1 else state.variant % n + 1
		elseif name == "enter" then
			cite_insert(state, cx)
		elseif name == "space" and state.browsing then
			local it = state.items[state.cursor]
			if it == nil then
				return false
			end
			local at = marked_index(state, it.key)
			if at then
				table.remove(state.marked, at)
			else
				table.insert(state.marked, it)
			end
			state.cursor = math.min(#state.items, state.cursor + 1)
		elseif name == "backspace" then
			if state.query == "" then
				return false
			end
			state.query = backspace(state.query)
			cite_schedule(state)
		elseif name == "paste" or (key.text and key.text ~= "" and not key.ctrl and not key.meta) then
			state.query = typed(state.query, key.text or "")
			cite_schedule(state)
		else
			return false
		end
		return true
	end,

	event = function(state: CiteState, ev: UiEvent, cx: BlockCx)
		if (ev.ev == "select" or ev.ev == "activate") and type(ev.item) == "string" then
			local i = tonumber(string.sub(ev.item, #CITE_LIST + 1))
			if i and state.items[i] then
				state.cursor = i
				if ev.ev == "activate" then
					cite_insert(state, cx)
				end
			end
		end
	end,
})

---------------------------------------------------------------------------
-- Block `rewrite` (docked below an editor): alternatives for the sentence
-- (or selection) from `ternlatex rewrite`, one replaces it.

type Spot = { line: number, col: number }
type Alternative = { text: string, note: string }
type Rewrite = { from: Spot, to: Spot, text: string, alternatives: { Alternative }, rejected: number }
type RewriteState = {
	cx: BlockCx,
	timer: TimerHandle?,
	dir: string,
	path: string,
	line: number,
	col: number,
	to_line: number?,
	to_col: number?,
	-- Bumped per request; answers to older ones are dropped.
	gen: number,
	loading: boolean,
	problem: string?,
	result: Rewrite?,
	-- The last original text, shown while asking again.
	original: string?,
	cursor: number,
	instruction: string?,
	-- Typing an instruction (after `/`) into `draft`.
	typing: boolean,
	draft: string,
}

local function spot(v: any): Spot?
	if type(v) == "table" and type(v.line) == "number" and type(v.col) == "number" then
		return { line = v.line, col = v.col }
	end
	return nil
end

local function parse_rewrite(stdout: string): Rewrite?
	local ok, data = pcall(tern.json.decode, stdout)
	if not ok or type(data) ~= "table" or type(data.text) ~= "string" or type(data.alternatives) ~= "table" then
		return nil
	end
	local from, to = spot(data.from), spot(data.to)
	if from == nil or to == nil then
		return nil
	end
	local alternatives: { Alternative } = {}
	for _, a in data.alternatives do
		if type(a) == "table" and type(a.text) == "string" then
			table.insert(alternatives, { text = a.text, note = str(a.note) or "" })
		end
	end
	return { from = from, to = to, text = data.text, alternatives = alternatives, rejected = num(data.rejected) or 0 }
end

local function rewrite_run(state: RewriteState)
	if not alive(state) then
		return
	end
	state.gen += 1
	local gen = state.gen
	state.loading = true
	state.problem = nil
	state.result = nil
	state.cursor = 1
	local args = { "rewrite", relative(state.path, state.dir) .. ":" .. state.line .. ":" .. state.col }
	if state.to_line and state.to_col then
		table.insert(args, "--to")
		table.insert(args, state.to_line .. ":" .. state.to_col)
	end
	table.insert(args, "--json")
	if state.instruction then
		table.insert(args, "--instruction")
		table.insert(args, state.instruction :: string)
	end
	local err = run_cli(args, state.dir, function(result)
		if not alive(state) or gen ~= state.gen then
			return
		end
		state.loading = false
		if result.status ~= 0 then
			state.problem = common.outcome(result)
		else
			local r = parse_rewrite(result.stdout)
			if r == nil then
				state.problem = "`ternlatex rewrite --json` printed something else:\n" .. common.first_lines(result.stdout, 4)
			else
				state.result = r
				state.original = r.text
			end
		end
		state.cx:render()
	end)
	if err then
		state.loading = false
		state.problem = err
	end
end

local function rewrite_pick(state: RewriteState, n: number, cx: BlockCx)
	local r = state.result
	local alt = if r then r.alternatives[n] else nil
	if r == nil or alt == nil then
		return
	end
	state.cursor = n
	local err = send_link(cx, "replace", { path = state.path, from = r.from, to = r.to, expect = r.text, text = alt.text })
	if err then
		cx:toast("error", "Sentence not replaced", err)
	end
end

local function words(text: string): { string }
	local out: { string } = {}
	for w in string.gmatch(text, "%S+") do
		table.insert(out, w)
	end
	return out
end

-- `alt` as spans with the words `original` lacks marked inserted (a
-- longest-common-subsequence word diff); plain when the texts are long.
local function word_diff(original: string, alt: string): { Span | string }
	local a, b = words(original), words(alt)
	if #a * #b > 40000 then
		return { alt }
	end
	-- lcs[i][j]: the common subsequence length of a[i..] and b[j..].
	local lcs: { { number } } = {}
	for i = #a + 1, 1, -1 do
		local row: { number } = {}
		for j = #b + 1, 1, -1 do
			if i > #a or j > #b then
				row[j] = 0
			elseif a[i] == b[j] then
				row[j] = lcs[i + 1][j + 1] + 1
			else
				row[j] = math.max(lcs[i + 1][j], row[j + 1])
			end
		end
		lcs[i] = row
	end
	local out: { Span | string } = {}
	local run: { string } = {}
	local inserted = false
	local function flush()
		if #run > 0 then
			local text = table.concat(run, " ") .. " "
			table.insert(out, if inserted then ui.span(text, "ins") else text)
			run = {}
		end
	end
	local i, j = 1, 1
	while j <= #b do
		if i <= #a and a[i] == b[j] then
			if inserted then
				flush()
				inserted = false
			end
			table.insert(run, b[j])
			i += 1
			j += 1
		elseif i <= #a and lcs[i + 1][j] >= lcs[i][j + 1] then
			i += 1 -- a word of the original the alternative drops
		else
			if not inserted then
				flush()
				inserted = true
			end
			table.insert(run, b[j])
			j += 1
		end
	end
	flush()
	return out
end

local function rewrite_main(state: RewriteState): { Node }
	local main: { Node } = {}
	if state.original then
		table.insert(main, ui.text({ ui.span(state.original :: string, "muted") }))
	end
	if state.typing then
		table.insert(main, input_line("/ ", state.draft, "how to rewrite it (⏎ asks again, esc cancels)"))
	elseif state.instruction then
		table.insert(main, ui.text({ ui.span("/ " .. state.instruction :: string, "muted") }))
	end
	if state.loading then
		table.insert(main, ui.progress(nil, "Asking omp's rewrite model…"))
		return main
	end
	if state.problem then
		local card = ui.card({ ui.span("No alternatives", "strong") }, {
			ui.code(state.problem :: string),
			ui.row({ button("Ask again", "again", "accent") }),
		})
		table.insert(main, with(card, { tone = "error" }))
		return main
	end
	local r = state.result
	if r == nil then
		return main
	end
	for i, alt in r.alternatives do
		local head: { Span | string } = { ui.span(tostring(i), "key"), "  ", ui.span(alt.note, "muted") }
		table.insert(main, with(ui.card(head, { ui.text(word_diff(r.text, alt.text)) }), {
			key = "a" .. i,
			tone = if i == state.cursor then "accent" else nil,
			actions = { click = "pick=" .. i },
		}))
	end
	if #r.alternatives == 0 then
		table.insert(main, ui.text({ ui.span("No usable alternatives; r asks again.", "muted") }))
	end
	if r.rejected > 0 then
		local dropped = plural(r.rejected, "alternative") .. " dropped: they changed commands, math or references."
		table.insert(main, ui.text({ ui.span(dropped, "dim") }))
	end
	return main
end

tern.block.define("rewrite", {
	init = function(cx: BlockCx, args: { string }, _saved: any): RewriteState
		local dir = common.normalize(args[1] or cx.cwd or "")
		local state: RewriteState = {
			cx = cx,
			timer = nil,
			dir = dir,
			path = args[2] or "",
			line = tonumber(args[3]) or 1,
			col = tonumber(args[4]) or 1,
			to_line = tonumber(args[5] or ""),
			to_col = tonumber(args[6] or ""),
			gen = 0,
			loading = false,
			problem = nil,
			result = nil,
			original = nil,
			cursor = 1,
			instruction = nil,
			typing = false,
			draft = "",
		}
		adopt(state)
		rewrite_run(state)
		return state
	end,

	title = function(_state: RewriteState): string?
		return "Rewrite sentence"
	end,

	view = function(state: RewriteState, _cx: BlockCx): BlockView
		local hint = if state.typing
			then "enter ask again · esc cancel"
			else "1–9 pick · j/k move · enter pick · r ask again · / instruct · esc close"
		return { main = ui.col(rewrite_main(state)), dock = ui.col({ ui.text({ ui.span(hint, "dim") }) }) }
	end,

	key = function(state: RewriteState, key: Key, cx: BlockCx): boolean?
		local name = key.name
		if state.typing then
			if name == "escape" then
				state.typing = false
			elseif name == "enter" then
				local text = string.match(state.draft, "^%s*(.-)%s*$") or ""
				state.instruction = if text == "" then nil else text
				state.typing = false
				rewrite_run(state)
			elseif name == "backspace" then
				state.draft = backspace(state.draft)
			elseif name == "paste" or (key.text and key.text ~= "" and not key.ctrl and not key.meta) then
				state.draft = typed(state.draft, key.text or "")
			else
				return false
			end
			return true
		end
		if key.ctrl or key.alt or key.meta then
			return false
		end
		local k = key.text or name
		local alternatives = if state.result then state.result.alternatives else {}
		local digit = tonumber(k)
		if name == "escape" then
			close(state, cx)
			return false
		elseif digit and digit >= 1 and digit <= 9 and string.match(k, "^%d$") then
			rewrite_pick(state, digit, cx)
		elseif name == "up" or k == "k" then
			state.cursor = math.max(1, state.cursor - 1)
		elseif name == "down" or k == "j" then
			state.cursor = math.min(math.max(1, #alternatives), state.cursor + 1)
		elseif name == "enter" then
			rewrite_pick(state, state.cursor, cx)
		elseif k == "r" then
			rewrite_run(state)
		elseif k == "/" then
			state.typing = true
			state.draft = state.instruction or ""
		else
			return false
		end
		return true
	end,

	event = function(state: RewriteState, ev: UiEvent, cx: BlockCx)
		if ev.ev ~= "action" then
			return
		end
		if ev.act == "again" then
			rewrite_run(state)
		elseif ev.act == "pick" then
			local n = tonumber(ev.value)
			if n then
				rewrite_pick(state, n, cx)
			end
		end
	end,
})

---------------------------------------------------------------------------
-- Block `peek` (picture-in-picture over an editor): the PDF around the
-- caret's line. The window half stores the focused `.tex` block's
-- `{path, line}` in `tern.kv` key `peek`; this block polls it.

type PeekState = {
	cx: BlockCx,
	timer: TimerHandle?,
	dir: string,
	-- The project-relative `file:line` the caret is on.
	want: string?,
	-- The `want` last rendered (or tried).
	tried: string?,
	rendering: boolean,
	-- What the image shows.
	blob: string?,
	shown_file: string?,
	shown_line: number?,
	caption: string?,
	-- Why the last render failed (the image stays).
	note: string?,
}

local PEEK_MS = 300
-- Rendered crops are a few hundred KiB.
local MAX_PNG = 32 * 1024 * 1024

local function peek_render(state: PeekState, target: string)
	state.rendering = true
	state.tried = target
	local file, line = string.match(target, "^(.*):(%d+)$")
	local err = run_cli({ "peek", target, "--json" }, state.dir, function(result)
		state.rendering = false
		if not alive(state) then
			return
		end
		if result.status ~= 0 then
			state.note = common.outcome(result)
		else
			local ok, data = pcall(tern.json.decode, result.stdout)
			if not ok or type(data) ~= "table" or type(data.png) ~= "string" then
				state.note = "`ternlatex peek --json` printed something else:\n" .. common.first_lines(result.stdout, 4)
			else
				local read, bytes = pcall(tern.fs.read, data.png, MAX_PNG)
				if not read then
					state.note = tostring(bytes)
				else
					state.blob = state.cx:blob(bytes, "image/png")
					state.shown_file = file
					state.shown_line = tonumber(line)
					local where: { string } = {}
					if type(data.doc) == "string" then
						table.insert(where, data.doc)
					end
					if type(data.page) == "number" then
						table.insert(where, "page " .. data.page)
					end
					state.caption = table.concat(where, " · ")
					state.note = nil
				end
			end
		end
		state.cx:render()
	end)
	if err then
		state.rendering = false
		state.note = err
	end
end

local function peek_tick(state: PeekState)
	local ok, at = pcall(tern.kv.get, "peek")
	if ok and type(at) == "table" and type(at.path) == "string" and type(at.line) == "number" and common.inside(at.path, state.dir) then
		state.want = relative(at.path, state.dir) .. ":" .. math.floor(at.line)
	end
	if state.want and not state.rendering and state.want ~= state.tried then
		peek_render(state, state.want :: string)
		state.cx:render()
	end
end

-- Forward search to what the image shows.
local function peek_show(state: PeekState, cx: BlockCx)
	if state.shown_file and state.shown_line then
		show_in_pdf(state.dir, state.shown_file :: string, state.shown_line :: number, cx)
	end
end

tern.block.define("peek", {
	init = function(cx: BlockCx, args: { string }, saved: any): PeekState
		local dir = args[1] or (if type(saved) == "table" then str(saved.dir) else nil) or cx.cwd or ""
		local state: PeekState = {
			cx = cx,
			timer = nil,
			dir = common.normalize(dir),
			want = nil,
			tried = nil,
			rendering = false,
			blob = nil,
			shown_file = nil,
			shown_line = nil,
			caption = nil,
			note = nil,
		}
		adopt(state)
		peek_tick(state)
		every(state, PEEK_MS, function()
			peek_tick(state)
		end)
		return state
	end,

	title = function(state: PeekState): string?
		return if state.caption and state.caption ~= "" then "PDF · " .. state.caption else "PDF peek"
	end,

	view = function(state: PeekState, _cx: BlockCx): BlockView
		local main: { Node } = {}
		if state.blob then
			table.insert(main, ui.node("image", {
				key = "image",
				blob = state.blob,
				alt = "The PDF around " .. (state.shown_file or "") .. ":" .. (state.shown_line or ""),
				actions = { click = "show" },
			}))
		elseif state.note == nil then
			local waiting = if state.rendering then "Rendering…" else "Move the caret in a .tex file of this project."
			table.insert(main, ui.text({ ui.span(waiting, "muted") }))
		end
		if state.note then
			table.insert(main, ui.text({ ui.span(common.first_lines(state.note :: string, 2), "muted") }))
		end
		local caption: { Span | string } = {}
		if state.caption and state.caption ~= "" then
			table.insert(caption, ui.span(state.caption :: string, "muted"))
		end
		if state.rendering then
			table.insert(caption, ui.span("  rendering…", "dim"))
		end
		local dock: { Node } = { ui.text({ ui.span("enter show in PDF · R refresh · esc close", "dim") }) }
		if #caption > 0 then
			table.insert(dock, 1, ui.text(caption))
		end
		return { main = ui.col(main), dock = ui.col(dock) }
	end,

	key = function(state: PeekState, key: Key, cx: BlockCx): boolean?
		if key.ctrl or key.alt or key.meta then
			return false
		end
		local k = key.text or key.name
		if key.name == "escape" then
			close(state, cx)
		elseif key.name == "enter" then
			peek_show(state, cx)
		elseif k == "R" then
			state.tried = nil
			peek_tick(state)
			return true
		end
		return false
	end,

	event = function(state: PeekState, ev: UiEvent, cx: BlockCx)
		if ev.ev == "action" and ev.act == "show" then
			peek_show(state, cx)
		end
	end,

	save = function(state: PeekState): any
		return { dir = state.dir }
	end,
})

---------------------------------------------------------------------------
-- Hint: a shell entered a project whose dev server is not running.

local SHELLS: { [string]: boolean } = {
	sh = true,
	bash = true,
	zsh = true,
	fish = true,
	dash = true,
	ksh = true,
	tcsh = true,
	csh = true,
	nu = true,
	elvish = true,
	xonsh = true,
	pwsh = true,
	powershell = true,
	cmd = true,
}

-- Projects each pane was already told about.
local told: { [number]: { [string]: boolean } } = {}

local function shell(program: string?): boolean
	if program == nil then
		return false
	end
	local name = string.lower(common.basename(program))
	name = string.gsub(string.gsub(name, "^%-", ""), "%.exe$", "")
	return SHELLS[name] == true
end

-- Whether the dev block in `cwd` serves `project`. Shells report logical
-- paths and Tern resolved ones (`/tmp` vs `/private/tmp`), and the host
-- cannot resolve links: the same name with the same ternlatex.toml counts.
local function serves(cwd: string, project: string): boolean
	local other = common.project(cwd)
	if other == nil then
		return false
	end
	if other == project then
		return true
	end
	if common.basename(other) ~= common.basename(project) then
		return false
	end
	local ok_a, a = pcall(tern.fs.read, common.join(other, "ternlatex.toml"), 256 * 1024)
	local ok_b, b = pcall(tern.fs.read, common.join(project, "ternlatex.toml"), 256 * 1024)
	return ok_a and ok_b and a == b
end

tern.on("cwd", function(ev: CwdEvent, cx: EffectCx)
	local project = common.project(ev.path)
	if project == nil then
		return
	end
	local seen = told[ev.pane] or {}
	if seen[project] then
		return
	end
	local is_shell = false
	for _, p in tern.pane.list() do
		if p.pane == ev.pane then
			is_shell = shell(p.program)
		elseif common.status(p.title) and p.cwd and serves(p.cwd :: string, project) then
			return -- its dev server runs
		end
	end
	if not is_shell then
		return
	end
	seen[project] = true
	told[ev.pane] = seen
	cx:toast("info", "ternlatex project — palette: Start ternlatex here (or run `ternlatex dev`)", project)
end)

tern.on("pane_exited", function(ev: PaneExitedEvent, _cx: EffectCx)
	told[ev.pane] = nil
end)
