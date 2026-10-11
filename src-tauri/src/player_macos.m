// libmpv/CGL view hosted above WKWebView. All AppKit and render operations
// belong to the main thread; callbacks enqueue work and never call mpv inline.
#import <Cocoa/Cocoa.h>
#import <OpenGL/gl3.h>
#import <Security/Security.h>
#import <mpv/client.h>
#import <mpv/render_gl.h>
#include <dlfcn.h>
#include <stdatomic.h>

typedef bool (*MJCEventCallback)(void *, const char *, const char *);
@interface MJCPlaybackView : NSOpenGLView {
@public
    mpv_handle *_mpv;
    mpv_render_context *_renderer;
    BOOL _disposed;
    BOOL _ready;
    BOOL _paused;
    double _position;
    double _duration;
    void *_context;
    MJCEventCallback _callback;
    atomic_bool _renderScheduled;
    atomic_bool _eventsScheduled;
}
@property(copy) NSDictionary *options;
@property(copy) NSString *scriptPath;
@property(copy) NSString *shaderPath;
@property(copy) NSString *temporaryDirectory;
@property(copy) NSString *generatedShader;
@property(copy) NSDictionary *glassValues;
@property(copy) NSArray *cursorZones;
@property(strong) NSTrackingArea *tracking;
@property BOOL capturePending;
@property(copy) NSString *capturePath;
@property BOOL copyCapture;
@property BOOL draggingWindow;
- (BOOL)emit:(NSString *)name payload:(id)payload;
- (void)command:(NSArray<NSString *> *)arguments;
- (void)drainEvents;
- (void)refreshShader;
- (void)pointer:(NSString *)type event:(NSEvent *)event;
- (void)shutdown;
@end

static void *glProc(void *ctx, const char *name) { (void)ctx; return dlsym(RTLD_DEFAULT, name); }
static void renderUpdate(void *ctx) {
    MJCPlaybackView *view = (__bridge MJCPlaybackView *)ctx;
    if(atomic_exchange(&view->_renderScheduled,true)) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        atomic_store(&view->_renderScheduled,false);
        if (!view->_disposed) [view setNeedsDisplay:YES];
    });
}
static void eventUpdate(void *ctx) {
    MJCPlaybackView *view = (__bridge MJCPlaybackView *)ctx;
    if(atomic_exchange(&view->_eventsScheduled,true)) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        atomic_store(&view->_eventsScheduled,false);
        if (!view->_disposed) [view drainEvents];
    });
}
static NSString *keyName(NSEvent *event) {
    switch(event.keyCode) {
        case 123: return @"LEFT"; case 124: return @"RIGHT"; case 125: return @"DOWN"; case 126: return @"UP";
        case 49: return @"SPACE"; case 36: return @"ENTER"; case 53: return @"ESC"; case 51: return @"BS";
    }
    NSString *key = event.charactersIgnoringModifiers.uppercaseString;
    return key.length == 1 && [@"FMAS0123456789" containsString:key] ? key : nil;
}

