// Isolated macOS GPU/embedding experiment. Production Windows code is untouched.
#import <Cocoa/Cocoa.h>
#import <OpenGL/gl3.h>
#import <mpv/client.h>
#import <mpv/render_gl.h>
#include <dlfcn.h>

@class VideoView;
static void scheduleRender(void *context);
static void scheduleEvents(void *context);

@interface VideoView : NSOpenGLView {
@public
    mpv_handle *_mpv;
    mpv_render_context *_renderer;
    BOOL _disposed;
    BOOL _glass;
    double _aspect;
    NSUInteger _renderedFrames;
    NSUInteger _shaderErrors;
    double _position;
    double _duration;
}
@property(nonatomic, copy) NSString *sourceShader;
@property(nonatomic, copy) NSString *generatedShader;
@property(nonatomic, copy) NSString *media;
@property(nonatomic, copy) void (^loaded)(void);
@property(nonatomic, copy) void (^failed)(NSString *);
@property(nonatomic, copy) void (^status)(NSString *);
@property(nonatomic, copy) void (^progress)(double);
- (void)drainEvents;
- (void)updateGlass;
- (void)setGlassEnabled:(BOOL)enabled;
- (void)command:(NSArray<NSString *> *)arguments;
- (void)shutdown;
- (NSData *)capturePixels;
- (NSSize)pixelSize;
@end

static void *getGLProc(void *context, const char *name) {
    (void)context;
    return dlsym(RTLD_DEFAULT, name);
}
static void scheduleRender(void *context) {
    VideoView *view = (__bridge VideoView *)context;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!view->_disposed) [view setNeedsDisplay:YES];
    });
}
static void scheduleEvents(void *context) {
    VideoView *view = (__bridge VideoView *)context;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!view->_disposed) [view drainEvents];
    });
}

