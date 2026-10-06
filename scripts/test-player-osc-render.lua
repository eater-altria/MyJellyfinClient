-- Deterministic controller state over mpv's real GPU/ASS renderer.
-- Used by the native render regression; all media and tracks are synthetic.
local native_property, string_property = mp.get_property_native, mp.get_property
local register_message = mp.register_script_message
local native_command = mp.commandv
local observers, messages = {}, {}
local mouse = {x = 0, y = 0}
local tracks = {
    {type = 'sub', id = 1, title = '简体中文 · SRT', lang = 'zho'},
    {type = 'sub', id = 2, title = 'English · SRT', lang = 'eng'},
    {type = 'audio', id = 3, title = '英语 · 5.1', lang = 'eng'},
    {type = 'audio', id = 4, title = '中文 · 立体声', lang = 'zho'},
}
mp.get_property_native = function(name)
    if name == 'mouse-pos' then return mouse end
    if name == 'track-list' then return tracks end
    return native_property(name)
end
mp.get_property = function(name)
    if name == 'sid' then return '1' end
    if name == 'aid' then return '3' end
    if name == 'media-title' then return 'stream?PlaySessionId=fixture' end
    return string_property(name)
end
mp.observe_property = function(name, _, callback) observers[name] = callback end
mp.register_script_message = function(name, callback) messages[name] = callback end
mp.add_periodic_timer = function() end
mp.commandv = function(command, ...)
    if command == 'screenshot-to-file' or (command == 'script-message' and select(1, ...) == 'mjc-capture-result') then
        return native_command(command, ...)
    end
end
mp.add_forced_key_binding = function() end
mp.register_event = function() end

dofile('src-tauri/resources/mpv/portable_config/scripts/mjc-osc.lua')
register_message('mjc-capture', messages['mjc-capture'])

register_message('mjc-render-fixture', function(scale, mode)
    messages['mjc-settings']('{"showSkipButtons":true,"showSwitchMediaButton":true,"showScreenshotButton":true,"autoLockOnPause":false,"matchWindowToVideoRatio":false}')
    messages['mjc-ui-scale'](scale)
    messages['mjc-media-details']('{"title":"泰坦尼克号","filename":"fixture.mkv","container":"mkv"}')
    observers.duration('duration', 10578)
    observers['time-pos']('time-pos', 864)
    observers.pause('pause', mode == 'paused')
    observers['mouse-pos']('mouse-pos', mouse)
    if mode == 'sub' or mode == 'letterbox' then messages['mjc-key-down']('S') end
    if mode == 'hover' then
        local dimensions = native_property('osd-dimensions')
        mouse = {x = dimensions.w * 0.45, y = dimensions.h - 99}
        observers['mouse-pos']('mouse-pos', mouse)
    end
end)