@implementation MJCPlaybackView
- (instancetype)initWithFrame:(NSRect)frame {
    NSOpenGLPixelFormatAttribute attrs[] = {NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
        NSOpenGLPFADoubleBuffer, NSOpenGLPFAAccelerated, NSOpenGLPFAColorSize,24, NSOpenGLPFAAlphaSize,8,0};
    self = [super initWithFrame:frame pixelFormat:[[NSOpenGLPixelFormat alloc] initWithAttributes:attrs]];
    if (self) {
        atomic_init(&_renderScheduled,false); atomic_init(&_eventsScheduled,false);
        self.wantsBestResolutionOpenGLSurface=YES; self.wantsLayer=YES;
    }
    return self;
}
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)initializePlayer {
    [[self openGLContext] makeCurrentContext];
    if (!CGLGetCurrentContext()) { [self emit:@"error" payload:@"无法创建 CGL 上下文"]; return NO; }
    GLint interval=1;
    [[self openGLContext] setValues:&interval forParameter:NSOpenGLContextParameterSwapInterval];
    _mpv=mpv_create();
    if (!_mpv) { [self emit:@"error" payload:@"无法创建 libmpv 实例"]; return NO; }
    NSDictionary *settings = self.options[@"settings"];
    // Homebrew FFmpeg uses OpenSSL and its compiled CA path is outside the
    // application. Export Apple's default public root anchors read-only so a
    // copied bundle still validates HTTPS without Homebrew or disabled TLS.
    CFArrayRef anchors=NULL;
    if(SecTrustCopyAnchorCertificates(&anchors)!=errSecSuccess || !anchors) {
        [self emit:@"error" payload:@"无法读取 macOS 系统根证书"]; return NO;
    }
    NSMutableString *pem=[NSMutableString string];
    for(id object in (__bridge NSArray *)anchors) {
        SecCertificateRef certificate=(__bridge SecCertificateRef)object;
        NSData *der=CFBridgingRelease(SecCertificateCopyData(certificate));
        if(!der) continue;
        NSString *base64=[der base64EncodedStringWithOptions:NSDataBase64Encoding64CharacterLineLength|NSDataBase64EncodingEndLineWithLineFeed];
        [pem appendFormat:@"-----BEGIN CERTIFICATE-----\n%@\n-----END CERTIFICATE-----\n",base64];
    }
    CFRelease(anchors);
    NSString *caPath=[self.temporaryDirectory stringByAppendingPathComponent:@"system-roots.pem"];
    if(!pem.length || ![pem writeToFile:caPath atomically:YES encoding:NSUTF8StringEncoding error:NULL]) {
        [self emit:@"error" payload:@"无法准备播放器 HTTPS 根证书"]; return NO;
    }
    NSUInteger cache=[settings[@"playerCacheSizeMB"] unsignedIntegerValue];
    if(cache<1 || cache>8192) cache=150;
    NSMutableDictionary *opts=[@{@"config":@"no", @"load-scripts":@"no", @"vo":@"libmpv", @"osc":@"no",
        @"terminal":@"no", @"idle":@"yes", @"keep-open":@"yes", @"tls-verify":@"yes", @"tls-ca-file":caPath, @"osd-level":@"1",
        @"target-trc":@"srgb", @"target-prim":@"bt.709", @"sub-font":@"PingFang SC",
        @"hwdec":[self.options[@"hw_decode"] boolValue]?@"auto-safe":@"no",
        @"volume-max":[self.options[@"audio_boost"] boolValue]?@"200":@"100",
        @"hr-seek":[self.options[@"precise_seek"] boolValue]?@"yes":@"no",
        @"start":[self.options[@"start_seconds"] description],
        @"force-media-title":self.options[@"title"] ?: @"播放器",
        @"demuxer-max-bytes":[@(cache*1000000ULL) description],
        @"script-opts":@"mjc-glass-bridge=yes,mjc-font=PingFang SC",
        @"screenshot-format":[settings[@"screenshotFormat"] isEqual:@"jpeg"]?@"jpg":@"png",
        @"screenshot-jpeg-quality":[@(MAX(1,MIN(100,[settings[@"jpegQuality"] intValue]))) description]} mutableCopy];
    if ([self.options[@"alang"] isKindOfClass:NSString.class]) opts[@"alang"]=self.options[@"alang"];
    if ([self.options[@"slang"] isKindOfClass:NSString.class]) opts[@"slang"]=self.options[@"slang"];
    for (NSString *name in opts) {
        int result=mpv_set_option_string(_mpv,name.UTF8String,[opts[name] UTF8String]);
        if (result<0) { [self emit:@"error" payload:[NSString stringWithFormat:@"播放器选项 %@：%s",name,mpv_error_string(result)]]; return NO; }
    }
    // --script is a command-line alias. libmpv takes the actual scripts list.
    mpv_node scriptEntry={.format=MPV_FORMAT_STRING,.u.string=(char *)self.scriptPath.UTF8String};
    mpv_node_list scriptList={.num=1,.values=&scriptEntry};
    mpv_node scripts={.format=MPV_FORMAT_NODE_ARRAY,.u.list=&scriptList};
    if(mpv_set_option(_mpv,"scripts",MPV_FORMAT_NODE,&scripts)<0) return NO;
    NSDictionary *headers=self.options[@"http_headers"];
    if([headers isKindOfClass:NSDictionary.class]) {
        NSMutableArray *values=[NSMutableArray array];
        NSCharacterSet *invalidName=[[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"] invertedSet];
        for(NSString *name in headers) {
            NSString *value=headers[name];
            if(![name isKindOfClass:NSString.class] || ![value isKindOfClass:NSString.class] ||
               [name rangeOfCharacterFromSet:invalidName].location!=NSNotFound ||
               [value rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet].location!=NSNotFound) return NO;
            // MPV_FORMAT_NODE preserves header commas without option-list escaping.
            [values addObject:[NSString stringWithFormat:@"%@: %@",name,value]];
        }
        mpv_node *entries=calloc(values.count,sizeof(mpv_node));
        for(NSUInteger i=0;i<values.count;i++) { entries[i].format=MPV_FORMAT_STRING; entries[i].u.string=(char *)[values[i] UTF8String]; }
        mpv_node_list list={.num=(int)values.count,.values=entries};
        mpv_node node={.format=MPV_FORMAT_NODE_ARRAY,.u.list=&list};
        int result=mpv_set_option(_mpv,"http-header-fields",MPV_FORMAT_NODE,&node);
        free(entries); if(result<0) return NO;
    }
    int initializeResult=mpv_initialize(_mpv);
    if(initializeResult<0) { [self emit:@"error" payload:[NSString stringWithFormat:@"libmpv 初始化：%s",mpv_error_string(initializeResult)]]; return NO; }
    // Query before creating the advanced render context. After that point only
    // asynchronous commands and nonblocking events may run on the GL/UI thread.
    char *version=mpv_get_property_string(_mpv,"mpv-version");
    mpv_opengl_init_params gl={.get_proc_address=glProc};
    int advanced=1;
    mpv_render_param params[]={{MPV_RENDER_PARAM_API_TYPE,MPV_RENDER_API_TYPE_OPENGL},
        {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,&gl},{MPV_RENDER_PARAM_ADVANCED_CONTROL,&advanced},{MPV_RENDER_PARAM_INVALID,NULL}};
    int renderResult=mpv_render_context_create(&_renderer,_mpv,params);
    if(renderResult<0) { mpv_free(version); [self emit:@"error" payload:[NSString stringWithFormat:@"OpenGL render API：%s",mpv_error_string(renderResult)]]; return NO; }
    mpv_render_context_set_update_callback(_renderer,renderUpdate,(__bridge void *)self);
    mpv_set_wakeup_callback(_mpv,eventUpdate,(__bridge void *)self);
    mpv_observe_property(_mpv,1,"time-pos",MPV_FORMAT_DOUBLE);
    mpv_observe_property(_mpv,2,"duration",MPV_FORMAT_DOUBLE);
    mpv_observe_property(_mpv,3,"pause",MPV_FORMAT_FLAG);
    mpv_observe_property(_mpv,4,"video-out-params",MPV_FORMAT_NODE);
    mpv_request_log_messages(_mpv,"warn");
    [self emit:@"version" payload:@{@"version":version?[NSString stringWithUTF8String:version]:@"unknown",
        @"renderer":[NSString stringWithUTF8String:(const char *)glGetString(GL_RENDERER)],@"backend":@"libmpv-opengl",@"output":@"sdr"}];
    mpv_free(version);
    [self command:@[@"loadfile", self.options[@"url"]]];
    return YES;
}
- (BOOL)emit:(NSString *)name payload:(id)payload {
    if(!_callback || _disposed) return NO;
    NSData *data=[NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingFragmentsAllowed error:NULL];
    if(!data) return NO;
    NSString *json=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return _callback(_context,name.UTF8String,json.UTF8String);
}
- (void)command:(NSArray<NSString *> *)args {
    if(!_mpv || _disposed) return;
    const char **argv=calloc(args.count+1,sizeof(char *));
    for(NSUInteger i=0;i<args.count;i++) argv[i]=args[i].UTF8String;
    int result=mpv_command_async(_mpv,0,argv);
    free(argv);
    if(result<0) [self emit:@"command-error" payload:@{@"error":@(result)}];
}
- (void)drawRect:(NSRect)rect {
    (void)rect;
    if(!_renderer || _disposed) return;
    [[self openGLContext] makeCurrentContext];
    NSSize size=[self convertRectToBacking:self.bounds].size;
    if(size.width<1 || size.height<1) return;
    mpv_opengl_fbo target={.fbo=0,.w=(int)size.width,.h=(int)size.height};
    int flip=1,block=0;
    mpv_render_param params[]={{MPV_RENDER_PARAM_OPENGL_FBO,&target},{MPV_RENDER_PARAM_FLIP_Y,&flip},
        {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME,&block},{MPV_RENDER_PARAM_INVALID,NULL}};
    mpv_render_context_update(_renderer);
    if(mpv_render_context_render(_renderer,params)<0) { [self emit:@"error" payload:@"GPU 画面渲染失败"]; return; }
    [[self openGLContext] flushBuffer];
    mpv_render_context_report_swap(_renderer);
}
- (void)reshape {
    [super reshape];
    if(_mpv && !_disposed) {
        [self command:@[@"script-message",@"mjc-ui-scale",[@(self.window.backingScaleFactor) description]]];
        [self setNeedsDisplay:YES];
    }
}
- (void)viewDidChangeBackingProperties { [super viewDidChangeBackingProperties]; [self reshape]; }
- (void)refreshShader {
    if(!_renderer || _disposed || self.capturePending) return;
    if([self.glassValues[@"surface_count"] intValue]==0) { [self command:@[@"set",@"glsl-shaders",@""]]; return; }
    NSString *original=[NSString stringWithContentsOfFile:self.shaderPath encoding:NSUTF8StringEncoding error:NULL];
    NSRange start=[original rangeOfString:@"//!HOOK OUTPUT"];
    if(!original || start.location==NSNotFound) { [self emit:@"error" payload:@"玻璃 shader 资源缺失"]; return; }
    NSMutableString *defines=[NSMutableString string];
    // Accept only fixed geometry/material keys and finite numbers from our OSC.
    NSMutableArray *keys=[@[@"displacement_scale",@"blur_px",@"saturation",@"aberration_intensity",@"surface_count",
        @"video_x",@"video_y",@"video_w",@"video_h",@"ui_scale"] mutableCopy];
    for(int i=1;i<=6;i++) for(NSString *field in @[@"x",@"y",@"w",@"h",@"radius"]) [keys addObject:[NSString stringWithFormat:@"r%d_%@",i,field]];
    for(NSString *key in keys) {
        id number=self.glassValues[key];
        if(![number isKindOfClass:NSNumber.class] || !isfinite([number doubleValue])) return;
        [defines appendFormat:@"#define %@ %.6f\n",key,[number doubleValue]];
    }
    NSMutableString *shader=[NSMutableString string];
    for(NSString *line in [[original substringFromIndex:start.location] componentsSeparatedByString:@"\n"]) {
        if([line hasPrefix:@"//!WHEN"]) continue;
        [shader appendFormat:@"%@\n",line];
        if([line hasPrefix:@"//!DESC"]) [shader appendString:defines];
    }
    if(![shader writeToFile:self.generatedShader atomically:YES encoding:NSUTF8StringEncoding error:NULL]) {
        [self emit:@"error" payload:@"无法写入临时玻璃 shader"]; return;
    }
    [self command:@[@"set",@"glsl-shaders",@""]];
    [self command:@[@"change-list",@"glsl-shaders",@"append",self.generatedShader]];
}
- (void)configureOSC {
    NSMutableDictionary *settings=[self.options[@"settings"] mutableCopy] ?: [NSMutableDictionary dictionary];
    settings[@"uiScale"]=@(self.window.backingScaleFactor);
    settings[@"doubleClickMilliseconds"]=@(MAX(100,MIN(1500,NSEvent.doubleClickInterval*1000)));
    NSData *json=[NSJSONSerialization dataWithJSONObject:settings options:0 error:NULL];
    [self command:@[@"script-message",@"mjc-settings",[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]]];
    NSData *media=[NSJSONSerialization dataWithJSONObject:self.options[@"media_info"] ?: @{} options:0 error:NULL];
    [self command:@[@"script-message",@"mjc-media-details",[[NSString alloc] initWithData:media encoding:NSUTF8StringEncoding]]];
    [self command:@[@"script-message",@"mjc-seek-settings",[self.options[@"rewind_seconds"] description],
        [self.options[@"forward_seconds"] description],[self.options[@"precise_seek"] boolValue]?@"true":@"false"]];
    for(NSString *file in self.options[@"sub_files"]) [self command:@[@"sub-add",file,@"auto"]];
}
- (void)drainEvents {
    if(!_mpv || _disposed) return;
    for(;;) {
        mpv_event *event=mpv_wait_event(_mpv,0);
        if(event->event_id==MPV_EVENT_NONE) return;
        if(event->event_id==MPV_EVENT_FILE_LOADED) {
            // The Rust callback validates the session before any late file-loaded
            // event is allowed to reveal video over a page the user returned to.
            if(![self emit:@"ready" payload:@{}]) continue;
            _ready=YES;
            self.hidden=NO;
            [self.window makeFirstResponder:self];
            [self configureOSC];
        } else if(event->event_id==MPV_EVENT_PROPERTY_CHANGE) {
            mpv_event_property *prop=event->data;
            if(prop->data) {
                if(strcmp(prop->name,"video-out-params")==0 && prop->format==MPV_FORMAT_NODE) {
                    mpv_node *node=prop->data;
                    int64_t w=0,h=0;
                    if(node->format==MPV_FORMAT_NODE_MAP) for(int i=0;i<node->u.list->num;i++) {
                        mpv_node entry=node->u.list->values[i];
                        if(entry.format==MPV_FORMAT_INT64) {
                            if(strcmp(node->u.list->keys[i],"dw")==0) w=entry.u.int64;
                            if(strcmp(node->u.list->keys[i],"dh")==0) h=entry.u.int64;
                        }
                    }
                    if(w>0 && h>0) [self emit:@"video-ratio" payload:@{@"ratio":@((double)w/h)}];
                    continue;
                }
                if(strcmp(prop->name,"time-pos")==0 && prop->format==MPV_FORMAT_DOUBLE) _position=*(double *)prop->data;
                if(strcmp(prop->name,"duration")==0 && prop->format==MPV_FORMAT_DOUBLE) _duration=*(double *)prop->data;
                if(strcmp(prop->name,"pause")==0 && prop->format==MPV_FORMAT_FLAG) _paused=*(int *)prop->data!=0;
                [self emit:@"position" payload:@{@"position":@(_position),@"duration":@(_duration),@"paused":@(_paused),@"active":@YES}];
            }
        } else if(event->event_id==MPV_EVENT_CLIENT_MESSAGE) {
            mpv_event_client_message *message=event->data;
            NSMutableArray *args=[NSMutableArray array];
            for(int i=0;i<message->num_args;i++) [args addObject:[NSString stringWithUTF8String:message->args[i]] ?: @""];
            NSString *name=args.firstObject;
            if([name isEqual:@"mjc-glass-surfaces"] && args.count>1) {
                id values=[NSJSONSerialization JSONObjectWithData:[args[1] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
                if([values isKindOfClass:NSDictionary.class] && ![self.glassValues isEqual:values]) { self.glassValues=values; [self refreshShader]; }
            } else if([name isEqual:@"mjc-cursor-zones"] && args.count>1) {
                id values=[NSJSONSerialization JSONObjectWithData:[args[1] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
                if([values isKindOfClass:NSArray.class]) self.cursorZones=values;
            } else {
                [self emit:@"message" payload:args];
            }
        } else if(event->event_id==MPV_EVENT_LOG_MESSAGE) {
            mpv_event_log_message *message=event->data;
            // Full text/URLs never cross the FFI; diagnostics receive only a
            // severity/prefix, preventing credentials or stream URLs leaking.
            [self emit:@"log" payload:@{@"level":@(message->log_level),@"prefix":[NSString stringWithUTF8String:message->prefix]}];
        } else if(event->event_id==MPV_EVENT_END_FILE) {
            mpv_event_end_file *end=event->data;
            if(end->reason==MPV_END_FILE_REASON_ERROR) {
                self.hidden=YES;
                [self emit:@"error" payload:[NSString stringWithFormat:@"视频加载失败：%s",mpv_error_string(end->error)]];
            }
        } else if(event->event_id==MPV_EVENT_COMMAND_REPLY) {
            if(event->reply_userdata==100 && self.capturePending) {
                BOOL success=event->error>=0;
                if(success && self.copyCapture) {
                    NSImage *image=[[NSImage alloc] initWithContentsOfFile:self.capturePath];
                    if(image) { [NSPasteboard.generalPasteboard clearContents]; [NSPasteboard.generalPasteboard writeObjects:@[image]]; }
                }
                if(!success) [[NSFileManager defaultManager] removeItemAtPath:self.capturePath error:NULL];
                self.capturePending=NO;
                [self refreshShader];
                [self emit:@"capture-result" payload:@{@"success":@(success),@"error":@(event->error)}];
            } else if(event->error<0) [self emit:@"command-error" payload:@{@"error":@(event->error)}];
        }
    }
}
- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    if(self.tracking) [self removeTrackingArea:self.tracking];
    self.tracking=[[NSTrackingArea alloc] initWithRect:NSZeroRect options:NSTrackingMouseMoved|NSTrackingMouseEnteredAndExited|NSTrackingActiveInKeyWindow|NSTrackingInVisibleRect owner:self userInfo:nil];
    [self addTrackingArea:self.tracking];
}
- (void)pointer:(NSString *)type event:(NSEvent *)event {
    if(!_ready || _disposed) return;
    NSPoint p=[self convertPoint:event.locationInWindow fromView:nil];
    double scale=self.window.backingScaleFactor;
    double x=p.x*scale,y=(self.bounds.size.height-p.y)*scale;
    // mpv's mouse command takes integers; fractional Cocoa coordinates are
    // still retained for our Lua pointer bridge and hit testing.
    [self command:@[@"mouse",[@(llround(x)) description],[@(llround(y)) description]]];
    [self command:@[@"script-message",@"mjc-pointer",type,[@(x) description],[@(y) description]]];
    NSCursor *cursor=NSCursor.arrowCursor;
    for(NSDictionary *zone in self.cursorZones) {
        if(x>=[zone[@"x0"] doubleValue] && x<=[zone[@"x1"] doubleValue] && y>=[zone[@"y0"] doubleValue] && y<=[zone[@"y1"] doubleValue]) {
            cursor=[zone[@"cursor"] isEqual:@"text"]?NSCursor.IBeamCursor:NSCursor.pointingHandCursor; break;
        }
    }
    [cursor set];
}
- (void)mouseMoved:(NSEvent *)event { [self pointer:@"move" event:event]; }
- (void)mouseEntered:(NSEvent *)event { [self pointer:@"move" event:event]; }
- (void)mouseExited:(NSEvent *)event { (void)event; [NSCursor.arrowCursor set]; }
- (void)mouseDragged:(NSEvent *)event { [self pointer:@"move" event:event]; }
- (void)mouseDown:(NSEvent *)event {
    NSPoint point=[self convertPoint:event.locationInWindow fromView:nil];
    // The video continues behind the transparent native title bar. Its top
    // strip remains a window drag target rather than a playback gesture.
    if(!(self.window.styleMask&NSWindowStyleMaskFullScreen) && NSMaxY(self.bounds)-point.y<36) {
        self.draggingWindow=YES;
        [self.window performWindowDragWithEvent:event];
        return;
    }
    self.draggingWindow=NO;
    [self.window makeFirstResponder:self];
    [self pointer:event.clickCount==2?@"double":@"down" event:event];
}
- (void)mouseUp:(NSEvent *)event {
    if(self.draggingWindow) { self.draggingWindow=NO; return; }
    [self pointer:@"up" event:event];
}
- (void)rightMouseDown:(NSEvent *)event { [self pointer:@"move" event:event]; [self command:@[@"keydown",@"MBTN_RIGHT"]]; }
- (void)rightMouseUp:(NSEvent *)event { (void)event; [self command:@[@"keyup",@"MBTN_RIGHT"]]; }
- (void)scrollWheel:(NSEvent *)event {
    [self pointer:@"move" event:event];
    if(fabs(event.scrollingDeltaY)>0.01) [self command:@[@"keypress",event.scrollingDeltaY>0?@"WHEEL_UP":@"WHEEL_DOWN"]];
}
- (void)keyDown:(NSEvent *)event {
    if(event.modifierFlags&(NSEventModifierFlagCommand|NSEventModifierFlagControl|NSEventModifierFlagOption)) { [super keyDown:event]; return; }
    NSString *key=keyName(event);
    if(key && !event.isARepeat) [self command:@[@"script-message",@"mjc-key-down",key]];
    else if(!key && event.characters.length) [self command:@[@"script-message",@"mjc-text-input",event.characters]];
}
- (void)keyUp:(NSEvent *)event {
    NSString *key=keyName(event);
    if(key) [self command:@[@"script-message",@"mjc-key-up",key]]; else [super keyUp:event];
}
- (BOOL)resignFirstResponder { [self command:@[@"script-message",@"mjc-cancel-input"]]; return [super resignFirstResponder]; }
- (void)shutdown {
    if(_disposed) return;
    _disposed=YES; _callback=NULL; _context=NULL;
    if(_mpv) mpv_set_wakeup_callback(_mpv,NULL,NULL);
    if(_renderer) {
        mpv_render_context_set_update_callback(_renderer,NULL,NULL);
        [[self openGLContext] makeCurrentContext]; mpv_render_context_free(_renderer); _renderer=NULL;
    }
    if(_mpv) { mpv_terminate_destroy(_mpv); _mpv=NULL; }
    if(self.capturePending && self.capturePath) {
        NSDictionary *attributes=[[NSFileManager defaultManager] attributesOfItemAtPath:self.capturePath error:NULL];
        if([attributes[NSFileSize] unsignedLongLongValue]==0) [[NSFileManager defaultManager] removeItemAtPath:self.capturePath error:NULL];
    }
    [self removeFromSuperview];
    [[NSFileManager defaultManager] removeItemAtPath:self.temporaryDirectory error:NULL];
}
@end

// Rust retains the opaque view and context until destroy returns on the UI thread.
void *mjc_macos_create(void *parentPointer,const char *json,const char *script,const char *shader,void *context,MJCEventCallback callback) {
    NSCAssert(NSThread.isMainThread,@"Player must be created on main thread");
    NSView *parent=(__bridge NSView *)parentPointer;
    MJCPlaybackView *view=[[MJCPlaybackView alloc] initWithFrame:NSZeroRect];
    if(!view) return NULL;
    view.options=[NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
    view.scriptPath=[NSString stringWithUTF8String:script]; view.shaderPath=[NSString stringWithUTF8String:shader];
    view.temporaryDirectory=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"mjc-player-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    if(![[NSFileManager defaultManager] createDirectoryAtPath:view.temporaryDirectory withIntermediateDirectories:NO attributes:nil error:NULL]) return NULL;
    view.generatedShader=[view.temporaryDirectory stringByAppendingPathComponent:@"glass.glsl"];
    view->_context=context; view->_callback=callback;
    view.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
    view.frame=parent.bounds;
    view.hidden=YES;
    [parent addSubview:view positioned:NSWindowAbove relativeTo:nil];
    if(![view initializePlayer]) { [view shutdown]; return NULL; }
    return (__bridge_retained void *)view;
}
void mjc_macos_destroy(void *pointer) {
    MJCPlaybackView *view=(__bridge_transfer MJCPlaybackView *)pointer;
    [view shutdown];
}
void mjc_macos_command(void *pointer,const char *json) {
    MJCPlaybackView *view=(__bridge MJCPlaybackView *)pointer;
    id args=[NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
    if([args isKindOfClass:NSArray.class]) [view command:args];
}
void mjc_macos_layout(void *pointer,bool fullscreen,bool focus) {
    MJCPlaybackView *view=(__bridge MJCPlaybackView *)pointer;
    NSView *parent=view.superview;
    if(!parent || view->_disposed) return;
    (void)fullscreen;
    view.frame=parent.bounds;
    if(focus && view->_ready && view.window.isKeyWindow) [view.window makeFirstResponder:view];
    [view reshape];
}
void mjc_macos_capture(void *pointer,const char *path,bool copy) {
    MJCPlaybackView *view=(__bridge MJCPlaybackView *)pointer;
    if(view->_disposed || view.capturePending) return;
    view.capturePending=YES; view.capturePath=[NSString stringWithUTF8String:path]; view.copyCapture=copy;
    [view command:@[@"set",@"glsl-shaders",@""]];
    const char *args[]={"screenshot-to-file",path,"subtitles",NULL};
    if(mpv_command_async(view->_mpv,100,args)<0) { view.capturePending=NO; [view refreshShader]; [view emit:@"capture-result" payload:@{@"success":@NO}]; }
}
