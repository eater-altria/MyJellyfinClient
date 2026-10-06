-- mjc-osc.lua — SenPlayer-style on-screen controller for MyJellyfinClient
-- White icon controls over translucent video surfaces; labels appear on hover.
-- Keep logical sizing stable and reflow only when the window becomes narrow.

local assdraw = require('mp.assdraw')
local utils = require('mp.utils')

local FONT = 'Microsoft YaHei'

local state = {
    osd_w = 1280, osd_h = 720,
    ui_scale = 1,
    info_offset = 0,
    bar_top = 0,
    visible = false,
    last_active = 0,
    persistent = false,
    duration = 0,
    timepos = 0,
    rewind_seconds = 15,
    forward_seconds = 15,
    precise_seek = false,
    settings = {
        autoHideControlsSeconds = 3,
        showSkipButtons = false, showSwitchMediaButton = true,
        showScreenshotButton = true, showPlayTitleToast = true,
        longPressLeftRate = 0.5, longPressRightRate = 2,
        numberKeyRateSwitch = false, mouseLeftClick = 'none',
        mouseLeftDoubleClick = 'playpause', mouseRightClick = 'toggleControls',
        doubleClickMilliseconds = 500,
        subtitleSearchHistory = true, rememberAudioTrack = true,
        rememberSubtitle = true, audioBoost = true,
    },
    held_key = nil,
    volume_key = nil,
    pending_click = nil,
    sub_query = '', sub_searching = false, sub_history = {},
    menu_offset = 0,
    remembered_applied = { audio = false, sub = false },
    preferred_applied = {},
    paused = false,
    speed = 1,
    volume = 100,
    mute = false,
    cache_kbs = -1,
    title = '',
    sid = nil,
    aid = nil,
    subs = {},
    audios = {},
    hwdec = 'auto-safe',
    info_visible = false,
    media_info = {},
    info_zones = {},
    menu = nil,          -- nil | 'speed' | 'sub' | 'audio' | 'more'
    zones = {},
    menu_zones = {},
    menu_anchors = {},
    top_zones = {},
    seek_drag = false,
    volume_drag = false,
    volume_slider = nil,
    fill_window = false,
    seek = nil,          -- {x0,y0,x1,y1} of the seekbar
}

-- ---------- helpers ----------
local function ass_color(alpha, r, g, b)
    local a = 255 - math.floor(alpha * 255 + 0.5)
    -- ASS colors contain BGR only; opacity is a separate override tag.
    return string.format('&H%02X%02X%02X&\\1a&H%02X&',
        math.floor(b * 255 + 0.5), math.floor(g * 255 + 0.5), math.floor(r * 255 + 0.5), a)
end

local function fmt_time(s)
    if not s or s ~= s or s < 0 then return '--:--' end
    s = math.floor(s + 0.5)
    local h = math.floor(s / 3600)
    local m = math.floor((s % 3600) / 60)
    local sec = s % 60
    if h > 0 then return string.format('%d:%02d:%02d', h, m, sec) end
    return string.format('%02d:%02d', m, sec)
end

local function fmt_kbs(kbs)
    if not kbs or kbs < 0 then return '' end
    if kbs >= 1048576 then return string.format('%.1f MB/s', kbs / 1048576) end
    if kbs >= 1024 then return string.format('%d KB/s', math.floor(kbs / 1024)) end
    return string.format('%d B/s', kbs)
end

local function clamp(v, a, b) return math.max(a, math.min(b, v)) end

