--!strict
local composer = {}
local owner = nil
local generation = 0

function composer.acquire(request): boolean
  if owner ~= nil then return false end
  generation += 1
  request.generation = generation
  owner = request
  return true
end

function composer.release(request)
  if owner == request then owner = nil end
end

function composer.owns(request): boolean
  return owner == request and request.generation == generation and request.cancelled ~= true
end

function composer.cancel()
  generation += 1
  if owner then owner.cancelled = true end
  owner = nil
end

function composer.find(node)
  if type(node) ~= "table" then return nil end
  if node.k == "editor" and type(node.p) == "table"
    and type(node.p.text) == "string" and type(node.p.cursor) == "number"
    and node.p.readonly ~= true and node.p.disabled ~= true and node.p.hidden ~= true then
    return node
  end
  for _, child in node.c or {} do
    local found = composer.find(child)
    if found then return found end
  end
  return nil
end

function composer.utf16_length(text: string): number
  local length = 0
  for _, codepoint in utf8.codes(text) do
    length += if codepoint > 0xFFFF then 2 else 1
  end
  return length
end

function composer.byte_offset(text: string, offset: number): number?
  if offset < 0 or offset % 1 ~= 0 then return nil end
  local units = 0
  for byte, codepoint in utf8.codes(text) do
    if units == offset then return byte - 1 end
    units += if codepoint > 0xFFFF then 2 else 1
    if units > offset then return nil end
  end
  return if units == offset then #text else nil
end

function composer.prefix(text: string, cursor: number): string?
  local byte = composer.byte_offset(text, cursor)
  if not byte then return nil end
  local before = string.sub(text, 1, byte)
  local prefix = string.match(before, "%$[^%s%$]*$")
  if not prefix then return nil end
  return prefix
end

-- Every async UI operation retains the same native draft and local cwd.
function composer.snapshot(cx, pane: number)
  local localPane = false
  for _, host in cx.hosts:list() do
    for _, id in host.panes do
      if id == pane then
        if host.kind ~= "local" then return nil end
        localPane = true
      end
    end
  end
  if not localPane then return nil end
  local info = cx.session:pane(pane)
  if not info or type(info.cwd) ~= "string" or info.cwd == "" then return nil end
  local session = cx.sessions:current()
  local tree = cx.session:surface(pane, { nodes = 5000, max_chars = 64000 })
  if type(tree) ~= "table" or type(tree.surface) ~= "table" or tree.surface.role ~= "omp.session" then return nil end
  local field = composer.find(tree.dock)
  if not field or type(field.id) ~= "string" or type(tree.surface.id) ~= "string"
    or composer.byte_offset(field.p.text, field.p.cursor) == nil then return nil end
  return { pane = pane, cwd = info.cwd, host = session.host, session = session.id,
    surface = tree.surface.id, id = field.id, text = field.p.text, cursor = field.p.cursor,
    prefix = composer.prefix(field.p.text, field.p.cursor) }
end

function composer.unchanged(cx, saved): boolean
  local current = composer.snapshot(cx, saved.pane)
  return saved.cancelled ~= true and current ~= nil and current.cwd == saved.cwd
    and current.host == saved.host and current.session == saved.session
    and current.surface == saved.surface and current.id == saved.id
    and current.text == saved.text and current.cursor == saved.cursor
end

-- A range edit is draft-only; the public API supplies no acknowledgement or attachment revision.
function composer.edit(cx, saved, from: number, to: number, text: string): boolean
  if not composer.owns(saved) or cx.session:focused() ~= saved.pane or not composer.unchanged(cx, saved) then
    return false
  end
  if from > to or composer.byte_offset(saved.text, from) == nil or composer.byte_offset(saved.text, to) == nil then
    return false
  end
  cx.session:event(saved.pane, { ev = "edit", id = saved.id, from = from, to = to,
    text = text, cursor = from + composer.utf16_length(text), len = composer.utf16_length(saved.text) })
  return true
end

return composer