@implementation VideoView
- (instancetype)initWithFrame:(NSRect)frame {
    NSOpenGLPixelFormatAttribute attributes[] = {
        NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
        NSOpenGLPFADoubleBuffer, NSOpenGLPFAAccelerated,
        NSOpenGLPFAColorSize, 24, NSOpenGLPFAAlphaSize, 8, 0
    };
    NSOpenGLPixelFormat *format = [[NSOpenGLPixelFormat alloc] initWithAttributes:attributes];
    self = [super initWithFrame:frame pixelFormat:format];
    if (self) {
        self.wantsBestResolutionOpenGLSurface = YES;
        _glass = YES;
        _aspect = 16.0 / 9.0;
    }
    return self;
}
- (BOOL)acceptsFirstResponder { return YES; }
- (void)prepareOpenGL {
    [super prepareOpenGL];
    if (_renderer || _disposed) return;
    [[self openGLContext] makeCurrentContext];
    GLint interval = 1;
    [[self openGLContext] setValues:&interval forParameter:NSOpenGLContextParameterSwapInterval];
    _mpv = mpv_create();
    if (!_mpv) { self.failed(@"mpv_create failed"); return; }
    const char *options[][2] = {
        {"config", "no"}, {"load-scripts", "no"}, {"vo", "libmpv"},
        {"hwdec", "auto-safe"}, {"osc", "no"}, {"terminal", "no"},
        {"keep-open", "yes"}, {"idle", "yes"}, {"tls-verify", "yes"},
        {"target-trc", "srgb"}, {"target-prim", "bt.709"},
        {"sub-font", "PingFang SC"}, {"osd-level", "0"}
    };
    for (NSUInteger i = 0; i < sizeof(options) / sizeof(options[0]); i++) {
        int result = mpv_set_option_string(_mpv, options[i][0], options[i][1]);
        if (result < 0) {
            self.failed([NSString stringWithFormat:@"Option %s: %s", options[i][0], mpv_error_string(result)]);
            return;
        }
    }
    int result = mpv_initialize(_mpv);
    if (result < 0) { self.failed(@"mpv_initialize failed"); return; }
    mpv_opengl_init_params gl = {.get_proc_address = getGLProc};
    mpv_render_param parameters[] = {
        {MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL},
        {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl}, {MPV_RENDER_PARAM_INVALID, NULL}
    };
    result = mpv_render_context_create(&_renderer, _mpv, parameters);
    if (result < 0) { self.failed([NSString stringWithFormat:@"GPU context: %s", mpv_error_string(result)]); return; }
    // Callbacks only enqueue work. All GL operations use this context on the
    // main thread; rendering never calls blocking mpv commands/properties.
    mpv_render_context_set_update_callback(_renderer, scheduleRender, (__bridge void *)self);
    mpv_set_wakeup_callback(_mpv, scheduleEvents, (__bridge void *)self);
    mpv_request_log_messages(_mpv, "warn");
    mpv_observe_property(_mpv, 1, "time-pos", MPV_FORMAT_DOUBLE);
    mpv_observe_property(_mpv, 2, "duration", MPV_FORMAT_DOUBLE);
    char *version = mpv_get_property_string(_mpv, "mpv-version");
    printf("GPU_RENDERER=%s\nLIBMPV=%s\n", glGetString(GL_RENDERER), version ? version : "unknown");
    mpv_free(version);
    [self updateGlass];
    if (self.media) [self command:@[@"loadfile", self.media]];
}
- (void)command:(NSArray<NSString *> *)arguments {
    if (!_mpv || _disposed) return;
    const char **argv = calloc(arguments.count + 1, sizeof(char *));
    for (NSUInteger i = 0; i < arguments.count; i++) argv[i] = arguments[i].UTF8String;
    int result = mpv_command_async(_mpv, 0, argv);
    free(argv); // mpv_command_async copies arguments before returning.
    if (result < 0 && self.status) self.status(@"播放命令失败");
}
- (NSSize)pixelSize {
    NSRect pixels = [self convertRectToBacking:self.bounds];
    return NSMakeSize(MAX(1, round(pixels.size.width)), MAX(1, round(pixels.size.height)));
}
- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    if (!_renderer || _disposed) return;
    [[self openGLContext] makeCurrentContext];
    NSSize size = [self pixelSize];
    mpv_opengl_fbo target = {.fbo = 0, .w = (int)size.width, .h = (int)size.height};
    int flip = 1, block = 0;
    mpv_render_param parameters[] = {
        {MPV_RENDER_PARAM_OPENGL_FBO, &target}, {MPV_RENDER_PARAM_FLIP_Y, &flip},
        {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &block}, {MPV_RENDER_PARAM_INVALID, NULL}
    };
    mpv_render_context_update(_renderer);
    int result = mpv_render_context_render(_renderer, parameters);
    if (result < 0) { self.failed(@"GPU frame render failed"); return; }
    [[self openGLContext] flushBuffer];
    mpv_render_context_report_swap(_renderer);
    _renderedFrames++;
}
- (void)reshape {
    [super reshape];
    if (_renderer && !_disposed) {
        // Wait until live resize settles before rebuilding the static shader.
        [NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(updateGlass) object:nil];
        [self performSelector:@selector(updateGlass) withObject:nil afterDelay:0.12];
        [self setNeedsDisplay:YES];
    }
}
- (void)setGlassEnabled:(BOOL)enabled {
    _glass = enabled;
    [self updateGlass];
}
- (void)updateGlass {
    if (!_renderer || _disposed) return;
    if (!_glass) { [self command:@[@"set", @"glsl-shaders", @""]]; return; }
    NSError *error = nil;
    NSString *original = [NSString stringWithContentsOfFile:self.sourceShader encoding:NSUTF8StringEncoding error:&error];
    NSRange firstHook = [original rangeOfString:@"//!HOOK OUTPUT"];
    if (!original || firstHook.location == NSNotFound) { self.failed(@"Cannot read repository glass shader"); return; }
    NSSize size = [self pixelSize];
    double scale = size.width / MAX(1, self.bounds.size.width);
    double vw = size.width, vh = vw / _aspect;
    if (vh > size.height) { vh = size.height; vw = vh * _aspect; }
    double vx = (size.width - vw) / 2, vy = (size.height - vh) / 2;
    // Adapt the existing OUTPUT passes to the stable libmpv OpenGL backend.
    // gpu-next DYNAMIC parameters are replaced with constants only when the
    // geometry/visibility changes. Original source is read-only.
    NSMutableString *defines = [NSMutableString stringWithFormat:
        @"#define displacement_scale 70.0\n#define blur_px 6.0\n#define saturation 1.4\n#define aberration_intensity 2.0\n#define surface_count 1.0\n"
        "#define video_x %.4f\n#define video_y %.4f\n#define video_w %.4f\n#define video_h %.4f\n#define ui_scale %.4f\n",
        vx, vy, vw, vh, scale];
    for (int i = 1; i <= 6; i++) {
        double x = i == 1 ? 24 * scale : 0, y = i == 1 ? size.height - 96 * scale : 0;
        double w = i == 1 ? MAX(1, size.width - 48 * scale) : 0, h = i == 1 ? 72 * scale : 0;
        [defines appendFormat:@"#define r%d_x %.4f\n#define r%d_y %.4f\n#define r%d_w %.4f\n#define r%d_h %.4f\n#define r%d_radius %.4f\n", i,x,i,y,i,w,i,h,i,18*scale];
    }
    NSMutableString *shader = [NSMutableString string];
    for (NSString *line in [[original substringFromIndex:firstHook.location] componentsSeparatedByString:@"\n"]) {
        if ([line hasPrefix:@"//!WHEN"]) continue;
        [shader appendFormat:@"%@\n", line];
        if ([line hasPrefix:@"//!DESC"]) [shader appendString:defines];
    }
    if (![shader writeToFile:self.generatedShader atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
        self.failed(@"Cannot write temporary glass shader"); return;
    }
    // Empty first so mpv reloads a shader with the same filename on resize.
    [self command:@[@"set", @"glsl-shaders", @""]];
    [self command:@[@"change-list", @"glsl-shaders", @"append", self.generatedShader]];
}
- (void)drainEvents {
    if (!_mpv || _disposed) return;
    for (;;) {
        mpv_event *event = mpv_wait_event(_mpv, 0);
        if (event->event_id == MPV_EVENT_NONE) break;
        if (event->event_id == MPV_EVENT_LOG_MESSAGE) {
            mpv_event_log_message *message = event->data;
            // Never echo mpv log text: user media URLs may contain credentials.
            if ((strstr(message->prefix, "gpu") || strstr(message->prefix, "libmpv")) && message->log_level >= MPV_LOG_LEVEL_FATAL && message->log_level <= MPV_LOG_LEVEL_ERROR) _shaderErrors++;
        }
        if (event->event_id == MPV_EVENT_PROPERTY_CHANGE) {
            mpv_event_property *property = event->data;
            if (property->format == MPV_FORMAT_DOUBLE && property->data) {
                double value = *(double *)property->data;
                if (strcmp(property->name, "time-pos") == 0) _position = value;
                if (strcmp(property->name, "duration") == 0) _duration = value;
                if (self.progress && _duration > 0) self.progress(MAX(0,MIN(100,_position/_duration*100)));
            }
        }
        if (event->event_id == MPV_EVENT_COMMAND_REPLY && event->error < 0) {
            if (self.status) self.status(@"命令未被播放器接受");
        }
        if (event->event_id == MPV_EVENT_VIDEO_RECONFIG || event->event_id == MPV_EVENT_FILE_LOADED) {
            int64_t width = 0, height = 0;
            if (mpv_get_property(_mpv, "video-out-params/dw", MPV_FORMAT_INT64, &width) >= 0 &&
                mpv_get_property(_mpv, "video-out-params/dh", MPV_FORMAT_INT64, &height) >= 0 && width > 0 && height > 0) _aspect = (double)width / height;
            [self updateGlass];
        }
        if (event->event_id == MPV_EVENT_FILE_LOADED) {
            if (self.status) self.status(@"OpenGL GPU 渲染 · SDR 原型");
            if (self.loaded) self.loaded();
        }
        if (event->event_id == MPV_EVENT_END_FILE) {
            mpv_event_end_file *end = event->data;
            if (end->reason == MPV_END_FILE_REASON_ERROR) self.failed(@"媒体加载失败（未记录媒体路径）");
        }
    }
}
- (void)keyDown:(NSEvent *)event {
    NSString *key = event.charactersIgnoringModifiers.lowercaseString;
    if ([key isEqualToString:@" "]) [self command:@[@"cycle", @"pause"]];
    else if ([key isEqualToString:@"g"]) [self setGlassEnabled:!_glass];
    else if ([key isEqualToString:@"f"]) [self.window toggleFullScreen:nil];
    else if (event.keyCode == 123) [self command:@[@"seek", @"-5", @"relative"]];
    else if (event.keyCode == 124) [self command:@[@"seek", @"5", @"relative"]];
    else [super keyDown:event];
}
- (NSData *)capturePixels {
    // Only invoked by the synthetic regression, never for playback effects.
    [[self openGLContext] makeCurrentContext];
    NSSize size = [self pixelSize];
    NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)size.width * (NSUInteger)size.height * 4];
    glReadBuffer(GL_FRONT);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(0, 0, (GLsizei)size.width, (GLsizei)size.height, GL_RGBA, GL_UNSIGNED_BYTE, data.mutableBytes);
    return data;
}
- (void)shutdown {
    if (_disposed) return;
    _disposed = YES;
    [NSObject cancelPreviousPerformRequestsWithTarget:self];
    if (_mpv) mpv_set_wakeup_callback(_mpv, NULL, NULL);
    if (_renderer) {
        mpv_render_context_set_update_callback(_renderer, NULL, NULL);
        [[self openGLContext] makeCurrentContext];
        mpv_render_context_free(_renderer);
        _renderer = NULL;
    }
    if (_mpv) { mpv_terminate_destroy(_mpv); _mpv = NULL; }
    [[NSFileManager defaultManager] removeItemAtPath:self.generatedShader error:NULL];
}
- (void)viewDidChangeBackingProperties {
    [super viewDidChangeBackingProperties];
    [self reshape];
}
@end