local function zone(zones, x0, y0, x1, y1, action, name)
    zones[#zones + 1] = { x0 = x0, y0 = y0, x1 = x1, y1 = y1, action = action, name = name }
end

local function hit(zones, x, y)
    for _, z in ipairs(zones) do
        if x >= z.x0 and x <= z.x1 and y >= z.y0 and y <= z.y1 then return z end
    end
    return nil
end

local function text_width(str, fs)
    -- no utf8 stdlib in this LuaJIT: walk UTF-8 bytes manually
    local w = 0
    local i, n = 1, #str
    while i <= n do
        local b = str:byte(i)
        local wide
        if b < 0x80 then wide = false; i = i + 1
        elseif b < 0xE0 then wide = true; i = i + 2
        elseif b < 0xF0 then wide = true; i = i + 3
        else wide = true; i = i + 4 end
        w = w + (wide and fs or fs * 0.56)
    end
    return w
end

-- ---------- GPU glass backing ----------
-- Keep the backing geometry with the ASS layout; time-pos updates need not
-- resend identical parameters or rebuild the blur. Six surfaces cover the bar,
-- pause badge, side tools, hover label, menu and media info.
local glass_layers, glass_layer = {}, nil
local rendering_all = false
local last_glass_params = ''
local glass_supported = true
local GLASS_SURFACES = 6
-- Material defaults inspired by rdev/liquid-glass-react/src/index.tsx.
-- Its blurAmount maps to 4 + 32 * amount CSS pixels over a normal background.
-- These are appearance constants, independent of playback settings/layout.
local GLASS_MATERIAL = {
    displacement_scale = 70, blur_amount = 0.0625,
    saturation_percent = 140, aberration_intensity = 2,
}
local function begin_glass(layer)
    glass_layers[layer] = {}
    glass_layer = glass_layers[layer]
end
local function glass_surface(x0, y0, x1, y1, radius)
    if glass_layer and x1 > x0 and y1 > y0 then
        glass_layer[#glass_layer + 1] = {x0, y0, x1 - x0, y1 - y0, radius}
    end
end
local function publish_glass()
    if rendering_all or not glass_supported then return end
    local dim = mp.get_property_native('osd-dimensions') or {}
    local x, y = tonumber(dim.ml) or 0, tonumber(dim.mt) or 0
    local w = math.max(1, state.osd_w - x - (tonumber(dim.mr) or 0))
    local h = math.max(1, state.osd_h - y - (tonumber(dim.mb) or 0))
    local surfaces = {}
    for _, layer in ipairs({'bar', 'top', 'menu', 'info'}) do
        for _, rect in ipairs(glass_layers[layer] or {}) do
            if #surfaces < GLASS_SURFACES then surfaces[#surfaces + 1] = rect end
        end
    end
    local values = {surface_count = #surfaces, video_x = x, video_y = y,
        video_w = w, video_h = h, ui_scale = state.ui_scale}
    local target = mp.get_property_native('video-target-params') or {}
    -- Do not apply an SDR saturation matrix to PQ/HLG or linear HDR output.
    local hdr = target.gamma == 'pq' or target.gamma == 'hlg' or target.gamma == 'linear'
    values.displacement_scale = GLASS_MATERIAL.displacement_scale
    values.blur_px = 4 + 32 * GLASS_MATERIAL.blur_amount
    values.saturation = hdr and 1 or GLASS_MATERIAL.saturation_percent / 100
    values.aberration_intensity = GLASS_MATERIAL.aberration_intensity
    for i = 1, GLASS_SURFACES do
        local rect = surfaces[i] or {0, 0, 0, 0, 0}
        for j, field in ipairs({'x', 'y', 'w', 'h', 'radius'}) do
            values['r' .. i .. '_' .. field] = rect[j]
        end
    end
    local keys, signature = {}, {}
    for key in pairs(values) do keys[#keys + 1] = key end
    table.sort(keys)
    for _, key in ipairs(keys) do signature[#signature + 1] = string.format('%.3f', values[key]) end
    signature = table.concat(signature, ',')
    if signature == last_glass_params then return end
    local opts = mp.get_property_native('glsl-shader-opts') or {}
    for _, key in ipairs(keys) do opts['mjc-glass/' .. key] = string.format('%.3f', values[key]) end
    local ok, err = mp.set_property_native('glsl-shader-opts', opts)
    if not ok then
        glass_supported = false
        mp.msg.warn('Glass backing unavailable; keeping translucent controls: ' .. tostring(err))
    end
    last_glass_params = signature
end

-- ---------- drawing primitives ----------
local function new_ass()
    local a = assdraw.ass_new()
    local new_event = a.new_event
    function a:new_event()
        new_event(self)
        self:append('{\\r\\bord0\\shad0\\blur0\\fscx100\\fscy100}')
    end
    return a
end

-- rounded rect path via built-in shape helper
local function rrect_path(a, x0, y0, x1, y1, r)
    r = math.max(0, math.min(r, (x1 - x0) / 2, (y1 - y0) / 2))
    if r < 0.01 then
        a:rect_cw(x0, y0, x1, y1)
    else
        a:round_rect_cw(x0, y0, x1, y1, r)
    end
end

local function draw_round_rect(a, x0, y0, x1, y1, r, color, blur)
    a:new_event()
    a:pos(0, 0)
    a:append('{\\an7\\p4\\c' .. color .. '\\bord0\\shad0' .. (blur and '\\blur' .. blur or '') .. '}')
    rrect_path(a, x0, y0, x1, y1, r)
    a:append('{\\p0}')
end

-- sub-path rounded rect (inside a multi-shape event)
local function sub_rrect(a, x0, y0, x1, y1, r)
    rrect_path(a, x0, y0, x1, y1, r)
end

local function draw_text(a, x, y, fs, color, str, align)
    align = align or 7 -- 7 = top-left
    a:new_event()
    a:pos(x, y)
    a:append('{\\an' .. align .. '\\fs' .. fs .. '\\fn' .. FONT ..
        '\\c' .. color .. '\\bord0\\shad0\\fscx100\\fscy100\\fsp0\\b0}')
    a:append(str:gsub('\\', '＼'):gsub('{', '｛'):gsub('}', '｝'):gsub('[\r\n]', ' '))
end

local function draw_play_icon(a, cx, cy, s, color)
    a:new_event()
    a:pos(0, 0)
    a:append('{\\an7\\p4\\c' .. color .. '\\bord0}')
    a:move_to(cx - s * 0.35, cy - s * 0.5)
    a:line_to(cx + s * 0.55, cy)
    a:line_to(cx - s * 0.35, cy + s * 0.5)
    a:line_to(cx - s * 0.35, cy - s * 0.5)
    a:append('{\\p0}')
end

local function draw_pause_icon(a, cx, cy, s, color)
    a:new_event()
    a:pos(0, 0)
    a:append('{\\an7\\p4\\c' .. color .. '\\bord0}')
    sub_rrect(a, cx - s * 0.42, cy - s * 0.5, cx - s * 0.12, cy + s * 0.5, s * 0.08)
    sub_rrect(a, cx + s * 0.12, cy - s * 0.5, cx + s * 0.42, cy + s * 0.5, s * 0.08)
    a:append('{\\p0}')
end

local function draw_seek_icon(a, cx, cy, s, color, direction)
    a:new_event()
    a:pos(0, 0)
    a:append('{\\an7\\p4\\c' .. color .. '\\bord0}')
    for _, offset in ipairs({-0.35, 0.35}) do
        local x = cx + offset * s
        a:move_to(x - direction * s * 0.3, cy - s * 0.5)
        a:line_to(x + direction * s * 0.3, cy)
        a:line_to(x - direction * s * 0.3, cy + s * 0.5)
        a:line_to(x - direction * s * 0.3, cy - s * 0.5)
    end
    a:append('{\\p0}')
end

local function draw_fs_icon(a, cx, cy, s, color)
    local l = s * 0.38
    local t = s * 0.16
    a:new_event()
    a:pos(0, 0)
    a:append('{\\an7\\p4\\c' .. color .. '\\bord0}')
    sub_rrect(a, cx - s, cy - s, cx - s + l, cy - s + t, 0)
    sub_rrect(a, cx - s, cy - s, cx - s + t, cy - s + l, 0)
    sub_rrect(a, cx + s - l, cy - s, cx + s, cy - s + t, 0)
    sub_rrect(a, cx + s - t, cy - s, cx + s, cy - s + l, 0)
    sub_rrect(a, cx - s, cy + s - t, cx - s + l, cy + s, 0)
    sub_rrect(a, cx - s, cy + s - l, cx - s + t, cy + s, 0)
    sub_rrect(a, cx + s - l, cy + s - t, cx + s, cy + s, 0)
    sub_rrect(a, cx + s - t, cy + s - l, cx + s, cy + s, 0)
    a:append('{\\p0}')
end

local function draw_vol_icon(a, cx, cy, s, color, muted)
    a:new_event()
    a:pos(0, 0)
    a:append('{\\an7\\p4\\c' .. color .. '\\bord0}')
    -- speaker body
    a:move_to(cx - s * 0.6, cy - s * 0.22)
    a:line_to(cx - s * 0.28, cy - s * 0.22)
    a:line_to(cx + s * 0.08, cy - s * 0.55)
    a:line_to(cx + s * 0.08, cy + s * 0.55)
    a:line_to(cx - s * 0.28, cy + s * 0.22)
    a:line_to(cx - s * 0.6, cy + s * 0.22)
    a:line_to(cx - s * 0.6, cy - s * 0.22)
    if muted then
        -- X mark
            a:move_to(cx + s * 0.26, cy - s * 0.30)
        a:line_to(cx + s * 0.64, cy + s * 0.08)
        a:line_to(cx + s * 0.52, cy + s * 0.20)
        a:line_to(cx + s * 0.14, cy - s * 0.18)
        a:line_to(cx + s * 0.26, cy - s * 0.30)
                a:move_to(cx + s * 0.14, cy + s * 0.20)
        a:line_to(cx + s * 0.52, cy - s * 0.18)
        a:line_to(cx + s * 0.64, cy - s * 0.30)
        a:line_to(cx + s * 0.26, cy + s * 0.32)
        a:line_to(cx + s * 0.14, cy + s * 0.20)
        else
        -- waves
        sub_rrect(a, cx + s * 0.22, cy - s * 0.18, cx + s * 0.32, cy + s * 0.18, s * 0.05)
        sub_rrect(a, cx + s * 0.44, cy - s * 0.34, cx + s * 0.54, cy + s * 0.34, s * 0.05)
    end
    a:append('{\\p0}')
end

local function draw_menu_icon(a, cx, cy, s, color)
    a:new_event()
    a:pos(0, 0)
    a:append('{\\an7\\p4\\c' .. color .. '\\bord0}')
    for i = -1, 1 do
        sub_rrect(a, cx + i * s * 0.45 - s * 0.09, cy - s * 0.09,
            cx + i * s * 0.45 + s * 0.09, cy + s * 0.09, s * 0.09)
    end
    a:append('{\\p0}')
end

local function draw_switch_icon(a, cx, cy, s, color, direction)
    a:new_event(); a:pos(0, 0)
    a:append('{\\an7\\p4\\c' .. color .. '\\bord0}')
    a:move_to(cx - direction * s * 0.35, cy - s * 0.5)
    a:line_to(cx + direction * s * 0.45, cy)
    a:line_to(cx - direction * s * 0.35, cy + s * 0.5)
    a:line_to(cx - direction * s * 0.35, cy - s * 0.5)
    a:append('{\\p0}')
    local x = cx + direction * s * 0.65
    draw_round_rect(a, x - s * 0.06, cy - s * 0.5, x + s * 0.06, cy + s * 0.5, s * 0.06, color)
end

local function draw_surface(a, x0, y0, x1, y1, radius, scale)
    glass_surface(x0, y0, x1, y1, radius)
    draw_round_rect(a, x0 - 3 * scale, y0 + 4 * scale, x1 + 3 * scale, y1 + 5 * scale,
        radius + 3 * scale, ass_color(0.10, 0, 0, 0), 2 * scale)
    draw_round_rect(a, x0, y0, x1, y1, radius, ass_color(0.12, 1, 1, 1))
    draw_round_rect(a, x0 + scale, y0 + scale, x1 - scale, y1 - scale, radius - scale,
        ass_color(0.28, 0.035, 0.035, 0.035))
    draw_round_rect(a, x0 + radius, y0 + scale, x1 - radius, y0 + 2 * scale,
        0, ass_color(0.18, 1, 1, 1))
end

local function draw_ring(a, cx, cy, radius, thickness, color)
    a:new_event(); a:pos(0, 0)
    a:append('{\\an7\\p4\\c' .. color .. '\\bord0}')
    for _, r in ipairs({radius, radius - thickness}) do
        for i = 0, 40 do
            local angle = (r == radius and i or 40 - i) * math.pi / 20
            local x, y = cx + math.cos(angle) * r, cy + math.sin(angle) * r
            if i == 0 then a:move_to(x, y) else a:line_to(x, y) end
        end
    end
    a:append('{\\p0}')
end

local function draw_line(a, x0, y0, x1, y1, thickness, color)
    local length = math.sqrt((x1 - x0)^2 + (y1 - y0)^2)
    if length == 0 then return end
    local dx, dy = -(y1 - y0) / length * thickness / 2, (x1 - x0) / length * thickness / 2
    a:new_event(); a:pos(0, 0)
    a:append('{\\an7\\p4\\c' .. color .. '\\bord0}')
    a:move_to(x0 + dx, y0 + dy); a:line_to(x1 + dx, y1 + dy)
    a:line_to(x1 - dx, y1 - dy); a:line_to(x0 - dx, y0 - dy)
    a:line_to(x0 + dx, y0 + dy); a:append('{\\p0}')
end

local function draw_context_icon(a, id, cx, cy, scale, color)
    draw_ring(a, cx, cy, 10 * scale, 1.3 * scale, color)
    if id == 'audio' then
        for i = -1, 1 do
            local height = (i == 0 and 6 or 3) * scale
            draw_round_rect(a, cx + i * 3 * scale - 0.7 * scale, cy - height,
                cx + i * 3 * scale + 0.7 * scale, cy + height, 0.7 * scale, color)
        end
    elseif id == 'sub' then
        for i = -1, 1 do
            draw_round_rect(a, cx - (i == 1 and 3 or 5) * scale, cy + i * 3 * scale - 0.6 * scale,
                cx + 5 * scale, cy + i * 3 * scale + 0.6 * scale, 0.6 * scale, color)
        end
    elseif id == 'speed' then
        draw_line(a, cx, cy + 2 * scale, cx + 4 * scale, cy - 4 * scale, 1.6 * scale, color)
        draw_round_rect(a, cx - scale, cy + scale, cx + scale, cy + 3 * scale, scale, color)
    elseif id == 'vol' then draw_vol_icon(a, cx, cy, 8 * scale, color, state.mute)
    elseif id == 'more' then draw_menu_icon(a, cx, cy, 11 * scale, color)
    end
end

local function draw_camera_icon(a, cx, cy, s, color)
    local thickness = s * 0.085
    local points = {{-0.6,-0.3},{-0.25,-0.3},{-0.15,-0.5},{0.2,-0.5},{0.3,-0.3},
        {0.6,-0.3},{0.6,0.4},{-0.6,0.4},{-0.6,-0.3}}
    for i = 1, #points - 1 do
        draw_line(a, cx + points[i][1] * s, cy + points[i][2] * s,
            cx + points[i+1][1] * s, cy + points[i+1][2] * s, thickness, color)
    end
    draw_ring(a, cx, cy + 0.06 * s, s * 0.22, thickness, color)
end

-- ---------- overlays ----------
local bar_ov = mp.create_osd_overlay('ass-events')
bar_ov.z = 900
local menu_ov = mp.create_osd_overlay('ass-events')
menu_ov.z = 950
local top_ov = mp.create_osd_overlay('ass-events')
top_ov.z = 900
local info_ov = mp.create_osd_overlay('ass-events')
info_ov.z = 1000

local ov_w, ov_h = 0, 0
local res_logged = false
local function update_ov_size()
    -- osd-dimensions reports the TRUE rendering pixel size (handles HiDPI and
    -- embedded windows correctly); get_osd_size is logical-only
    local w, h
    local dim = mp.get_property_native('osd-dimensions')
    if dim and dim.w and dim.w > 0 then
        w, h = dim.w, dim.h
    else
        w, h = mp.get_osd_size()
    end
    if not w or not h or w <= 0 or h <= 0 then return end
    if not res_logged then
        res_logged = true
        local gw, gh = mp.get_osd_size()
        mp.msg.info('mjc-osc v5 res=' .. tostring(w) .. 'x' .. tostring(h) ..
            ' get_osd_size=' .. tostring(gw) .. 'x' .. tostring(gh))
    end
    if w ~= ov_w or h ~= ov_h then
        ov_w, ov_h = w, h
        bar_ov.res_x, bar_ov.res_y = w, h
        menu_ov.res_x, menu_ov.res_y = w, h
        top_ov.res_x, top_ov.res_y = w, h
        info_ov.res_x, info_ov.res_y = w, h
    end
    state.osd_w, state.osd_h = w, h
end

-- mouse-pos is in the same coordinate space as osd-dimensions
local function mouse_pos()
    if state.native_pointer then return state.native_pointer.x, state.native_pointer.y end
    local pos = mp.get_property_native('mouse-pos')
    if not pos then return -1, -1 end
    return pos.x, pos.y
end

-- ---------- actions ----------
local function cmd(...) mp.commandv(...) end

-- Publish the same visible hit regions used for clicks. Win32 can then select
-- its cursor immediately, without waiting for an IPC round trip on each move.
local last_cursor_zones = ''
local function publish_cursor_zones()
    publish_glass()
    if rendering_all then return end
    local zones = {}
    local function append(source)
        for _, z in ipairs(source) do
            if z.name ~= 'info-panel' then
                zones[#zones + 1] = { x0 = z.x0, y0 = z.y0, x1 = z.x1, y1 = z.y1,
                    cursor = z.name == 'sub-search' and 'text' or 'pointer' }
            end
        end
    end
    if state.info_visible then append(state.info_zones)
    else append(state.menu_zones); append(state.top_zones); append(state.zones) end
    local json = #zones == 0 and '[]' or utils.format_json(zones)
    if json ~= last_cursor_zones then
        last_cursor_zones = json
        cmd('script-message', 'mjc-cursor-zones', json)
    end
end

local function toggle_pause() cmd('cycle', 'pause') end
local function toggle_menu(name)
    if state.menu == name then state.menu = nil else state.menu = name end
end
local function do_fullscreen() cmd('script-message', 'mjc-fullscreen') end
local function set_speed(v)
    cmd('set', 'speed', string.format('%.2f', v))
end
local function track_selection(kind, v)
    state.remembered_applied[kind] = true
    local list = kind == 'audio' and state.audios or state.subs
    local track = { id = v }
    for _, t in ipairs(list) do
        if tostring(t.id) == tostring(v) then
            track = { id = t.id, lang = t.lang, title = t.title, codec = t.codec, external = t.external }
            break
        end
    end
    cmd('script-message', 'mjc-track-selected', kind, utils.format_json(track))
end
local function set_sid(v)
    cmd('set', 'sid', tostring(v)); track_selection('sub', v)
end
local function set_aid(v)
    cmd('set', 'aid', tostring(v)); track_selection('audio', v)
end
local function do_screenshot()
    cmd('script-message', 'mjc-screenshot')
end
local function toggle_hwdec()
    local cur = mp.get_property('hwdec') or 'auto-safe'
    if cur == 'no' then
        cmd('set', 'hwdec', 'auto-safe')
        mp.osd_message('硬解码', 1)
    else
        cmd('set', 'hwdec', 'no')
        mp.osd_message('软解码', 1)
    end
    state.hwdec = mp.get_property('hwdec') or 'auto-safe'
end
local function toggle_panscan()
    state.fill_window = not state.fill_window
    cmd('set', 'keepaspect', 'yes')
    cmd('set', 'video-unscaled', 'no')
    cmd('set', 'video-zoom', '0')
    cmd('set', 'video-pan-x', '0'); cmd('set', 'video-pan-y', '0')
    cmd('set', 'panscan', state.fill_window and '1' or '0')
    mp.osd_message(state.fill_window and '缩放: 裁切填充' or '缩放: 适应窗口', 1)
end
local function show_media_info()
    state.info_visible = not state.info_visible
    state.info_offset = 0
    state.menu = nil
    state.sub_searching = false
    mp.osd_message('', 0)
    render_all()
end

-- ---------- media information ----------
local function fit_text(value, fs, width)
    local str = tostring(value or '—'):gsub('[\r\n]', ' ')
    if text_width(str, fs) <= width then return str end
    local i, last = 1, 0
    while i <= #str do
        local b = str:byte(i)
        local next_i = i + (b < 128 and 1 or b < 224 and 2 or b < 240 and 3 or 4)
        if text_width(str:sub(1, next_i - 1) .. '…', fs) > width then break end
        last, i = next_i - 1, next_i
    end
    return str:sub(1, last) .. '…'
end

local function render_info()
    update_ov_size()
    begin_glass('info')
    state.info_zones = {}
    if not state.info_visible then
        info_ov.data = ''; info_ov:update(); publish_cursor_zones(); return
    end
    local w, h = state.osd_w, state.osd_h
    local scale = state.ui_scale
    local pw, ph = math.min(840 * scale, w - 24 * scale), math.min(530 * scale, h - 24 * scale)
    local x, y = (w - pw) / 2, (h - ph) / 2
    local a = new_ass()
    local fg = ass_color(0.98, 1, 1, 1)
    local dim = ass_color(0.65, 1, 1, 1)
    draw_round_rect(a, 0, 0, w, h, 0, ass_color(0.25, 0, 0, 0))
    draw_surface(a, x, y, x + pw, y + ph, 18 * scale, scale)
    draw_text(a, x + 28 * scale, y + 22 * scale, 21 * scale, fg, '媒体信息')
    draw_text(a, x + pw - 28 * scale, y + 24 * scale, 15 * scale, dim, '关闭 ×', 9)
    zone(state.info_zones, x + pw - 115 * scale, y + 10 * scale, x + pw - 12 * scale, y + 60 * scale,
        function() state.info_visible = false; render_all() end, 'close-info')
    zone(state.info_zones, x, y, x + pw, y + ph, function() end, 'info-panel')
    local info = state.media_info
    local name = info.filename or info.title or '当前媒体'
    -- Never display a playback URL or authentication query in the overlay.
    if tostring(name):find('://', 1, true) or tostring(name):find('api_key=', 1, true) then name = info.title or '当前媒体' end
    draw_text(a, x + 28 * scale, y + 65 * scale, 15 * scale, fg, fit_text(name, 15 * scale, pw - 56 * scale))
    local details = {}
    if info.server then details[#details + 1] = info.server end
    if info.container then details[#details + 1] = tostring(info.container):upper() end
    if tonumber(info.size) then details[#details + 1] = string.format('%.2f GB', info.size / 1073741824) end
    details[#details + 1] = fmt_time(state.duration)
    if tonumber(info.bitrate) then details[#details + 1] = string.format('%.2f Mbps', info.bitrate / 1000000) end
    draw_text(a, x + 28 * scale, y + 95 * scale, 13 * scale, dim, fit_text(table.concat(details, ' · '), 13 * scale, pw - 56 * scale))
    local video = mp.get_property_native('video-params') or {}
    local audio = mp.get_property_native('audio-params') or {}
    local function prop(name) return mp.get_property(name) end
    local function rate(name)
        local n = mp.get_property_number(name)
        return n and string.format('%.0f kbps', n / 1000) or nil
    end
    local fps = mp.get_property_number('container-fps')
    local vr = {
        {'编码', prop('video-codec')},
        {'分辨率', video.w and (video.w .. ' × ' .. video.h)},
        {'帧率', fps and string.format('%.3f fps', fps)},
        {'比特率', rate('video-bitrate')},
        {'解码器', prop('hwdec-current')},
        {'像素格式', video.pixelformat},
        {'色彩空间', video.colormatrix},
        {'传递函数', video.gamma},
    }
    local ar = {
        {'编码', prop('audio-codec')},
        {'声道布局', audio.channels},
        {'声道数', audio['channel-count']},
        {'采样率', audio.samplerate and (audio.samplerate .. ' Hz')},
        {'比特率', rate('audio-bitrate')},
        {'采样格式', audio.format},
        {'音轨数量', #state.audios},
        {'字幕数量', #state.subs},
    }
    local lists = {vr, ar}
    local titles = {'视频', '音频 / 字幕'}
    if pw < 650 * scale then
        local merged = {{'视频', nil, true}}
        for _, row in ipairs(vr) do merged[#merged + 1] = row end
        merged[#merged + 1] = {'音频 / 字幕', nil, true}
        for _, row in ipairs(ar) do merged[#merged + 1] = row end
        lists, titles = {merged}, {nil}
    end
    local top = y + 128 * scale
    local bottom = y + ph - 45 * scale
    local row_height = 31 * scale
    local header_height = #lists == 2 and 40 * scale or 8 * scale
    local visible = math.max(1, math.floor((bottom - top - header_height - 8 * scale) / row_height))
    local longest = 0
    for _, rows in ipairs(lists) do longest = math.max(longest, #rows) end
    state.info_offset = clamp(state.info_offset, 0, math.max(0, longest - visible))
    local column_width = (pw - (2 * 20 + (#lists - 1) * 16) * scale) / #lists
    for col, rows in ipairs(lists) do
        local cx = x + 20 * scale + (col - 1) * (column_width + 16 * scale)
        draw_round_rect(a, cx, top, cx + column_width, bottom, 12 * scale, ass_color(0.05, 1, 1, 1))
        if titles[col] then draw_text(a, cx + 12 * scale, top + 10 * scale, 16 * scale, fg, titles[col]) end
        for i = 1, visible do
            local row = rows[state.info_offset + i]
            if row then
                local ry = top + header_height + (i - 1) * row_height
                draw_text(a, cx + 12 * scale, ry, (row[3] and 15 or 13) * scale, row[3] and fg or dim, row[1])
                if not row[3] then draw_text(a, cx + 102 * scale, ry, 13 * scale, fg, fit_text(row[2], 13 * scale, column_width - 114 * scale)) end
            end
        end
    end
    draw_text(a, w / 2, y + ph - 31 * scale, 13 * scale, dim, fit_text('滚轮查看更多 · Esc 关闭', 13 * scale, pw - 24 * scale), 8)
    info_ov.data = a.text; info_ov:update()
    publish_cursor_zones()
end

-- ---------- seekbar ----------
local function seek_to_frac(f)
    f = clamp(f, 0, 1)
    if state.duration > 0 then
        cmd('seek', string.format('%.3f', f * state.duration), state.precise_seek and 'absolute+exact' or 'absolute+keyframes')
    end
end

local function seek_frac_at(x)
    local s = state.seek
    if not s then return 0 end
    return clamp((x - s.x0) / (s.x1 - s.x0), 0, 1)
end

local function volume_maximum()
    local actual = mp.get_property_number('options/volume-max')
    if actual and actual > 0 then return math.min(actual, 200) end
    return state.settings.audioBoost and 200 or 100
end

local function volume_at(x)
    local slider = state.volume_slider
    if not slider then return end
    local maximum = volume_maximum()
    local volume = math.floor(clamp((x - slider.x0) / (slider.x1 - slider.x0), 0, 1) * maximum + 0.5)
    if volume > 0 and state.mute then
        state.mute = false
        cmd('set', 'mute', 'no')
    end
    if volume ~= state.volume then
        state.volume = volume
        cmd('set', 'volume', tostring(volume))
    end
end

-- ---------- render bar ----------
function render_bar()
    update_ov_size()
    begin_glass('bar')
    local w, h, scale = state.osd_w, state.osd_h, state.ui_scale
    local a = new_ass()
    state.zones, state.menu_anchors, state.seek, state.bar_bounds = {}, {}, nil, nil
    state.volume_slider = nil
    local has_video = state.duration > 0
    local show_full = state.visible or state.persistent
    local mx, my = mouse_pos()
    local fg, dim = ass_color(0.98, 1, 1, 1), ass_color(0.72, 1, 1, 1)
    if not show_full and has_video then
        draw_round_rect(a, 0, h - scale, w, h, 0, ass_color(0.16, 1, 1, 1))
        draw_round_rect(a, 0, h - scale, w * clamp(state.timepos / state.duration, 0, 1), h, 0, ass_color(0.7, 1, 1, 1))
    end
    if state.paused and has_video then
        local px, py = w - 102 * scale, 16 * scale
        draw_surface(a, px, py, w - 16 * scale, py + 32 * scale, 10 * scale, scale)
        draw_pause_icon(a, px + 20 * scale, py + 16 * scale, 11 * scale, fg)
        draw_text(a, px + 36 * scale, py + 6 * scale, 12 * scale, fg, '已暂停')
    end
    if show_full and has_video then
        local transport_count = 1 + (state.settings.showSwitchMediaButton and 2 or 0)
            + (state.settings.showSkipButtons and 2 or 0)
        -- Fold or reflow before the new slider crowds transport or seeking.
        local tiny = w < 440 * scale or w < (transport_count * 34 + 6 * 34 + 76 + 24) * scale
        local volume_width = (tiny and 48 or 64) * scale
        local control_width = ((tiny and 1 or transport_count) * 34 + (tiny and 3 or 6) * 34 + 36) * scale + volume_width
        local times_width = text_width(fmt_time(state.timepos), 14 * scale) + text_width(fmt_time(state.duration), 14 * scale)
        local compact = w < 640 * scale or w < control_width + times_width + 136 * scale
        state.narrow_controls, state.tiny_controls = tiny, tiny
        local bh = (compact and 88 or 52) * scale
        local by, pad, bw = h - bh, 12 * scale, 34 * scale
        local row_y = by + (compact and 36 or 0) * scale
        local row_h, cy = 52 * scale, row_y + 26 * scale
        state.bar_top = by
        state.bar_bounds = {x0 = 0, y0 = by, x1 = w, y1 = h}
        -- Separate opacities make the surface and the timeline read as distinct layers.
        glass_surface(0, by, w, h, 10 * scale)
        draw_round_rect(a, 0, by, w, h, 10 * scale, ass_color(0.08, 1, 1, 1))
        draw_round_rect(a, scale, by + scale, w - scale, h, 9 * scale, ass_color(0.20, 0, 0, 0))
        draw_round_rect(a, 10 * scale, by, w - 10 * scale, by + scale, 0, ass_color(0.10, 1, 1, 1))
        local tooltip, tooltip_x
        local function feedback(x, y, width, height, label, selected)
            local hovered = not state.menu and not state.info_visible and mx >= x and mx <= x + width and my >= y and my <= y + height
            if hovered or selected then
                draw_round_rect(a, x + 2 * scale, y + (height - 32 * scale) / 2,
                    x + width - 2 * scale, y + (height + 32 * scale) / 2, 8 * scale,
                    ass_color(hovered and 0.14 or 0.08, 1, 1, 1))
            end
            if hovered then tooltip, tooltip_x = label, x + width / 2 end
        end
        local x = pad
        local function transport(id, label, action, draw)
            feedback(x, row_y, bw, row_h, label)
            draw(x + bw / 2, cy, fg)
            zone(state.zones, x, row_y, x + bw, row_y + row_h, action, id)
            x = x + bw
        end
        if state.settings.showSwitchMediaButton and not tiny then
            transport('prev', '上一项媒体', function() cmd('script-message', 'mjc-switch-media', 'prev') end,
                function(cx, y, col) draw_switch_icon(a, cx, y, 16 * scale, col, -1) end)
        end
        if state.settings.showSkipButtons and not tiny then
            transport('rewind', '快退 ' .. state.rewind_seconds .. ' 秒', function()
                cmd('seek', -state.rewind_seconds, state.precise_seek and 'relative+exact' or 'relative+keyframes') end,
                function(cx, y, col) draw_seek_icon(a, cx, y, 13 * scale, col, -1) end)
        end
        transport('playpause', state.paused and '播放 · 空格' or '暂停 · 空格', toggle_pause,
            function(cx, y, col)
                if state.paused then draw_play_icon(a, cx, y, 20 * scale, col)
                else draw_pause_icon(a, cx, y, 17 * scale, col) end
            end)
        if state.settings.showSkipButtons and not tiny then
            transport('forward', '快进 ' .. state.forward_seconds .. ' 秒', function()
                cmd('seek', state.forward_seconds, state.precise_seek and 'relative+exact' or 'relative+keyframes') end,
                function(cx, y, col) draw_seek_icon(a, cx, y, 13 * scale, col, 1) end)
        end
        if state.settings.showSwitchMediaButton and not tiny then
            transport('next', '下一项媒体', function() cmd('script-message', 'mjc-switch-media', 'next') end,
                function(cx, y, col) draw_switch_icon(a, cx, y, 16 * scale, col, 1) end)
        end
        local rx, slots = w - pad, {}
        local function rbtn(id, label)
            rx = rx - bw
            slots[#slots + 1] = {id = id, x = rx, label = label}
        end
        rbtn('more', '更多')
        rbtn('fs', '全屏 · 回车')
        if not tiny then
            rbtn('speed', '倍速 ' .. tostring(state.speed) .. 'x')
            rbtn('sub', '字幕 · S')
            rbtn('audio', '音轨 · A')
        end
        local vx1 = rx - 8 * scale
        local vx0 = vx1 - volume_width
        rx = vx0 - 4 * scale
        rbtn('vol', state.mute and '取消静音 · M' or '音量 ' .. math.floor(state.volume) .. '% · M 静音')
        for _, slot in ipairs(slots) do
            local id, cx = slot.id, slot.x + bw / 2
            local color = fg
            feedback(slot.x, row_y, bw, row_h, slot.label, state.menu == id or (id == 'vol' and state.mute))
            state.menu_anchors[id] = cx
            if id == 'fs' then draw_fs_icon(a, cx, cy, 8 * scale, color)
            else draw_context_icon(a, id, cx, cy, scale, color) end
            zone(state.zones, slot.x, row_y, slot.x + bw, row_y + row_h, function()
                if id == 'fs' then do_fullscreen()
                elseif id == 'vol' then cmd('cycle', 'mute')
                else toggle_menu(id); state.sub_searching = false; state.menu_offset = 0 end
                render_all()
            end, id)
        end
        state.volume_slider = {x0 = vx0, x1 = vx1}
        local hover_volume = not state.menu and not state.info_visible
            and mx >= vx0 - 4 * scale and mx <= vx1 + 4 * scale and my >= row_y and my <= row_y + row_h
        local vh = (hover_volume or state.volume_drag) and 4 * scale or 3 * scale
        local maximum = volume_maximum()
        local value = state.mute and 0 or clamp(state.volume / maximum, 0, 1)
        local knob = vx0 + (vx1 - vx0) * value
        draw_round_rect(a, vx0, cy - vh / 2, vx1, cy + vh / 2, vh / 2, ass_color(0.30, 1, 1, 1))
        if knob > vx0 then draw_round_rect(a, vx0, cy - vh / 2, knob, cy + vh / 2, vh / 2, ass_color(0.82, 1, 1, 1)) end
        draw_round_rect(a, knob - 4 * scale, cy - 4 * scale, knob + 4 * scale, cy + 4 * scale, 4 * scale, fg)
        zone(state.zones, vx0 - 4 * scale, row_y, vx1 + 4 * scale, row_y + row_h, function() end, 'volume-slider')
        if hover_volume or state.volume_drag then
            tooltip, tooltip_x = '音量 ' .. math.floor(state.volume) .. '%' .. (state.mute and ' · 已静音' or ''), (vx0 + vx1) / 2
        end
        local fs = 14 * scale
        local ty = compact and by + 19 * scale or cy
        local cur_t, tot_t = fmt_time(state.timepos), fmt_time(state.duration)
        local tx = compact and pad or x + 10 * scale
        local sx0 = tx + text_width(cur_t, fs) + 18 * scale
        local sx1 = (compact and w - pad or rx - 10 * scale) - text_width(tot_t, fs) - 18 * scale
        local sy0, sy1 = compact and by + 4 * scale or row_y, compact and by + 34 * scale or row_y + row_h
        local hovered_seek = not state.menu and not state.info_visible
            and mx >= sx0 - 4 * scale and mx <= sx1 + 4 * scale and my >= sy0 and my <= sy1
        local sh = (hovered_seek or state.seek_drag) and 4 * scale or 3 * scale
        state.seek = {x0 = sx0, y0 = ty - sh / 2, x1 = sx1, y1 = ty + sh / 2}
        zone(state.zones, sx0 - 4 * scale, sy0, sx1 + 4 * scale, sy1, function() end, 'seek')
        draw_text(a, tx, ty - 11 * scale, fs, fg, cur_t)
        draw_text(a, sx1 + 18 * scale, ty - 11 * scale, fs, fg, tot_t)
        draw_round_rect(a, sx0, ty - sh / 2, sx1, ty + sh / 2, sh / 2, ass_color(0.30, 1, 1, 1))
        local kx = sx0 + (sx1 - sx0) * clamp(state.timepos / state.duration, 0, 1)
        if kx > sx0 then draw_round_rect(a, sx0, ty - sh / 2, kx, ty + sh / 2, sh / 2, ass_color(0.82, 1, 1, 1)) end
        draw_round_rect(a, kx - 4 * scale, ty - 4 * scale, kx + 4 * scale, ty + 4 * scale, 4 * scale, fg)
        if hovered_seek or state.seek_drag then
            tooltip, tooltip_x = fmt_time(seek_frac_at(mx) * state.duration), clamp(mx, 50 * scale, w - 50 * scale)
        end
        if tooltip then
            local tw = text_width(tooltip, 12 * scale) + 24 * scale
            local hx = clamp(tooltip_x - tw / 2, 8 * scale, w - 8 * scale - tw)
            draw_surface(a, hx, by - 40 * scale, hx + tw, by - 8 * scale, 8 * scale, scale)
            draw_text(a, hx + tw / 2, by - 34 * scale, 12 * scale, fg, tooltip, 8)
        end
        -- Secondary tools float beside the picture, as in the visual reference.
        if not compact and h >= 320 * scale then
            local rail_x, rail_y = w - 48 * scale, h / 2 - 38 * scale
            local tool_h = state.settings.showScreenshotButton and 76 * scale or 38 * scale
            draw_surface(a, rail_x, rail_y, rail_x + 36 * scale, rail_y + tool_h, 10 * scale, scale)
            local tools = state.settings.showScreenshotButton and {'screenshot', 'info'} or {'info'}
            for i, id in ipairs(tools) do
                local y = rail_y + (i - 1) * 38 * scale
                local hovered = not state.menu and not state.info_visible
                    and mx >= rail_x and mx <= rail_x + 36 * scale and my >= y and my <= y + 38 * scale
                if hovered then
                    draw_round_rect(a, rail_x + 2 * scale, y + 2 * scale, rail_x + 34 * scale, y + 36 * scale,
                        8 * scale, ass_color(0.12, 1, 1, 1))
                    local label = id == 'screenshot' and '截图' or '媒体信息'
                    local tw = text_width(label, 12 * scale) + 20 * scale
                    draw_surface(a, rail_x - tw - 8 * scale, y + 3 * scale, rail_x - 8 * scale, y + 35 * scale, 8 * scale, scale)
                    draw_text(a, rail_x - tw / 2 - 8 * scale, y + 9 * scale, 12 * scale, fg, label, 8)
                end
                local col = fg
                if id == 'screenshot' then draw_camera_icon(a, rail_x + 18 * scale, y + 19 * scale, 16 * scale, col)
                else
                    for j = -1, 1 do
                        draw_round_rect(a, rail_x + 11 * scale, y + 19 * scale + j * 5 * scale,
                            rail_x + 25 * scale, y + 20.4 * scale + j * 5 * scale, 0.7 * scale, col)
                    end
                end
                zone(state.zones, rail_x, y, rail_x + 36 * scale, y + 38 * scale,
                    id == 'screenshot' and do_screenshot or show_media_info, id)
            end
        end
    end
    bar_ov.data = a.text; bar_ov:update(); publish_cursor_zones()
end

-- ---------- top bar ----------
function render_top()
    update_ov_size()
    begin_glass('top')
    local w = state.osd_w
    local scale = state.ui_scale
    local a = new_ass()
    state.top_zones = {}
    -- Window controls own playback exit; the OSD only contains playback controls.
    if state.visible or state.duration <= 0 then
        local m, th = 20 * scale, 54 * scale
        for i = 0, 7 do
            draw_round_rect(a, 0, i * 10 * scale, w, (i + 1) * 10 * scale, 0,
                ass_color(0.28 - i * 0.035, 0, 0, 0))
        end
        local sp = fmt_kbs(state.cache_kbs)
        local reserved = state.paused and 110 * scale or 0
        if sp ~= '' and not state.paused and w > 560 * scale then
            reserved = text_width(sp, 12 * scale) + 26 * scale
            draw_round_rect(a, w - m - reserved, m, w - m, m + 30 * scale, 15 * scale,
                ass_color(0.66, 0.08, 0.08, 0.10))
            draw_text(a, w - m - 13 * scale, m + 5 * scale, 12 * scale,
                ass_color(0.62, 1, 1, 1), sp, 9)
        end
        local tfs = 14 * scale
        local title_width = w - 2 * m - 2 * reserved - 16 * scale
        if title_width > 0 then draw_text(a, w / 2, m + 1 * scale, tfs,
            ass_color(0.96, 1, 1, 1), fit_text(state.title, tfs, title_width), 8) end
    end

    top_ov.data = a.text
    top_ov:update()
    publish_cursor_zones()
end

-- ---------- menus ----------
local SPEED_OPTIONS = { 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 8.0 }

local function remember_sub_search()
    local query = state.sub_query:match('^%s*(.-)%s*$')
    if not state.settings.subtitleSearchHistory or query == '' then return end
    local history = { query }
    for _, value in ipairs(state.sub_history) do
        if value ~= query and #history < 8 then history[#history + 1] = value end
    end
    state.sub_history = history
    cmd('script-message', 'mjc-subtitle-search-history', utils.format_json(history))
end

local function subtitle_matches(track)
    if state.sub_query == '' then return true end
    local text = table.concat({track.title or '', track.lang or '', track.codec or ''}, ' '):lower()
    return text:find(state.sub_query:lower(), 1, true) ~= nil
end

function render_menu()
    update_ov_size()
    begin_glass('menu')
    local a = new_ass()
    state.menu_zones = {}
    local w, h = state.osd_w, state.osd_h
    local scale = state.ui_scale
    local m = 12 * scale
    local bh = 52 * scale
    local bar_top = state.bar_top > 0 and state.bar_top or h - m - bh

    if state.menu and state.duration > 0 then
        local row_h = 34 * scale
        local fs = 14 * scale
        local items = {}

        if state.menu == 'speed' then
            items[#items + 1] = { label = '倍速', header = true }
            for _, v in ipairs(SPEED_OPTIONS) do
                local cur = math.abs(state.speed - v) < 0.005
                items[#items + 1] = {
                    label = (cur and '✓ ' or '   ') .. string.format('%.2f', v) .. 'X',
                    action = function() set_speed(v) state.menu = nil end,
                    current = cur,
                }
            end
        elseif state.menu == 'sub' then
            items[#items + 1] = { label = '字幕', header = true }
            items[#items + 1] = {
                label = state.sub_searching and ('搜索: ' .. state.sub_query .. '▏')
                    or (state.sub_query ~= '' and ('搜索: ' .. state.sub_query) or '搜索当前字幕列表…'),
                action = function() state.sub_searching = true; state.menu_offset = 0 end,
                name = 'sub-search',
            }
            if state.sub_query ~= '' then
                items[#items + 1] = {
                    label = '清除搜索',
                    action = function() state.sub_query = ''; state.sub_searching = false; state.menu_offset = 0 end,
                }
            elseif state.settings.subtitleSearchHistory then
                for _, value in ipairs(state.sub_history) do
                    local query = value
                    items[#items + 1] = {
                        label = '最近: ' .. query,
                        action = function() state.sub_query = query; state.sub_searching = false; state.menu_offset = 0 end,
                    }
                end
            end
            local no_sub = state.sid == nil or state.sid == 'no' or state.sid == 'auto'
            items[#items + 1] = {
                label = (no_sub and '✓ ' or '   ') .. '禁用',
                action = function() set_sid('no') state.menu = nil end,
                current = no_sub,
            }
            local matches = 0
            for _, t in ipairs(state.subs) do
              if subtitle_matches(t) then
                matches = matches + 1
                local cur = state.sid ~= nil and tostring(t.id) == tostring(state.sid)
                items[#items + 1] = {
                    label = (cur and '✓ ' or '   ') .. (t.title or t.lang or ('轨道 ' .. t.id)),
                    action = function() remember_sub_search(); set_sid(t.id) state.menu = nil; state.sub_searching = false end,
                    current = cur,
                }
              end
            end
            if matches == 0 then items[#items + 1] = { label = '没有匹配的字幕', header = true } end
        elseif state.menu == 'audio' then
            items[#items + 1] = { label = '音频', header = true }
            for _, t in ipairs(state.audios) do
                local cur = state.aid ~= nil and tostring(t.id) == tostring(state.aid)
                items[#items + 1] = {
                    label = (cur and '✓ ' or '   ') .. (t.title or t.lang or ('轨道 ' .. t.id)),
                    action = function() set_aid(t.id) state.menu = nil end,
                    current = cur,
                }
            end
        elseif state.menu == 'more' then
            items[#items + 1] = { label = '更多', header = true }
            if state.narrow_controls then
                for _, menu in ipairs({{'倍速', 'speed'}, {'字幕', 'sub'}, {'音轨', 'audio'}}) do
                    local target = menu[2]
                    items[#items + 1] = { label = menu[1], action = function() state.menu = target; state.menu_offset = 0 end }
                end
            end
            if state.tiny_controls and state.settings.showSwitchMediaButton then
                items[#items + 1] = { label = '上一项媒体', action = function() cmd('script-message', 'mjc-switch-media', 'prev'); state.menu = nil end }
                items[#items + 1] = { label = '下一项媒体', action = function() cmd('script-message', 'mjc-switch-media', 'next'); state.menu = nil end }
            end
            if state.tiny_controls and state.settings.showSkipButtons then
                items[#items + 1] = { label = '快退 ' .. state.rewind_seconds .. ' 秒', action = function() cmd('seek', -state.rewind_seconds, state.precise_seek and 'relative+exact' or 'relative+keyframes'); state.menu = nil end }
                items[#items + 1] = { label = '快进 ' .. state.forward_seconds .. ' 秒', action = function() cmd('seek', state.forward_seconds, state.precise_seek and 'relative+exact' or 'relative+keyframes'); state.menu = nil end }
            end
            items[#items + 1] = {
                label = (state.hwdec ~= 'no' and '✓ ' or '   ') .. '硬件解码',
                action = function() toggle_hwdec() state.menu = nil end,
                current = state.hwdec ~= 'no',
            }
            items[#items + 1] = {
                label = '   缩放模式',
                action = function() toggle_panscan() state.menu = nil end,
            }
            items[#items + 1] = {
                label = (state.persistent and '✓ ' or '   ') .. '进度条常显',
                action = function()
                    state.persistent = not state.persistent
                    state.menu = nil
                    render_all()
                end,
                current = state.persistent,
            }
            if state.settings.showScreenshotButton then
                items[#items + 1] = {
                    label = '   截图',
                    action = function() do_screenshot() state.menu = nil end,
                }
            end
            items[#items + 1] = {
                label = '   媒体信息',
                action = function() show_media_info() state.menu = nil end,
            }
        end

        if #items > 0 then
            -- Keep long track lists on-screen and allow mouse-wheel pagination.
            local total_items = #items
            local max_rows = math.max(1, math.floor((bar_top - 34 * scale) / row_h))
            state.menu_offset = clamp(state.menu_offset, 0, math.max(0, #items - max_rows))
            if #items > max_rows then
                local visible_items = {}
                for i = state.menu_offset + 1, math.min(#items, state.menu_offset + max_rows) do
                    visible_items[#visible_items + 1] = items[i]
                end
                items = visible_items
            end
            local pw = 0
            for _, it in ipairs(items) do
                pw = math.max(pw, text_width(it.label, fs))
            end
            pw = math.min(clamp(pw + 28 * scale, 150 * scale, 340 * scale), w - 2 * m)
            local ph = row_h * #items + 12 * scale
            local anchor = state.menu_anchors[state.menu] or state.menu_anchors.more or (w - m - pw / 2)
            local px = clamp(anchor - pw / 2, m, w - m - pw)
            local py = bar_top - 10 * scale - ph
            draw_surface(a, px, py, px + pw, py + ph, 14 * scale, scale)
            if total_items > #items then
                local track_h = ph - 16 * scale
                local thumb_h = math.max(12 * scale, track_h * #items / total_items)
                local thumb_y = py + 8 * scale + (track_h - thumb_h) * state.menu_offset / (total_items - #items)
                draw_round_rect(a, px + pw - 5 * scale, py + 8 * scale, px + pw - 3 * scale,
                    py + ph - 8 * scale, scale, ass_color(0.08, 1, 1, 1))
                draw_round_rect(a, px + pw - 5 * scale, thumb_y, px + pw - 3 * scale,
                    thumb_y + thumb_h, scale, ass_color(0.38, 1, 1, 1))
            end

            local iy = py + 6 * scale
            local mx, my = mouse_pos()
            for _, it in ipairs(items) do
                if it.header then
                    draw_text(a, px + 14 * scale, iy + row_h * 0.22, fs * 0.9,
                        ass_color(0.6, 1, 1, 1), it.label)
                else
                    if it.current or (mx >= px and mx <= px + pw and my >= iy and my <= iy + row_h) then
                        draw_round_rect(a, px + 6 * scale, iy + 2 * scale, px + pw - 6 * scale, iy + row_h - 2 * scale,
                            8 * scale, it.current and ass_color(0.12, 1, 1, 1) or ass_color(0.07, 1, 1, 1))
                    end
                    local col = it.current and ass_color(1, 1, 1, 1)
                        or ass_color(0.92, 1, 1, 1)
                    draw_text(a, px + 14 * scale, iy + row_h * 0.2, fs, col, fit_text(it.label, fs, pw - 28 * scale))
                    local act = it.action
                    zone(state.menu_zones, px, iy, px + pw, iy + row_h, function()
                        act()
                        render_all()
                    end, it.name)
                end
                iy = iy + row_h
            end
        end
    end

    menu_ov.data = a.text
    menu_ov:update()
    publish_cursor_zones()
end

function render_all()
    rendering_all = true
    render_bar()
    render_top()
    render_menu()
    render_info()
    rendering_all = false
    publish_cursor_zones()
end

-- ---------- state sync ----------
local function restore_track(kind, remembered, enabled)
    if not enabled or type(remembered) ~= 'table' or state.remembered_applied[kind] then return end
    local property = kind == 'audio' and 'aid' or 'sid'
    if kind == 'sub' and tostring(remembered.id) == 'no' then
        cmd('set', property, 'no'); state.remembered_applied[kind] = true; return
    end
    local list = kind == 'audio' and state.audios or state.subs
    -- The frontend only retains an ID when replaying the same media source.
    -- It is therefore more precise than language metadata shared by several tracks.
    if remembered.id ~= nil then
        for _, t in ipairs(list) do
            if tostring(t.id) == tostring(remembered.id) then
                cmd('set', property, tostring(t.id)); state.remembered_applied[kind] = true; return
            end
        end
    end
    local match, best = nil, 3
    for _, t in ipairs(list) do
        local score = 0
        if remembered.lang and t.lang == remembered.lang then score = score + 4 end
        if remembered.title and remembered.title ~= '' and t.title == remembered.title then score = score + 8 end
        if remembered.codec and t.codec == remembered.codec then score = score + 1 end
        if score > best then match, best = t, score end
    end
    if match then
        cmd('set', property, tostring(match.id)); state.remembered_applied[kind] = true
    end
end

local function preferred_language_score(track, preference)
    local lang = tostring(track.lang or ''):lower()
    local title = tostring(track.title or ''):lower()
    local chinese = lang:match('^zh') or lang == 'chi' or lang == 'zho' or lang == 'chs' or lang == 'cht'
        or lang == 'cmn' or lang == 'yue'
    if preference == '简中' or preference == '繁中' then
        local simplified = lang:find('hans', 1, true) or lang == 'chs' or lang == 'zh-cn' or lang == 'zh-sg'
            or title:find('简', 1, true) or title:find('簡', 1, true) or title:find('simplified', 1, true)
        local traditional = lang:find('hant', 1, true) or lang == 'cht' or lang == 'zh-tw' or lang == 'zh-hk'
            or title:find('繁', 1, true) or title:find('traditional', 1, true)
        if preference == '简中' then
            if traditional then return 0 end
            if simplified then return 100 end
        else
            if simplified then return 0 end
            if traditional then return 100 end
        end
        return chinese and 40 or 0
    elseif preference == '中文' then return chinese and 100 or 0
    elseif preference == '英文' then return (lang == 'eng' or lang:match('^en')) and 100 or 0
    elseif preference == '日文' then return (lang == 'jpn' or lang:match('^ja')) and 100 or 0 end
    return 0
end

local function restore_language(kind, preference)
    if state.remembered_applied[kind] then return end
    local list = kind == 'audio' and state.audios or state.subs
    local chosen = state.preferred_applied[kind]
    local match, best = nil, chosen and chosen.preference == preference and chosen.score or 0
    for _, t in ipairs(list) do
        local score = preferred_language_score(t, preference)
        if score > best then match, best = t, score end
    end
    if match then
        cmd('set', kind == 'audio' and 'aid' or 'sid', tostring(match.id))
        state.preferred_applied[kind] = {preference = preference, score = best}
    end
end

local function restore_tracks()
    restore_track('audio', state.settings.rememberedAudio, state.settings.rememberAudioTrack)
    restore_track('sub', state.settings.rememberedSubtitle, state.settings.rememberSubtitle)
    restore_language('audio', state.settings.preferredAudioLanguage)
    restore_language('sub', state.settings.preferredSubtitleLanguage)
end

local function sync_tracks()
    local list = mp.get_property_native('track-list') or {}
    state.subs, state.audios = {}, {}
    for _, t in ipairs(list) do
        if t.type == 'sub' then
            state.subs[#state.subs + 1] = t
        elseif t.type == 'audio' then
            state.audios[#state.audios + 1] = t
        end
    end
    state.sid = mp.get_property('sid')
    state.aid = mp.get_property('aid')
    restore_tracks()
end

mp.observe_property('time-pos', 'number', function(_, v)
    if v then state.timepos = v; render_bar() end
end)
mp.observe_property('duration', 'number', function(_, v)
    state.duration = v or 0; render_all()
end)
mp.observe_property('pause', 'bool', function(_, v)
    state.paused = v or false
    if state.paused then
        if state.held_key and state.held_key.active then set_speed(state.held_key.previous_speed) end
        state.held_key = nil; state.volume_key = nil
    end
    render_all()
end)
mp.observe_property('speed', 'number', function(_, v)
    state.speed = v or 1; render_bar()
end)
mp.observe_property('volume', 'number', function(_, v)
    state.volume = v or 100
    render_bar()
end)
mp.observe_property('options/volume-max', 'number', function() render_bar() end)
mp.observe_property('mute', 'bool', function(_, v)
    state.mute = v or false; render_all()
end)
mp.observe_property('media-title', 'string', function(_, v)
    state.title = state.media_info.title or v or ''; render_top()
end)
mp.observe_property('hwdec', 'string', function(_, v)
    state.hwdec = v or 'auto-safe'
end)
mp.observe_property('sid', 'string', function(_, v) state.sid = v end)
mp.observe_property('aid', 'string', function(_, v) state.aid = v end)
mp.observe_property('track-list', 'native', function() sync_tracks() end)
mp.observe_property('demuxer-cache-state', 'native', function(_, v)
    if v and v['cache-speed'] then
        state.cache_kbs = v['cache-speed']
    else
        state.cache_kbs = -1
    end
    if state.visible then render_top() end
end)

mp.observe_property('osd-dimensions', 'native', function() render_all() end)
mp.observe_property('video-target-params', 'native', function() render_all() end)
-- ---------- input ----------
local function activity()
    state.last_active = mp.get_time()
    if not state.visible then
        state.visible = true
        render_all()
    end
end

mp.observe_property('mouse-pos', 'native', function(_, v)
    if not v then return end
    activity()
    render_bar()
    if state.menu then render_menu() end
end)

local function finish_hold()
    local held = state.held_key
    if held and held.active then set_speed(held.previous_speed) end
    state.held_key = nil
    state.volume_key = nil
    state.volume_drag = false
    state.seek_drag = false
    state.native_pointer = nil
end

local function relative_seek(direction)
    cmd('seek', direction == 'LEFT' and -state.rewind_seconds or state.forward_seconds,
        state.precise_seek and 'relative+exact' or 'relative+keyframes')
end

local function escape()
    finish_hold(); state.pending_click = nil
    if state.sub_searching then state.sub_searching = false; render_all()
    elseif state.info_visible then state.info_visible = false; render_all()
    elseif state.menu then state.menu = nil; render_all()
    else cmd('script-message', 'mjc-quit') end
end

local function on_key(key, down)
    key = tostring(key):upper()
    if key == 'ESC' and down then escape(); return end
    if state.sub_searching then
        if not down then return end
        if key == 'ENTER' then remember_sub_search(); state.sub_searching = false
        elseif key == 'BACKSPACE' or key == 'BS' then
            local i = #state.sub_query
            while i > 1 and state.sub_query:byte(i) >= 128 and state.sub_query:byte(i) < 192 do i = i - 1 end
            state.sub_query = state.sub_query:sub(1, math.max(0, i - 1))
        end
        state.menu_offset = 0; render_menu(); return
    end
    if not down then
        if state.volume_key and state.volume_key.key == key then state.volume_key = nil end
        local held = state.held_key
        if held and held.key == key then
            finish_hold()
            if not held.active then relative_seek(key) end
        end
        return
    end
    if key == 'SPACE' then finish_hold(); state.pending_click = nil; toggle_pause(); return end
    activity()
    if key == 'LEFT' or key == 'RIGHT' then
        if state.held_key and state.held_key.key == key then return end
        finish_hold()
        state.held_key = { key = key, since = mp.get_time(), previous_speed = state.speed, active = false }
    elseif key == 'ENTER' or key == 'F' then do_fullscreen()
    elseif key == 'M' then cmd('cycle', 'mute')
    elseif key == 'UP' or key == 'DOWN' then
        if state.volume_key and state.volume_key.key == key then return end
        local volume = clamp(state.volume + (key == 'UP' and 5 or -5), 0, volume_maximum())
        cmd('set', 'volume', tostring(volume))
        state.volume_key = { key = key, since = mp.get_time(), last = mp.get_time() }
    elseif key == 'S' then
        toggle_menu('sub')
        state.sub_searching = false; state.menu_offset = 0; render_menu()
    elseif key == 'A' then toggle_menu('audio'); state.menu_offset = 0; render_menu()
    elseif key:match('^%d$') and state.settings.numberKeyRateSwitch then
        local value = tonumber(key); set_speed(value == 0 and 1 or value)
    end
end

local function on_mbtn_left(event)
    local x, y = mouse_pos()

    if event.event == 'down' then
        state.pending_click = nil
        activity()
        if state.info_visible then
            state.block_gesture_until = mp.get_time() + (tonumber(state.settings.doubleClickMilliseconds) or 500) / 1000
            local z = hit(state.info_zones, x, y)
            if z then z.action() else state.info_visible = false; render_all() end
            return
        end
        if state.menu then
            state.block_gesture_until = mp.get_time() + (tonumber(state.settings.doubleClickMilliseconds) or 500) / 1000
            local z = hit(state.menu_zones, x, y)
            if z then
                z.action()
                return
            end
            state.menu = nil
            state.sub_searching = false
            render_menu()
        end
        local z = hit(state.top_zones, x, y) or hit(state.zones, x, y)
        if z then
            state.block_gesture_until = mp.get_time() + (tonumber(state.settings.doubleClickMilliseconds) or 500) / 1000
            if z.name == 'seek' then
                state.seek_drag = true
                seek_to_frac(seek_frac_at(x))
                render_bar()
            elseif z.name == 'volume-slider' then
                state.volume_drag = true
                volume_at(x)
                render_bar()
            else
                z.action()
            end
            return
        end
        if state.bar_bounds and hit({state.bar_bounds}, x, y) then return end
        if state.settings.mouseLeftClick == 'playpause' then
            -- Wait for the double-click interval so a configured double-click is one action.
            state.pending_click = mp.get_time() + clamp(tonumber(state.settings.doubleClickMilliseconds) or 500, 100, 1500) / 1000
        end
    elseif event.event == 'up' then
        if state.volume_drag then
            volume_at(x)
            state.volume_drag = false
            activity()
            render_bar()
        end
        if state.seek_drag then
            state.seek_drag = false
            seek_to_frac(seek_frac_at(x))
            render_bar()
        end
    end
end

mp.register_script_message('mjc-settings', function(json)
    local settings = utils.parse_json(json)
    if type(settings) ~= 'table' then return end
    finish_hold()
    for key, value in pairs(settings) do
        if key ~= 'autoLockOnPause' then state.settings[key] = value end
    end
    if settings.audioBoost ~= nil then
        local maximum = settings.audioBoost and 200 or 100
        cmd('set', 'volume-max', tostring(maximum))
        if state.volume > maximum then state.volume = maximum; cmd('set', 'volume', tostring(maximum)) end
    end
    state.ui_scale = clamp(tonumber(settings.uiScale) or state.ui_scale, 0.5, 4)
    state.rewind_seconds = clamp(tonumber(settings.rewindSeconds) or state.rewind_seconds, 1, 600)
    state.forward_seconds = clamp(tonumber(settings.forwardSeconds) or state.forward_seconds, 1, 600)
    if settings.preciseSeek ~= nil then state.precise_seek = settings.preciseSeek == true end
    if type(settings.subtitleSearchQueries) == 'table' then
        state.sub_history = {}
        for _, value in ipairs(settings.subtitleSearchQueries) do
            if type(value) == 'string' and #state.sub_history < 8 then state.sub_history[#state.sub_history + 1] = value end
        end
    end
    restore_tracks(); render_all()
end)

mp.register_script_message('mjc-ui-scale', function(value)
    state.ui_scale = clamp(tonumber(value) or 1, 0.5, 4)
    render_all()
end)

mp.register_script_message('mjc-key-down', function(key) on_key(key, true) end)
mp.register_script_message('mjc-key-up', function(key) on_key(key, false) end)
mp.register_script_message('mjc-cancel-input', function() finish_hold(); state.pending_click = nil end)
-- The Win32 host owns capture. Read its actual coordinates while held instead
-- of relying on mpv key-section hit testing or its clipped mouse-pos property.
mp.register_script_message('mjc-pointer', function(event, sx, sy)
    local x, y = tonumber(sx), tonumber(sy)
    if not x or not y or x ~= x or y ~= y then return end
    state.native_pointer = {x = x, y = y}
    if event == 'down' then
        on_mbtn_left({event = 'down'})
    elseif event == 'move' then
        activity()
        if state.volume_drag then volume_at(x)
        elseif state.seek_drag then seek_to_frac(seek_frac_at(x)) end
        render_bar()
    elseif event == 'up' then
        on_mbtn_left({event = 'up'})
        state.native_pointer = nil
    end
end)
mp.register_script_message('mjc-text-input', function(text)
    if state.sub_searching and type(text) == 'string' and #state.sub_query < 128 then
        text = text:gsub('[%z\1-\31\127]', '')
        state.sub_query = state.sub_query .. text
        state.menu_offset = 0; render_menu()
    end
end)

mp.register_script_message('mjc-seek-settings', function(rewind, forward, precise)
    state.rewind_seconds = clamp(tonumber(rewind) or 15, 1, 600)
    state.forward_seconds = clamp(tonumber(forward) or 15, 1, 600)
    state.precise_seek = precise == 'true'
end)
mp.register_script_message('mjc-media-details', function(json)
    state.media_info = utils.parse_json(json) or {}
    if type(state.media_info) ~= 'table' then state.media_info = {} end
    if type(state.media_info.title) == 'string' then state.title = state.media_info.title end
    render_top()
    render_info()
end)
mp.register_script_message('mjc-double-click', function(mx, my)
    state.pending_click = nil
    activity()
    local x, y = tonumber(mx), tonumber(my)
    if not x or not y then x, y = mouse_pos() end
    if not state.info_visible and not state.menu and not hit(state.top_zones, x, y)
        and not hit(state.zones, x, y) and not (state.bar_bounds and hit({state.bar_bounds}, x, y))
        and mp.get_time() >= (state.block_gesture_until or 0)
        and state.duration > 0
        and state.settings.mouseLeftDoubleClick == 'playpause' then toggle_pause() end
end)
mp.register_script_message('mjc-escape', escape)
mp.register_script_message('mjc-media-info', show_media_info)

-- gpu-next also runs OUTPUT hooks for video screenshots. Serialize captures in
-- this Lua callback and restore parameters even on failure, so saved frames
-- retain the normal GPU color/subtitle pipeline.
mp.register_script_message('mjc-capture', function(token, path, mode)
    if mode ~= 'video' and mode ~= 'subtitles' then return end
    local opts = mp.get_property_native('glsl-shader-opts') or {}
    local enabled = (tonumber(opts['mjc-glass/surface_count']) or 0) > 0
    local ready, disable_error = true, nil
    if enabled then
        local disabled = {}
        for key, value in pairs(opts) do disabled[key] = value end
        disabled['mjc-glass/surface_count'] = '0'
        ready, disable_error = mp.set_property_native('glsl-shader-opts', disabled)
    end
    local called, success, err = false, false, disable_error
    if ready then called, success, err = pcall(mp.commandv, 'screenshot-to-file', path, mode) end
    if enabled then
        local restored = mp.set_property_native('glsl-shader-opts', opts)
        if not restored then last_glass_params = ''; publish_glass() end
    end
    mp.commandv('script-message', 'mjc-capture-result', token,
        called and success and 'success' or 'error', tostring(err or ''))
end)

mp.add_forced_key_binding('mbtn_left', 'mjc-osc-mbtn-left', on_mbtn_left, { complex = true })

mp.add_forced_key_binding('mbtn_right', 'mjc-osc-mbtn-right', function()
    if state.settings.mouseRightClick ~= 'toggleControls' then return end
    state.last_active = mp.get_time()
    state.visible = not state.visible
    if not state.visible then state.menu = nil; state.sub_searching = false end
    render_all()
end)

for _, key in ipairs({'LEFT', 'RIGHT', 'UP', 'DOWN', 'SPACE', 'ENTER', 'ESC', 'F', 'M', 'A', 'S', 'BS', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'}) do
    local name = key
    mp.add_forced_key_binding(key, 'mjc-key-' .. key, function(event)
        if event.event == 'up' then on_key(name, false)
        elseif event.event == 'down' or event.event == 'repeat' then on_key(name, true)
        elseif event.event == 'press' then on_key(name, true); on_key(name, false) end
    end, {complex = true, repeatable = false})
end
mp.add_forced_key_binding('any_unicode', 'mjc-search-text', function(event)
    if state.sub_searching and event.event ~= 'up' and event.key_text then
        state.sub_query = state.sub_query .. event.key_text; state.menu_offset = 0; render_menu()
    end
end, {complex = true, repeatable = true})
for _, direction in ipairs({'wheel_up', 'wheel_down'}) do
    local delta = direction == 'wheel_up' and -3 or 3
    mp.add_forced_key_binding(direction, 'mjc-menu-' .. direction, function()
        if state.info_visible then
            state.info_offset = math.max(0, state.info_offset + delta); render_info(); return
        end
        if state.menu then
            state.menu_offset = math.max(0, state.menu_offset + delta); render_menu()
        else
            local volume = clamp(state.volume + (delta < 0 and 2 or -2), 0, volume_maximum())
            cmd('set', 'volume', tostring(volume))
        end
    end)
end

-- drag support
mp.add_periodic_timer(0.03, function()
    if state.pending_click and mp.get_time() >= state.pending_click then
        state.pending_click = nil
        toggle_pause()
    end
    local held = state.held_key
    if held and not held.active and mp.get_time() - held.since >= 0.35 then
        held.active = true
        set_speed(clamp(tonumber(held.key == 'LEFT' and state.settings.longPressLeftRate or state.settings.longPressRightRate) or 1, 0.1, 16))
    end
    local volume_key = state.volume_key
    if volume_key and mp.get_time() - volume_key.since >= 0.35
        and mp.get_time() - volume_key.last >= 0.1 then
        volume_key.last = mp.get_time()
        local volume = clamp(state.volume + (volume_key.key == 'UP' and 5 or -5), 0, volume_maximum())
        cmd('set', 'volume', tostring(volume))
    end
    if state.seek_drag then
        local x = mouse_pos()
        seek_to_frac(seek_frac_at(x))
    end
    if state.volume_drag then
        volume_at(mouse_pos())
        render_bar()
    end
end)

-- ---------- autohide ----------
mp.add_periodic_timer(0.25, function()
    if state.info_visible then render_info() end
    if state.visible and not state.persistent and not state.menu and not state.info_visible and not state.seek_drag and not state.volume_drag then
        if mp.get_time() - state.last_active >= (tonumber(state.settings.autoHideControlsSeconds) or 3) then
            state.visible = false
            render_all()
        end
    end
end)

mp.register_event('file-loaded', function()
    last_cursor_zones = '' -- Replay after IPC connects, including duration-less streams.
    state.remembered_applied = { audio = false, sub = false }
    state.preferred_applied = {}
    sync_tracks()
    state.title = state.media_info.title or mp.get_property('media-title') or ''
    state.visible = true
    state.last_active = mp.get_time()
    if state.settings.showPlayTitleToast and state.title ~= '' then mp.osd_message(state.title, 3) end
    render_all()
end)

mp.register_event('end-file', function()
    finish_hold(); state.pending_click = nil; state.sub_searching = false
    state.menu = nil
    render_all()
end)

sync_tracks()
render_all()
