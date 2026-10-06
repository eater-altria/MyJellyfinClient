-- Run from the repository root with bundled mpv:
-- mpv --no-config --vo=null --idle=yes --script=scripts/test-player-osc.lua
-- Uses mpv's real ASS path generator, with a deterministic controller surface.
local quit = mp.commandv
local observers, bindings, overlays, commands = {}, {}, {}, {}
local messages = {}
local cursor_zones = {}
local capture_fails = false
local utils = require('mp.utils')
mp.register_script_message = function(name, callback) messages[name] = callback end
local osd_messages = {}
mp.osd_message = function(value) osd_messages[#osd_messages + 1] = value end
local mouse = { x = 0, y = 0 }
local dimensions = { w = 1280, h = 760 }
local tracks, properties, timers, events = {}, {}, {}, {}
local clock = 1
local shader_opts, shader_updates = {['other/amount'] = '0.7'}, 0
local target_params = {gamma = 'srgb'}
mp.set_property_native = function(name, value)
    assert(name == 'glsl-shader-opts')
    shader_opts = value
    shader_updates = shader_updates + 1
    return true
end
mp.create_osd_overlay = function()
    local ov = { update = function() end }
    overlays[#overlays + 1] = ov
    return ov
end
mp.get_property_native = function(name)
    if name == 'video-target-params' then return target_params end
    if name == 'glsl-shader-opts' then return shader_opts end
    if name == 'osd-dimensions' then return dimensions end
    if name == 'mouse-pos' then return mouse end
    if name == 'track-list' then return tracks end
end
mp.get_property = function(name) return properties[name] end
mp.get_property_number = function() return nil end
mp.get_osd_size = function() return dimensions.w, dimensions.h end
mp.get_time = function() return clock end
mp.observe_property = function(name, _, callback) observers[name] = callback end
mp.add_forced_key_binding = function(key, _, callback) bindings[key] = callback end
mp.add_periodic_timer = function(interval, callback) timers[interval] = callback end
mp.register_event = function(name, callback) events[name] = callback end
mp.commandv = function(...)
    local command = {...}
    if command[1] == 'screenshot-to-file' then
        assert(tonumber(shader_opts['mjc-glass/surface_count']) == 0, 'Only the glass backing must be bypassed during capture')
        if capture_fails then error('fixture capture failed') end
        return true
    end
    if command[1] == 'script-message' and command[2] == 'mjc-cursor-zones' then
        cursor_zones = utils.parse_json(command[3]) or {}
    else commands[#commands + 1] = command end
end

local function cursor_at(x, y)
    for _, z in ipairs(cursor_zones) do
        if x >= z.x0 and x <= z.x1 and y >= z.y0 and y <= z.y1 then return z.cursor end
    end
    return 'default'
end
local function glass_at(x, y)
    for i = 1, tonumber(shader_opts['mjc-glass/surface_count']) do
        local prefix = 'mjc-glass/r' .. i .. '_'
        local rx, ry = tonumber(shader_opts[prefix .. 'x']), tonumber(shader_opts[prefix .. 'y'])
        local rw, rh = tonumber(shader_opts[prefix .. 'w']), tonumber(shader_opts[prefix .. 'h'])
        if x >= rx and x <= rx + rw and y >= ry and y <= ry + rh then return true end
    end
    return false
end

local function click(x, y)
    mouse.x, mouse.y = x, y
    bindings.mbtn_left({event = 'down'})
    bindings.mbtn_left({event = 'up'})
end
local function last(name, value)
    local c = commands[#commands]
    assert(c and c[1] == name and c[2] == value,
        'Unexpected command, expected ' .. name .. ' ' .. tostring(value))
end
local function click_label(overlay, label)
    for event in overlays[overlay].data:gmatch('[^\n]+') do
        if event:find(label, 1, true) then
            local x, y = event:match('\\pos%(([%-%d%.]+),([%-%d%.]+)%)')
            assert(x and y, 'Missing text position for ' .. label)
            click(tonumber(x) + 4, tonumber(y) + 4)
            return
        end
    end
    error('Visible label missing: ' .. label)
end
local function has_command(from, name, value)
    for i = from, #commands do
        if commands[i][1] == name and commands[i][2] == value then return commands[i] end
    end
end
local controller
local function control(name)
    for _, z in ipairs(controller.zones) do if z.name == name then return z end end
    error('Visible control missing: ' .. name)
end
local function center(name)
    local z = control(name)
    return (z.x0 + z.x1) / 2, (z.y0 + z.y1) / 2
end
local function click_control(name) click(center(name)) end
local function cursor_control(name) return cursor_at(center(name)) end
local ok, err = pcall(function()
    dofile('src-tauri/resources/mpv/portable_config/scripts/mjc-osc.lua')
    for i = 1, 30 do
        local name, value = debug.getupvalue(render_bar, i)
        if name == 'state' then controller = value; break end
    end
    assert(controller, 'Controller layout must be accessible to interaction tests')
    assert(tonumber(shader_opts['mjc-glass/surface_count']) == 0, 'Loading must not blur the empty viewport')
    assert(shader_opts['other/amount'] == '0.7', 'Glass parameters must preserve other shader options')
    target_params.gamma = 'pq'
    observers['video-target-params']('video-target-params', target_params)
    assert(tonumber(shader_opts['mjc-glass/saturation']) == 1, 'PQ output must bypass the SDR saturation matrix')
    target_params.gamma = 'hlg'
    observers['video-target-params']('video-target-params', target_params)
    assert(tonumber(shader_opts['mjc-glass/saturation']) == 1, 'HLG output must also preserve its color transform')
    target_params.gamma = 'srgb'
    observers['video-target-params']('video-target-params', target_params)
    assert(tonumber(shader_opts['mjc-glass/saturation']) > 1, 'Returning to SDR must restore glass saturation')
    assert(not overlays[3].data:find('退出播放', 1, true), 'Playback exit belongs to the title-bar close button')
    assert(cursor_at(20, 20) == 'default', 'Removed exit button must not leave an invisible cursor region')
    assert(cursor_at(600, 350) == 'default', 'Video background must keep the default cursor')
    messages['mjc-escape']()
    last('script-message', 'mjc-quit')
    messages['mjc-settings']('{"showSkipButtons":true,"showSwitchMediaButton":false,"showScreenshotButton":false,"autoLockOnPause":false}')
    observers.duration('duration', 3600)
    observers['time-pos']('time-pos', 120)
    observers['mouse-pos']('mouse-pos', mouse)
    observers['media-title']('media-title', '测试 {\\p1} title')
    properties['media-title'] = '测试影片'
    assert(overlays[1].res_x == 1280 and overlays[1].res_y == 760)
    assert(overlays[1].data:find('02:00', 1, true))
    assert(glass_at(640, 750) and not glass_at(640, 350), 'Blur must follow the visible control surface')
    local before_shader_updates = shader_updates
    observers['time-pos']('time-pos', 121)
    assert(shader_updates == before_shader_updates, 'Playback progress must not resend unchanged glass geometry')
    assert(control('sub') and control('audio'), 'Track actions must be icon controls')
    assert(not overlays[1].data:find('字幕', 1, true), 'Icon labels appear only on hover')
    mouse.x, mouse.y = center('sub')
    observers['mouse-pos']('mouse-pos', mouse)
    assert(overlays[1].data:find('字幕 · S', 1, true), 'Hovering an icon must reveal its action label')
    mouse.x, mouse.y = 0, 0
    observers['mouse-pos']('mouse-pos', mouse)
    assert(not overlays[1].data:find('字幕 · S', 1, true), 'Hover labels must disappear after leaving the icon')
    assert(cursor_control('seek') == 'pointer', 'Seek slider must have a hand cursor')
    assert(cursor_control('playpause') == 'pointer', 'Play button must have a hand cursor')
    assert(cursor_control('volume-slider') == 'pointer', 'Volume slider must have its own native pointer region')
    local function volume_point(fraction)
        local slider = controller.volume_slider
        return slider.x0 + (slider.x1 - slider.x0) * fraction, select(2, center('volume-slider'))
    end
    click(volume_point(0.25)); last('set', 'volume')
    assert(commands[#commands][3] == '50', 'Enabled boost gives the slider its real 0-200 range')
    mouse.x, mouse.y = volume_point(0.2)
    bindings.mbtn_left({event = 'down'})
    mouse.x = controller.volume_slider.x0 - 200
    timers[0.03]()
    assert(controller.volume == 0, 'Dragging beyond the left edge must clamp to zero')
    clock = clock + 10; timers[0.25]()
    assert(#controller.zones > 0, 'A held volume drag must keep the control bar visible')
    mouse.x = controller.volume_slider.x1 + 200
    bindings.mbtn_left({event = 'up'})
    assert(controller.volume == 200 and not controller.volume_drag, 'Drag release must clamp to the boost limit and end the gesture')
    messages['mjc-settings']('{"audioBoost":false}')
    observers.mute('mute', true)
    local before_volume = #commands + 1
    click(volume_point(0.4)); last('set', 'volume')
    assert(controller.volume == 40 and not controller.mute, 'A positive slider value must unmute and use the 0-100 range')
    assert(has_command(before_volume, 'set', 'mute')[3] == 'no')
    click_control('vol'); last('cycle', 'mute')
    observers.mute('mute', true)
    assert(controller.volume == 40, 'One-click mute must preserve the volume for restoration')
    click_control('vol'); last('cycle', 'mute')
    observers.mute('mute', false)
    mouse.x, mouse.y = volume_point(0.6)
    bindings.mbtn_left({event = 'down'})
    messages['mjc-cancel-input']()
    assert(not controller.volume_drag, 'Focus/capture loss must cancel the volume drag')
    local volume_command_count = #commands
    mouse.x = controller.volume_slider.x1 + 100
    timers[0.03]()
    assert(#commands == volume_command_count, 'A cancelled drag must not continue changing volume')
    messages['mjc-settings']('{"audioBoost":true}')
    observers.volume('volume', 100)
    -- mpv mouse-pos deliberately remains stale while the captured host reports
    -- coordinates outside both the slider and the video child window.
    local px, py = volume_point(0.3)
    messages['mjc-pointer']('down', tostring(px), tostring(py))
    messages['mjc-pointer']('move', tostring(controller.volume_slider.x0 + (controller.volume_slider.x1 - controller.volume_slider.x0) * 0.8), '-100')
    timers[0.03]()
    assert(controller.volume_drag and controller.volume == 160, 'Captured volume dragging must continue above the slider even with stale mpv coordinates')
    messages['mjc-pointer']('up', tostring(controller.volume_slider.x1 + 100), '-100')
    assert(controller.volume == 200 and not controller.volume_drag and not controller.native_pointer,
        'Releasing outside the slider must apply the final value and clear capture state')
    px, py = center('seek')
    messages['mjc-pointer']('down', tostring(px), tostring(py))
    messages['mjc-pointer']('move', tostring(controller.seek.x1 + 100), '-100')
    last('seek', commands[#commands][2])
    assert(tonumber(commands[#commands][2]) == controller.duration and controller.seek_drag,
        'Captured seeking must continue outside the seek bar and clamp to the duration')
    messages['mjc-pointer']('up', tostring(controller.seek.x0 - 100), '10000')
    assert(tonumber(commands[#commands][2]) == 0 and not controller.seek_drag, 'Releasing below the video must finish seeking at the captured position')
    messages['mjc-pointer']('down', tostring(center('seek')), tostring(select(2, center('seek'))))
    messages['mjc-cancel-input']()
    assert(not controller.seek_drag and not controller.native_pointer, 'Losing native capture must cancel seeking as well')
    observers.volume('volume', 100)
    clock = clock + 1 -- End the control double-click suppression interval.
    assert(overlays[3].data:find('｛＼p1｝', 1, true), 'Title must escape ASS tags')
    for _, ov in ipairs(overlays) do
        for event in ov.data:gmatch('[^\n]+') do
            local _, count = event:gsub('\\p4', '')
            assert(count <= 1, 'Subpaths must use one drawing block per event')
            assert(not event:find('\\p1', 1, true), 'ASS path scale must match assdraw')
        end
    end
    local count = #commands
    click(600, 350)
    assert(#commands == count, 'Single click on the video must not pause')
    messages['mjc-double-click']('600', '350')
    last('cycle', 'pause')
    count = #commands
    messages['mjc-double-click'](tostring(center('fs')), tostring(select(2, center('fs'))))
    assert(#commands == count, 'Double click on controls must not pause')
    messages['mjc-media-details']('{"title":"测试影片","filename":"movie.mkv","container":"mkv","size":1073741824}')
    observers['media-title']('media-title', 'stream?Static=true&PlaySessionId=fixture')
    events['file-loaded']()
    assert(overlays[3].data:find('测试影片', 1, true), 'Server metadata must survive mpv file loading')
    assert(not overlays[3].data:find('PlaySessionId=', 1, true), 'Streaming URL must never replace the metadata title')
    assert(osd_messages[#osd_messages] == '测试影片', 'Title toast must also use metadata')
    messages['mjc-media-info']()
    assert(overlays[4].data:find('媒体信息', 1, true))
    assert(cursor_control('seek') == 'default', 'A modal must block cursor interaction with the controls underneath')
    assert(cursor_control('volume-slider') == 'default', 'Media info must block the volume slider as well')
    assert(cursor_zones[1].cursor == 'pointer', 'Media info close action must have a hand cursor')
    assert(overlays[4].data:find('movie.mkv', 1, true))
    assert(not overlays[4].data:find('api_key=', 1, true))
    messages['mjc-escape']()
    assert(overlays[4].data == '', 'Escape must close the info panel')
    messages['mjc-media-info']()
    click(10, 350)
    assert(overlays[4].data == '', 'Click outside must close the info panel')
    messages['mjc-media-info']()
    click(1100, 90)
    assert(overlays[4].data == '', 'Close button must close the info panel')
    -- Asymmetric settings ensure each button uses the correct configured duration.
    messages['mjc-seek-settings']('5', '30', 'false')
    click_control('rewind')
    last('seek', -5)
    assert(commands[#commands][3] == 'relative+keyframes')
    click_control('forward')
    last('seek', 30)
    assert(commands[#commands][3] == 'relative+keyframes')
    messages['mjc-seek-settings']('10', '15', 'true')
    click_control('rewind')
    last('seek', -10)
    assert(commands[#commands][3] == 'relative+exact')
    click_control('forward')
    last('seek', 15)
    assert(commands[#commands][3] == 'relative+exact')
    click_control('playpause')
    last('cycle', 'pause')
    mouse.x, mouse.y = center('seek'); mouse.x = controller.seek.x0 + 40
    bindings.mbtn_left({event = 'down'})
    last('seek', commands[#commands][2])
    local first_seek = tonumber(commands[#commands][2])
    mouse.x = controller.seek.x1 - 40
    bindings.mbtn_left({event = 'up'})
    assert(tonumber(commands[#commands][2]) > first_seek, 'Drag release must seek to new position')
    assert(commands[#commands][3] == 'absolute+exact')
    messages['mjc-seek-settings']('15', '15', 'false')
    click_control('seek')
    assert(commands[#commands][3] == 'absolute+keyframes')
    click_control('vol')
    last('cycle', 'mute')
    click_control('fs')
    last('script-message', 'mjc-fullscreen')
    click_control('sub')
    local menu_x = tonumber(overlays[2].data:match(' m (%d+)')) / 8
    assert(menu_x < controller.menu_anchors.sub and menu_x + 150 > controller.menu_anchors.sub, 'Subtitle menu must be above its button')
    local sub_menu_x = menu_x
    click_control('audio')
    -- There are no audio tracks in this fixture, so use the speed menu as another anchor.
    click_control('speed')
    menu_x = tonumber(overlays[2].data:match(' m (%d+)')) / 8
    assert((menu_x - sub_menu_x) * (controller.menu_anchors.speed - controller.menu_anchors.sub) > 0, 'Menus must follow their individual buttons')
    messages['mjc-escape']()
    -- Native settings must reach actual actions, instead of remaining frontend-only.
    messages['mjc-settings']('{"showSkipButtons":false,"showSwitchMediaButton":true,"showScreenshotButton":true,"accentColor":"#ff453a","autoHideControlsSeconds":5}')
    assert(control('prev') and control('next'), 'Switch buttons enabled')
    click_control('prev'); last('script-message', 'mjc-switch-media')
    assert(commands[#commands][3] == 'prev')
    click_control('next'); assert(commands[#commands][3] == 'next')
    click_control('screenshot'); last('script-message', 'mjc-screenshot')
    assert(overlays[1].data:find('&HFFFFFF&', 1, true) and not overlays[1].data:find('&H3A45FF&', 1, true), 'Playback UI stays white regardless of the library accent')
    messages['mjc-settings']('{"showSwitchMediaButton":false,"showSkipButtons":true,"showScreenshotButton":false}')
    for _, z in ipairs(controller.zones) do assert(z.name ~= 'prev' and z.name ~= 'next', 'Switch buttons disabled') end
    click_control('more')
    assert(not overlays[2].data:find('截图', 1, true), 'Screenshot hidden in more menu as well')
    messages['mjc-escape']()
    messages['mjc-settings']('{"autoHideControlsSeconds":3}')
    clock = 100; observers['mouse-pos']('mouse-pos', mouse)
    clock = 102.99; timers[0.25]()
    assert(#controller.zones > 0, 'The 3-second interval must not hide controls early')
    clock = 103; timers[0.25]()
    assert(#controller.zones == 0, 'Idle controls must hide at 3 seconds')
    assert(tonumber(shader_opts['mjc-glass/surface_count']) == 0, 'Auto-hide must bypass every GPU blur pass')
    assert(cursor_at(500, 722) == 'default', 'Auto-hidden controls must clear their interactive cursor regions')
    messages['mjc-settings']('{"autoHideControlsSeconds":5}')
    clock = 200; observers['mouse-pos']('mouse-pos', mouse)
    clock = 204.9; timers[0.25]()
    assert(#controller.zones > 0, 'Controls must remain visible before configured 5 seconds')
    clock = 205.1; timers[0.25]()
    assert(#controller.zones == 0, 'Controls must hide after configured 5 seconds')
    assert(cursor_at(500, 722) == 'default', 'Hidden controls must clear native cursor hit regions')
    observers['mouse-pos']('mouse-pos', mouse)
    messages['mjc-settings']('{"numberKeyRateSwitch":false,"mouseLeftClick":"none","mouseLeftDoubleClick":"none","mouseRightClick":"none"}')
    count = #commands
    messages['mjc-key-down']('3'); messages['mjc-key-up']('3')
    messages['mjc-double-click']('600', '350')
    bindings.mbtn_right()
    assert(#commands == count and #controller.zones > 0, 'Disabled gestures must do nothing')
    clock = clock + 1
    messages['mjc-settings']('{"numberKeyRateSwitch":true,"mouseLeftClick":"playpause","mouseLeftDoubleClick":"playpause","mouseRightClick":"toggleControls","doubleClickMilliseconds":250}')
    messages['mjc-key-down']('3'); last('set', 'speed'); assert(commands[#commands][3] == '3.00')
    messages['mjc-key-down']('0'); assert(commands[#commands][3] == '1.00')
    count = #commands; click(600, 350)
    assert(#commands == count, 'Single-click must wait for double-click interval')
    clock = clock + 0.26; timers[0.03](); last('cycle', 'pause')
    count = #commands; click(600, 350); messages['mjc-double-click']('600', '350')
    clock = clock + 0.3; timers[0.03]()
    assert(#commands == count + 1, 'Double-click must cancel its pending single-click')
    messages['mjc-settings']('{"doubleClickMilliseconds":500}')
    count = #commands; click(600, 350); clock = clock + 0.4; timers[0.03]()
    assert(#commands == count, 'Single-click must wait for the configured Windows double-click interval')
    messages['mjc-double-click']('600', '350'); clock = clock + 0.2; timers[0.03]()
    assert(#commands == count + 1, 'A slower system double-click must not trigger two pause actions')
    bindings.mbtn_right()
    assert(#controller.zones == 0, 'Right-click hides controls')
    bindings.mbtn_right()
    assert(#controller.zones > 0, 'Right-click shows controls')
    messages['mjc-settings']('{"rewindSeconds":5,"forwardSeconds":30,"preciseSeek":true,"longPressLeftRate":0.25,"longPressRightRate":3}')
    observers.speed('speed', 1.5)
    messages['mjc-key-down']('RIGHT'); messages['mjc-key-up']('RIGHT')
    last('seek', 30); assert(commands[#commands][3] == 'relative+exact')
    messages['mjc-key-down']('LEFT'); clock = clock + 0.36; timers[0.03]()
    last('set', 'speed'); assert(commands[#commands][3] == '0.25')
    count = #commands; messages['mjc-key-up']('LEFT')
    last('set', 'speed'); assert(commands[#commands][3] == '1.50' and #commands == count + 1, 'Long press restores previous speed without seeking')
    messages['mjc-key-down']('RIGHT'); clock = clock + 0.36; timers[0.03]()
    assert(commands[#commands][3] == '3.00'); messages['mjc-key-up']('RIGHT')
    messages['mjc-key-down']('RIGHT'); clock = clock + 0.36; timers[0.03]()
    messages['mjc-cancel-input']()
    last('set', 'speed'); assert(commands[#commands][3] == '1.50', 'Focus loss must restore the speed')
    messages['mjc-settings']('{"autoLockOnPause":true,"audioBoost":false,"showSwitchMediaButton":true}')
    observers.pause('pause', true)
    assert(not overlays[3].data:find('控件已锁定', 1, true), 'Legacy pause-lock preferences must not lock the player')
    assert(cursor_control('seek') == 'pointer', 'Paused timeline must remain interactive')
    click_control('prev'); last('script-message', 'mjc-switch-media'); assert(commands[#commands][3] == 'prev')
    click_control('next'); last('script-message', 'mjc-switch-media'); assert(commands[#commands][3] == 'next')
    messages['mjc-key-down']('ENTER'); last('script-message', 'mjc-fullscreen')
    messages['mjc-settings']('{"autoHideControlsSeconds":3}')
    clock = clock + 4; timers[0.25]()
    assert(#controller.zones == 0, 'Fixture controls must be hidden before testing Space')
    messages['mjc-key-down']('SPACE'); last('cycle', 'pause')
    observers.pause('pause', false)
    assert(#controller.zones == 0, 'Space must resume without waking the controls')
    messages['mjc-key-down']('SPACE'); last('cycle', 'pause')
    observers.pause('pause', true)
    assert(#controller.zones == 0, 'Space must pause without waking the controls')
    assert(not glass_at(640, 750) and glass_at(1200, 25), 'Hidden paused controls must blur only the pause badge')
    count = #commands; messages['mjc-key-down']('K')
    assert(#commands == count, 'Removed K lock shortcut must have no effect')
    clock = clock + 1
    messages['mjc-double-click']('600', '350'); last('cycle', 'pause')
    observers.pause('pause', false)
    local panel = controller.bar_bounds
    count = #commands
    messages['mjc-double-click'](tostring(panel.x0 + 2), tostring(panel.y1 - 2))
    assert(#commands == count, 'Blank space within the control surface must not toggle playback')
    observers.volume('volume', 100); messages['mjc-key-down']('UP')
    last('set', 'volume'); assert(commands[#commands][3] == '100')
    bindings.wheel_up(); assert(commands[#commands][3] == '100', 'Disabled audio boost limits wheel volume')
    messages['mjc-settings']('{"audioBoost":true}'); messages['mjc-key-down']('UP')
    assert(commands[#commands][3] == '105')
    bindings.wheel_up(); assert(commands[#commands][3] == '102', 'Wheel must preserve normal volume behavior outside menus')
    observers.volume('volume', 105); clock = clock + 0.36; timers[0.03]()
    assert(commands[#commands][3] == '110', 'Holding the volume key must continue increasing volume')
    messages['mjc-key-up']('UP'); count = #commands; clock = clock + 1; timers[0.03]()
    assert(#commands == count, 'Releasing volume key must stop volume adjustment')
    tracks = {
        {type = 'audio', id = 1, title = 'English audio', lang = 'eng', codec = 'aac'},
        {type = 'audio', id = 2, title = '日本語音声', lang = 'jpn', codec = 'aac'},
        {type = 'sub', id = 3, title = '简体中文', lang = 'zho', codec = 'subrip'},
        {type = 'sub', id = 4, title = 'English subtitle', lang = 'eng', codec = 'subrip'},
    }
    observers['track-list']('track-list', tracks)
    messages['mjc-settings']('{"rememberAudioTrack":true,"rememberSubtitle":true,"rememberedAudio":{"id":99,"lang":"jpn","title":"日本語音声"},"rememberedSubtitle":{"id":99,"lang":"eng","title":"English subtitle"}}')
    count = #commands + 1; events['file-loaded']()
    assert(has_command(count, 'set', 'aid')[3] == '2', 'Remembered audio must use metadata across different track IDs')
    assert(has_command(count, 'set', 'sid')[3] == '4', 'Remembered subtitle must use metadata across different track IDs')
    tracks[#tracks + 1] = {type = 'audio', id = 6, lang = 'eng', codec = 'aac'}
    tracks[#tracks + 1] = {type = 'sub', id = 7, lang = 'zho', codec = 'subrip'}
    tracks[#tracks + 1] = {type = 'sub', id = 8, lang = 'zho', codec = 'subrip'}
    messages['mjc-settings']('{"rememberedAudio":{"id":6,"lang":"eng","codec":"aac"},"rememberedSubtitle":{"id":8,"lang":"zho","codec":"subrip"}}')
    count = #commands + 1; events['file-loaded']()
    assert(has_command(count, 'set', 'aid')[3] == '6', 'Same-source audio ID must beat duplicated language/codec')
    assert(has_command(count, 'set', 'sid')[3] == '8', 'Same-source subtitle ID must beat duplicated language/codec')
    tracks[3].title = '繁体中文'; tracks[3].lang = 'zho'
    tracks[4].title = '简体中文'; tracks[4].lang = 'zho'
    messages['mjc-settings']('{"rememberAudioTrack":false,"rememberSubtitle":false,"preferredSubtitleLanguage":"简中","preferredAudioLanguage":"日文"}')
    count = #commands + 1; events['file-loaded']()
    assert(has_command(count, 'set', 'sid')[3] == '4', 'Simplified preference must select its title when both tracks use zho')
    assert(has_command(count, 'set', 'aid')[3] == '2', 'Preferred Japanese audio must be selected')
    messages['mjc-settings']('{"preferredSubtitleLanguage":"繁中"}')
    count = #commands + 1; events['file-loaded']()
    assert(has_command(count, 'set', 'sid')[3] == '3', 'Traditional preference must select its title when both tracks use zho')
    tracks[3].title = '简体中文'; tracks[4].title = 'English subtitle'; tracks[4].lang = 'eng'
    messages['mjc-settings']('{"preferredSubtitleLanguage":"默认","preferredAudioLanguage":"默认"}')
    tracks = { tracks[1], tracks[2], tracks[3], tracks[4] }
    observers['track-list']('track-list', tracks)
    messages['mjc-key-down']('S')
    assert(overlays[2].data:find('English subtitle', 1, true), 'S shortcut must open the subtitle menu, as advertised')
    messages['mjc-key-down']('S')
    assert(overlays[2].data == '', 'S shortcut must also close the subtitle menu')
    messages['mjc-settings']('{"rememberSubtitle":false,"rememberAudioTrack":false,"subtitleSearchHistory":true,"subtitleSearchQueries":["eng"]}')
    count = #commands + 1; events['file-loaded']()
    assert(not has_command(count, 'set', 'aid') and not has_command(count, 'set', 'sid'), 'Disabled track memory must not force a selection')
    click_control('sub')
    assert(overlays[2].data:find('最近: eng', 1, true), 'Stored subtitle history must be shown')
    click_label(2, '搜索当前字幕列表')
    assert(cursor_zones[1].cursor == 'text', 'Subtitle search field must advertise text input')
    messages['mjc-text-input']('English')
    assert(overlays[2].data:find('English subtitle', 1, true) and not overlays[2].data:find('简体中文', 1, true), 'Search must filter current subtitle tracks')
    messages['mjc-key-down']('ENTER')
    last('script-message', 'mjc-subtitle-search-history')
    click_label(2, 'English subtitle')
    last('script-message', 'mjc-track-selected')
    assert(commands[#commands][3] == 'sub' and commands[#commands][4]:find('eng', 1, true), 'Explicit subtitle selection must be sent for persistence')
    click_control('audio'); click_label(2, '日本語音声')
    assert(commands[#commands][3] == 'audio' and commands[#commands][4]:find('jpn', 1, true), 'Explicit audio selection must be sent for persistence')
    messages['mjc-settings']('{"subtitleSearchHistory":false}')
    click_control('sub'); click_label(2, '清除搜索')
    assert(not overlays[2].data:find('最近:', 1, true), 'Disabled history must not be displayed')
    click_label(2, '搜索当前字幕列表'); messages['mjc-text-input']('中')
    messages['mjc-key-down']('BACKSPACE')
    assert(overlays[2].data:find('English subtitle', 1, true), 'Backspace must remove an entire UTF-8 character')
    messages['mjc-text-input']('eng'); count = #commands
    messages['mjc-key-down']('ENTER')
    assert(#commands == count, 'Disabled subtitle history must not be persisted')
    messages['mjc-escape']()
    messages['mjc-settings']('{"showPlayTitleToast":false,"matchWindowToVideoRatio":false}')
    count = #osd_messages; events['file-loaded']()
    assert(#osd_messages == count, 'Disabled title toast')
    messages['mjc-settings']('{"showPlayTitleToast":true,"matchWindowToVideoRatio":true}')
    count = #osd_messages; events['file-loaded']()
    assert(#osd_messages == count + 1, 'Enabled title toast')
    dimensions = {w = 1920, h = 1080}
    observers['osd-dimensions']('osd-dimensions', dimensions)
    assert(overlays[1].res_x == 1920 and overlays[1].res_y == 1080)
    assert(glass_at(960, 1070) and not glass_at(640, 750), 'Resize must clear the previous backing rectangle')
    dimensions.mt, dimensions.mb = 132, 132
    observers['osd-dimensions']('osd-dimensions', dimensions)
    assert(tonumber(shader_opts['mjc-glass/video_y']) == 132 and tonumber(shader_opts['mjc-glass/video_h']) == 816,
        'Glass coordinates must account for letterbox margins')
    assert(cursor_control('seek') == 'pointer', 'Cursor regions must follow resized slider geometry')
    messages['mjc-settings']('{"autoLockOnPause":true}')
    observers.pause('pause', true)
    assert(cursor_control('seek') == 'pointer', 'Pausing after resize must keep the timeline usable')
    assert(not overlays[3].data:find('解锁', 1, true), 'Removed lock must not leave an unlock overlay')
    observers.pause('pause', false)
    click_control('more'); click_label(2, '缩放模式')
    last('set', 'panscan'); assert(commands[#commands][3] == '1', 'Crop-fill must use complete fill rather than 40 percent')
    click_control('more'); click_label(2, '缩放模式')
    assert(commands[#commands][3] == '0', 'Fit mode must restore contain scaling')
    assert(not has_command(1, 'script-message', 'mjc-detect-frame') and not has_command(1, 'set', 'video-crop'),
        'Fit mode must preserve the entire video without automatic black-padding detection or cropping')

    -- Resizing must reflow controls without shrinking their typography.
    messages['mjc-settings']('{"uiScale":1,"showSkipButtons":true,"showSwitchMediaButton":true,"showScreenshotButton":true}')
    for _, size in ipairs({{w=1280,h=720},{w=800,h=450},{w=760,h=420},{w=560,h=320},{w=480,h=320},{w=320,h=240}}) do
        dimensions = size
        observers['osd-dimensions']('osd-dimensions', dimensions)
        observers['mouse-pos']('mouse-pos', mouse)
        assert(overlays[1].data:find('\\fs14', 1, true), 'Time text must retain its 14px size in small windows')
        for _, z in ipairs(cursor_zones) do
            assert(z.x0 >= 0 and z.y0 >= 0 and z.x1 <= size.w and z.y1 <= size.h,
                'Interactive controls must stay within the resized viewport')
        end
        for i, z in ipairs(controller.zones) do
            assert(z.x1 > z.x0 and z.y1 > z.y0, 'Each control must have a positive hit area')
            for j = i + 1, #controller.zones do
                local other = controller.zones[j]
                assert(z.x1 <= other.x0 or other.x1 <= z.x0 or z.y1 <= other.y0 or other.y1 <= z.y0,
                    'Responsive transport and timeline hit areas must never overlap')
            end
        end
        click_control('more')
        assert(overlays[2].data:find('\\fs14', 1, true), 'Menu text must retain a readable fixed size')
        for _, z in ipairs(cursor_zones) do
            assert(z.x0 >= 0 and z.y0 >= 0 and z.x1 <= size.w and z.y1 <= size.h,
                'Menu items must stay within a small viewport')
        end
        if size.w < 440 then
            assert(overlays[2].data:find('倍速',1,true), 'Narrow windows must keep folded speed controls available')
            click_label(2, '倍速')
            assert(overlays[2].data:find('\\fs14',1,true), 'Submenus must keep the same font size')
        end
        messages['mjc-escape']()
    end
    dimensions = {w=640,h=480}
    messages['mjc-ui-scale']('2')
    observers['osd-dimensions']('osd-dimensions', dimensions)
    assert(overlays[1].data:find('\\fs28',1,true), '200 percent DPI must preserve the 14 logical-pixel text size')
    assert(tonumber(shader_opts['mjc-glass/ui_scale']) == 2 and glass_at(320, 400),
        'DPI changes must scale the blur and the compact control surface together')
    messages['mjc-ui-scale']('1')
    dimensions = {w=320,h=240}
    observers['osd-dimensions']('osd-dimensions', dimensions)
    messages['mjc-media-info']()
    assert(overlays[4].data:find('\\fs13',1,true), 'Media info must reflow rather than shrink its text')
    local before = overlays[4].data
    bindings.wheel_down()
    assert(overlays[4].data ~= before, 'Small media information panels must scroll')
    messages['mjc-escape']()
    local before_capture = shader_opts
    messages['mjc-capture']('fixture-success', 'fixture.png', 'subtitles')
    last('script-message', 'mjc-capture-result')
    assert(commands[#commands][3] == 'fixture-success' and commands[#commands][4] == 'success')
    assert(shader_opts == before_capture, 'A successful capture must restore every shader option')
    capture_fails = true
    messages['mjc-capture']('fixture-failure', 'fixture.png', 'video')
    assert(commands[#commands][3] == 'fixture-failure' and commands[#commands][4] == 'error')
    assert(shader_opts == before_capture, 'A failed capture must also restore the glass backing')
    capture_fails = false
end)
if ok then
    mp.msg.info('PASS: OSC drawing, glass geometry/hiding/DPI, capture restoration, exit, seeking, native controls, gestures, held-key speed restoration, paused navigation/fullscreen, hidden Space playback, audio boost, track memory, subtitle filtering/history and title toast')
else
    mp.msg.error(err)
end
quit('quit', ok and '0' or '1')
