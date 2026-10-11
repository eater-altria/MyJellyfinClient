-- Deterministic controller state over mpv's real GPU/ASS renderer.
-- Used by the native render regression; all media and tracks are synthetic.
local native_property, string_property = mp.get_property_native, mp.get_property
local number_property = mp.get_property_number
local danmaku_time
local register_message = mp.register_script_message
local native_command = mp.commandv
local set_native_property = mp.set_property_native
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
mp.get_property_number = function(name, default)
    if name == 'time-pos' and danmaku_time then return danmaku_time end
    return number_property(name, default)
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
    observers['demuxer-cache-state']('demuxer-cache-state', {['seekable-ranges'] = {
        {start = 0, ['end'] = 3702.3}, {start = 6875.7, ['end'] = 8462.4},
    }})
    observers.pause('pause', mode == 'paused')
    observers['mouse-pos']('mouse-pos', mouse)
    if mode == 'sub' or mode == 'letterbox' then messages['mjc-key-down']('S') end
    if mode == 'hover' then
        local dimensions = native_property('osd-dimensions')
        mouse = {x = dimensions.w * 0.45, y = dimensions.h - 99}
        observers['mouse-pos']('mouse-pos', mouse)
    end
    if mode == 'danmaku' then
        danmaku_time = 4
        messages['mjc-danmaku-begin']('{"danmakuEnabled":true,"danmakuFontSize":24,"danmakuOpacity":1,"danmakuArea":1,"danmakuDuration":8}', '弹幕渲染回归')
        messages['mjc-danmaku-chunk']('[{"time":0,"mode":1,"color":16777215,"text":"滚动弹幕"},{"time":0,"mode":5,"color":16711680,"text":"弹幕渲染测试"},{"time":0,"mode":6,"color":65280,"text":"反向弹幕"}]')
        messages['mjc-danmaku-end']()
    end
    if mode == 'danmaku-source' then
        messages['mjc-danmaku-begin']('{"danmakuEnabled":true,"danmakuSource":"api","danmakuSelection":"91"}', '自动匹配成功，已加载 4 条弹幕')
        messages['mjc-danmaku-choices']('[{"id":"91","label":"第1话 英灵召唤 · 测试来源","episode":"第1话 英灵召唤","title":"测试剧集 第一季(2011) from fixture"},{"id":"92","label":"第2话 · 测试来源","episode":"第2话 剧集标题","title":"测试剧集 第一季(2011) from fixture"}]')
        messages['mjc-danmaku-end']()
        for i = 1, 30 do
            local name, value = debug.getupvalue(render_bar, i)
            if name == 'state' then value.menu = 'danmaku-source'; value.menu_offset = 0; break end
        end
        render_all()
    end
    for i = 1, 30 do
        local name, value = debug.getupvalue(render_bar, i)
        if name == 'state' then set_native_property('user-data/mjc-render-seek', value.seek); break end
    end
end)
