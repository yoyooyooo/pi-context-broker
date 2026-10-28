--!strict
local composer = require("./composer")

-- Scope layout changes to the broker's dollar menu; keep native completion styling.
tern.css("completion", [[
.sf-overlay.at-caret[data-role="omp.autocomplete"][aria-label="Context Broker completions"] > .sf-ov-card {
  box-sizing: border-box;
  width: min(720px, calc(100% - 32px));
  min-width: 0;
  max-width: calc(100% - 32px) !important;
}
.sf-overlay.at-caret[data-role="omp.autocomplete"][aria-label="Context Broker completions"] .sf-item-label {
  flex: 0 1 auto;
  max-width: 60%;
}
]])

local function complete(cx)
    local pane = cx.session:focused()
    if not pane then return end
    local saved = composer.snapshot(cx, pane)
    if not saved or not saved.prefix then
      cx:toast("info", "Context Broker", "Manual completion requires a local OMP native draft with the cursor after $ or a $name prefix. Terminal completion belongs to the Broker editor.")
      return
    end
    local settingsPath = tern.plugin.data .. "/config.json"
    local settings = {}
    if tern.fs.exists(settingsPath) then
      local ok, value = pcall(function() return tern.json.decode(tern.fs.read(settingsPath, 16384)) end)
      if not ok or type(value) ~= "table" then
        cx:toast("error", "Context Broker", "Invalid plugin-data/context-broker/config.json.")
        return
      end
      settings = value
    end
    for _, key in { "node", "config", "agentDir" } do
      if settings[key] ~= nil and (type(settings[key]) ~= "string" or settings[key] == "") then
        cx:toast("error", "Context Broker", key .. " must be a nonempty path.")
        return
      end
    end
    local queryPath = tern.plugin.dir .. "/query/completion.mjs"
    if not tern.fs.exists(queryPath) then
      cx:toast("error", "Context Broker", "Missing bundled query. Install a release package or run bun run build before linking.")
      return
    end
    local request = { version = 1, text = saved.text, cursor = saved.cursor, cwd = saved.cwd, config = settings.config }
    local env = { CONTEXT_BROKER_HOST = "omp" }
    if settings.agentDir then env.PI_CODING_AGENT_DIR = settings.agentDir end
    if not composer.acquire(saved) then
      cx:toast("info", "Context Broker", "A native Context Broker operation is already open.")
      return
    end
    local started, failure = pcall(function()
      tern.process.run({ settings.node or "node", queryPath }, {
        cwd = saved.cwd, env = env, stdin = tern.json.encode(request), timeout_ms = 10000,
      }, function(result, queryCx)
        if not composer.owns(saved) then return end
        composer.release(saved)
        if not queryCx then return end
        if queryCx.session:focused() ~= saved.pane or not composer.unchanged(queryCx, saved) then
          return
        end
        if result.status ~= 0 then
          queryCx:toast("error", "Context Broker query failed", string.sub(result.stderr, 1, 500))
          return
        end
        local ok, response = pcall(function() return tern.json.decode(result.stdout) end)
        if not ok or type(response) ~= "table" or response.version ~= 1
          or type(response.edit) ~= "table" or type(response.items) ~= "table" then
          queryCx:toast("error", "Context Broker", "Invalid completion query response.")
          return
        end
        if type(response.failures) == "table" then
          for _, failure in response.failures do
            if type(failure) == "table" and type(failure.sourceId) == "string"
              and type(failure.code) == "string" and type(failure.message) == "string" then
              queryCx:toast("info", "Context Broker source unavailable", failure.sourceId .. " (" .. failure.code .. "): " .. failure.message)
            end
          end
        end
        local edit = response.edit
        if edit.prefix ~= saved.prefix or edit.to ~= saved.cursor
          or edit.from ~= saved.cursor - composer.utf16_length(saved.prefix)
          or edit.len ~= composer.utf16_length(saved.text) then
          queryCx:toast("error", "Context Broker", "Completion range does not match the draft.")
          return
        end
        local items = {}
        for _, item in response.items do
          if type(item) ~= "table" or type(item.value) ~= "string" or type(item.label) ~= "string"
            or string.sub(item.value, 1, 1) ~= "$" or string.find(item.value, "%s")
            or type(item.identity) ~= "string" or item.identity == "" or type(item.ref) ~= "string" or item.ref == ""
            or (item.kind ~= "skill" and item.kind ~= "router" and item.kind ~= "prompt")
            or (item.source ~= "local" and item.source ~= "notion")
            or (item.description ~= nil and type(item.description) ~= "string") then
            queryCx:toast("error", "Context Broker", "Invalid completion candidate.")
            return
          end
          table.insert(items, { label = item.label, detail = item.source .. " · " .. item.kind .. "\n" .. (item.description or ""),
            value = item.value, identity = item.identity, kind = item.kind, source = item.source, ref = item.ref })
        end
        if #items == 0 then
          queryCx:toast("info", "Context Broker", "No configured content matches " .. saved.prefix .. ".")
          return
        end
        if not composer.acquire(saved) then return end
        queryCx:pick({ items = items, placeholder = "Search Context Broker content (insert token only)", action = "insert" })
          :next(function(item, err, pickCx)
            if not composer.owns(saved) then return end
            if not pickCx then composer.release(saved) return end
            if pickCx.session:focused() ~= saved.pane or not composer.unchanged(pickCx, saved) then
              composer.release(saved)
              return
            end
            if err then composer.release(saved) pickCx:toast("error", "Context Broker", err) return end
            if not item then composer.release(saved) return end
            local byte = composer.byte_offset(saved.text, saved.cursor)
            if byte == nil then composer.release(saved) return end
            local suffix = if string.sub(saved.text, byte + 1, byte + 1) == " " then "" else " "
            local replacement = item.value .. suffix
            composer.edit(pickCx, saved, edit.from, edit.to, replacement)
            composer.release(saved)
          end)
      end)
    end)
    if not started then
      composer.release(saved)
      cx:toast("error", "Context Broker", "Cannot start Node.js 22.22.3+ within 22.x or 24.20.0+: " .. tostring(failure))
    end
end

tern.command({
  id = "complete",
  title = "Complete Context Broker content (OMP native)",
  icon = "puzzle",
  keys = { "ctrl+alt+shift+k" },
  run = complete,
})

tern.command({
  id = "cancel",
  title = "Cancel pending Context Broker native operation",
  icon = "puzzle",
  run = function(cx)
    composer.cancel()
    cx:toast("info", "Context Broker", "Pending completion cancelled. Your draft is unchanged. Close any open picker with Esc.")
  end,
})