@interface AppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(strong) NSWindow *window;
@property(strong) VideoView *video;
@property(strong) NSTextField *label;
@property(strong) NSSlider *seekSlider;
@property(copy) NSString *root;
@property(copy) NSString *media;
@property(copy) NSString *testOutput;
@property(copy) NSString *temporaryDirectory;
@property BOOL testing;
@property BOOL testStarted;
@property int result;
@property NSUInteger testPhase;
@end

static void later(double seconds, dispatch_block_t block) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), block);
}
static void savePNG(NSData *data, NSSize size, NSString *path) {
    NSInteger w = (NSInteger)size.width, h = (NSInteger)size.height;
    NSBitmapImageRep *image = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:w pixelsHigh:h bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:w*4 bitsPerPixel:32];
    for (NSInteger y = 0; y < h; y++) memcpy(image.bitmapData + y*w*4, (const char *)data.bytes + (h-y-1)*w*4, w*4);
    [[image representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];
}
@implementation AppDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    self.result = 0;
    self.temporaryDirectory = [NSTemporaryDirectory() stringByAppendingPathComponent:[@"mjc-libmpv-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    if (![[NSFileManager defaultManager] createDirectoryAtPath:self.temporaryDirectory withIntermediateDirectories:NO attributes:nil error:NULL]) { self.result = 1; [NSApp terminate:nil]; return; }
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,960,600) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"MyJellyfinClient · macOS libmpv GPU Prototype";
    self.window.minSize = NSMakeSize(640,400);
    self.window.delegate = self;
    NSView *content = self.window.contentView;
    self.video = [[VideoView alloc] initWithFrame:NSMakeRect(0,0,960,556)];
    self.video.autoresizingMask = NSViewWidthSizable|NSViewHeightSizable;
    self.video.sourceShader = [self.root stringByAppendingPathComponent:@"src-tauri/resources/mpv/portable_config/shaders/mjc-glass.glsl"];
    self.video.generatedShader = [self.temporaryDirectory stringByAppendingPathComponent:@"glass.glsl"];
    self.video.media = self.media;
    __weak AppDelegate *weakSelf = self;
    self.video.failed = ^(NSString *reason) {
        AppDelegate *owner = weakSelf;
        owner.label.stringValue = reason;
        fprintf(stderr, "%s\n", reason.UTF8String);
        owner.result = 1;
        if (owner.testing) [NSApp terminate:nil];
    };
    self.video.status = ^(NSString *status) { weakSelf.label.stringValue = status; };
    self.video.progress = ^(double percent) { weakSelf.seekSlider.doubleValue = percent; };
    self.video.loaded = ^{ if (weakSelf.testing && !weakSelf.testStarted) { weakSelf.testStarted = YES; [weakSelf runTest]; } };
    [content addSubview:self.video];
    NSButton *open = [NSButton buttonWithTitle:@"打开视频" target:self action:@selector(openMedia:)];
    open.frame = NSMakeRect(14,563,100,28); open.autoresizingMask = NSViewMinYMargin;
    [content addSubview:open];
    self.label = [NSTextField labelWithString:@"OpenGL 嵌入原型 · 空格暂停 · G 玻璃开关 · F 全屏"];
    self.label.frame = NSMakeRect(126,567,810,24); self.label.autoresizingMask = NSViewWidthSizable|NSViewMinYMargin;
    [content addSubview:self.label];
    NSButton *pause = [NSButton buttonWithTitle:@"播放 / 暂停" target:self action:@selector(pause:)];
    pause.frame = NSMakeRect(48,44,120,28);
    pause.bordered = NO; pause.contentTintColor = NSColor.whiteColor;
    pause.image = [NSImage imageWithSystemSymbolName:@"playpause.fill" accessibilityDescription:@"播放或暂停"];
    pause.imagePosition = NSImageLeft;
    [content addSubview:pause];
    NSButton *glass = [NSButton buttonWithTitle:@"玻璃开关（G）" target:self action:@selector(glass:)];
    glass.frame = NSMakeRect(180,44,140,28);
    glass.bordered = NO; glass.contentTintColor = NSColor.whiteColor;
    [content addSubview:glass];
    NSTextField *caption = [NSTextField labelWithString:@"GPU 模糊 · 圆角折射 · RGB 色散"];
    caption.textColor = NSColor.whiteColor; caption.frame = NSMakeRect(350,48,500,24);
    [content addSubview:caption];
    NSSlider *seek = [NSSlider sliderWithValue:0 minValue:0 maxValue:100 target:self action:@selector(seek:)];
    self.seekSlider = seek;
    seek.frame = NSMakeRect(48,28,864,16); seek.autoresizingMask = NSViewWidthSizable;
    seek.accessibilityLabel = @"播放位置";
    [content addSubview:seek];
    [self.window center]; [self.window makeKeyAndOrderFront:nil];
    [self.window makeFirstResponder:self.video];
    [NSApp activateIgnoringOtherApps:YES];
    if (self.testing) later(20, ^{ if (weakSelf.video && !weakSelf.video->_disposed) { fprintf(stderr,"Self-test timed out\n"); weakSelf.result=1; [NSApp terminate:nil]; } });
}
- (void)openMedia:(id)sender {
    (void)sender;
    NSOpenPanel *panel = NSOpenPanel.openPanel;
    panel.canChooseDirectories = NO;
    if ([panel runModal] == NSModalResponseOK) [self.video command:@[@"loadfile", panel.URL.path]];
}
- (void)pause:(id)sender { (void)sender; [self.video command:@[@"cycle", @"pause"]]; }
- (void)glass:(id)sender { (void)sender; [self.video setGlassEnabled:!self.video->_glass]; }
- (void)seek:(NSSlider *)sender { [self.video command:@[@"seek", [NSString stringWithFormat:@"%.3f",sender.doubleValue], @"absolute-percent+exact"]]; }
- (void)runTest {
    [self.video command:@[@"set", @"pause", @"yes"]];
    [self.video command:@[@"seek", @"1", @"absolute+exact"]];
    [self.video setGlassEnabled:NO];
    later(1, ^{
        NSData *plain = [self.video capturePixels];
        NSSize size = [self.video pixelSize];
        savePNG(plain, size, [self.testOutput stringByAppendingPathComponent:[NSString stringWithFormat:@"plain-%lu.png", (unsigned long)self.testPhase]]);
        [self.video setGlassEnabled:YES];
        later(1, ^{
            NSData *glass = [self.video capturePixels];
            savePNG(glass, size, [self.testOutput stringByAppendingPathComponent:[NSString stringWithFormat:@"glass-%lu.png", (unsigned long)self.testPhase]]);
            const unsigned char *a = plain.bytes, *b = glass.bytes;
            double inside = 0, outside = 0; NSUInteger ni=0,no=0;
            NSInteger w=(NSInteger)size.width,h=(NSInteger)size.height;
            double scale=size.width/self.video.bounds.size.width;
            for (NSInteger y=0;y<h;y++) for (NSInteger x=0;x<w;x++) {
                BOOL in = x>36*scale && x<w-36*scale && y>36*scale && y<84*scale;
                BOOL out = y>140*scale && y<h-30*scale;
                if (!in && !out) continue;
                for (int c=0;c<3;c++) { double d=abs(a[(y*w+x)*4+c]-b[(y*w+x)*4+c]); if(in){inside+=d;ni++;} else {outside+=d;no++;} }
            }
            inside/=MAX(1,ni); outside/=MAX(1,no);
            BOOL passed=inside>2 && outside<1 && self.video->_renderedFrames>2 && self.video->_shaderErrors==0;
            char *hwdec=mpv_get_property_string(self.video->_mpv,"hwdec-current");
            NSString *decoder=hwdec?[NSString stringWithUTF8String:hwdec]:@"unknown";
            mpv_free(hwdec);
            NSDictionary *report=@{@"passed":@(passed),@"insideMeanDifference":@(inside),@"outsideMeanDifference":@(outside),@"frames":@(self.video->_renderedFrames),@"gpuErrors":@(self.video->_shaderErrors),@"backend":@"libmpv OpenGL (not gpu-next)",@"hwdec":decoder,@"hdr":@"not validated; SDR target"};
            NSData *json=[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:NULL];
            [json writeToFile:[self.testOutput stringByAppendingPathComponent:[NSString stringWithFormat:@"result-%lu.json", (unsigned long)self.testPhase]] atomically:YES];
            printf("%s\n", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
            if (!passed) { self.result=1; [NSApp terminate:nil]; return; }
            if (self.testPhase == 0) {
                self.testPhase=1;
                [self.window setContentSize:NSMakeSize(720,450)];
                later(0.6, ^{ [self runTest]; });
            } else {
                [NSApp terminate:nil];
            }
        });
    });
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { (void)sender; return YES; }
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    (void)sender;
    [self.video shutdown];
    [[NSFileManager defaultManager] removeItemAtPath:self.temporaryDirectory error:NULL];
    if (self.testing) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [NSApp stop:nil];
            [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0] atStart:NO];
        });
        return NSTerminateCancel;
    }
    return NSTerminateNow;
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        AppDelegate *delegate=[AppDelegate new];
        delegate.root=argc>1 ? [NSString stringWithUTF8String:argv[1]] : [NSBundle.mainBundle objectForInfoDictionaryKey:@"MJCProjectRoot"];
        if (!delegate.root) { fprintf(stderr,"Usage: prototype PROJECT_ROOT [MEDIA] [--self-test OUTPUT_DIR]\n"); return 2; }
        if(argc>2) delegate.media=[NSString stringWithUTF8String:argv[2]];
        if(argc==5 && strcmp(argv[3],"--self-test")==0) { delegate.testing=YES; delegate.testOutput=[NSString stringWithUTF8String:argv[4]]; }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSApp.delegate=delegate;
        [NSApp run];
        return delegate.result;
    }
}
