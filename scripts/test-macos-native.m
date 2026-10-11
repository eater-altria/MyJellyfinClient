// Exercise the production Cocoa/libmpv bridge above a real WKWebView.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <OpenGL/gl3.h>
extern void *mjc_macos_create(void *,const char *,const char *,const char *,void *,bool(*)(void *,const char *,const char *));
extern void mjc_macos_destroy(void *);
extern void mjc_macos_command(void *,const char *);
extern void mjc_macos_layout(void *,bool,bool);
extern void mjc_macos_capture(void *,const char *,bool);
@interface NSOpenGLView (GlassTest)
- (void)refreshShader;
@end
@interface Regression : NSObject <NSApplicationDelegate>
@property(strong) NSWindow *window;
@property void *view;
@property(copy) NSString *root;
@property(copy) NSString *media;
@property(copy) NSString *output;
@property BOOL ready;
@property int result;
@property BOOL captureSucceeded;
@end
static void delay(double seconds,dispatch_block_t block) { dispatch_after(dispatch_time(DISPATCH_TIME_NOW,(int64_t)(seconds*NSEC_PER_SEC)),dispatch_get_main_queue(),block); }
static void command(Regression *test,NSArray *args) {
    NSData *data=[NSJSONSerialization dataWithJSONObject:args options:0 error:NULL];
    mjc_macos_command(test.view,[[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] UTF8String]);
}
static NSData *pixels(Regression *test) {
    NSOpenGLView *view=(__bridge NSOpenGLView *)test.view;
    [view display]; [[view openGLContext] makeCurrentContext];
    NSSize size=[view convertRectToBacking:view.bounds].size;
    NSMutableData *data=[NSMutableData dataWithLength:(NSUInteger)size.width*(NSUInteger)size.height*4];
    glReadBuffer(GL_FRONT); glPixelStorei(GL_PACK_ALIGNMENT,1);
    glReadPixels(0,0,(GLsizei)size.width,(GLsizei)size.height,GL_RGBA,GL_UNSIGNED_BYTE,data.mutableBytes);
    return data;
}
static bool received(void *ctx,const char *name,const char *payload) {
    Regression *test=(__bridge Regression *)ctx;
    if(strcmp(name,"error")==0) { fprintf(stderr,"FAIL native %s\n",payload);test.result=1;[NSApp terminate:nil]; }
    if(strcmp(name,"ready")==0) test.ready=YES;
    if(strcmp(name,"capture-result")==0) {
        NSDictionary *value=[NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:payload] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
        test.captureSucceeded=[value[@"success"] boolValue];
        printf("Capture: %s\n",payload);
    }
    return true;
}
@implementation Regression
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    self.window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,960,600) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    self.window.title=@"Synthetic macOS native regression";
    self.window.styleMask|=NSWindowStyleMaskFullSizeContentView;
    self.window.titlebarAppearsTransparent=YES;
    self.window.titleVisibility=NSWindowTitleHidden;
    WKWebView *web=[[WKWebView alloc] initWithFrame:self.window.contentView.bounds];
    web.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
    [web loadHTMLString:@"<html><body style='margin:0;background:#112233;color:white'>Synthetic title bar</body></html>" baseURL:nil];
    [self.window.contentView addSubview:web];
    [self.window center]; [self.window makeKeyAndOrderFront:nil];
    NSDictionary *options=@{@"url":self.media,@"title":@"Synthetic regression",@"start_seconds":@0,@"rewind_seconds":@15,@"forward_seconds":@15,
        @"hw_decode":@YES,@"audio_boost":@NO,@"precise_seek":@YES,@"sub_files":@[],@"media_info":@{},
        @"settings":@{@"autoHideControlsSeconds":@600,@"showPlayTitleToast":@NO,@"showScreenshotButton":@YES,@"jpegQuality":@90}};
    NSString *json=[[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:options options:0 error:NULL] encoding:NSUTF8StringEncoding];
    self.view=mjc_macos_create((__bridge void *)self.window.contentView,json.UTF8String,
        [self.root stringByAppendingPathComponent:@"src-tauri/resources/mpv/portable_config/scripts/mjc-osc.lua"].UTF8String,
        [self.root stringByAppendingPathComponent:@"src-tauri/resources/mpv/portable_config/shaders/mjc-glass.glsl"].UTF8String,
        (__bridge void *)self,received);
    if(!self.view) { fprintf(stderr,"FAIL native create returned null\n");self.result=1;[NSApp terminate:nil];return; }
    NSView *native=(__bridge NSView *)self.view;
    if(!NSEqualRects(native.frame,self.window.contentView.bounds)) {
        fprintf(stderr,"FAIL video must extend beneath transparent title bar\n");self.result=1;[NSApp terminate:nil];return;
    }
    delay(1, ^{ [self verify]; });
    delay(20, ^{ if(self.view) { fprintf(stderr,"FAIL timeout\n");self.result=1;[NSApp terminate:nil]; } });
}
- (void)verify {
    if(!self.ready) { delay(0.25,^{[self verify];});return; }
    command(self,@[@"set",@"pause",@"yes"]);
    command(self,@[@"seek",@"1",@"absolute+exact"]);
    command(self,@[@"script-message",@"mjc-pointer",@"move",@"100",@"530"]);
    delay(0.5,^{
        NSOpenGLView *view=(__bridge NSOpenGLView *)self.view;
        NSDictionary *glass=[view valueForKey:@"glassValues"];
        if([glass[@"surface_count"] intValue]<1) {fprintf(stderr,"FAIL no OSC glass geometry\n");self.result=1;[NSApp terminate:nil];return;}
        command(self,@[@"set",@"glsl-shaders",@""]);
        delay(0.3,^{
            NSData *plain=pixels(self);
            [view refreshShader];
            delay(0.5,^{
                NSData *frost=pixels(self);
                const unsigned char *a=plain.bytes,*b=frost.bytes;
                double change=0;for(NSUInteger i=0;i<plain.length;i++)change+=abs(a[i]-b[i]);
                change/=MAX(1,plain.length);
                if(change<0.2) {fprintf(stderr,"FAIL GPU glass pixels unchanged %.4f\n",change);self.result=1;[NSApp terminate:nil];return;}
                printf("PASS production WKWebView/libmpv embedding, OSC geometry and GPU glass (mean change %.4f)\n",change);
                NSString *path=[self.output stringByAppendingPathComponent:@"capture.png"];
                [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
                mjc_macos_capture(self.view,path.UTF8String,false);
                delay(2,^{
                    if(!self.captureSucceeded || ![[NSFileManager defaultManager] fileExistsAtPath:path]) {fprintf(stderr,"FAIL screenshot\n");self.result=1;[NSApp terminate:nil];return;}
                    [self.window setContentSize:NSMakeSize(720,450)];mjc_macos_layout(self.view,false,false);
                    delay(0.3,^{
                        NSView *native=(__bridge NSView *)self.view;
                        if(!NSEqualRects(native.frame,self.window.contentView.bounds)) {
                            fprintf(stderr,"FAIL immersive video bounds after resize\n");self.result=1;[NSApp terminate:nil];return;
                        }
                        // Destroying the actual production view must release its
                        // pending event/render blocks without accessing Rust context.
                        mjc_macos_destroy(self.view);self.view=NULL;
                        printf("PASS native resize, screenshot and disposal\n");
                        [NSApp terminate:nil];
                    });
                });
            });
        });
    });
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    (void)sender;if(self.view){mjc_macos_destroy(self.view);self.view=NULL;}
    // NSApplication's default terminate exits(0); return through main so a
    // failed native regression actually has a nonzero process exit status.
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp stop:nil];
        [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0] atStart:NO];
    });
    return NSTerminateCancel;
}
@end
int main(int argc,const char *argv[]) {
    @autoreleasepool {
        if(argc!=4)return 2;
        Regression *test=[Regression new];test.root=[NSString stringWithUTF8String:argv[1]];test.media=[NSString stringWithUTF8String:argv[2]];test.output=[NSString stringWithUTF8String:argv[3]];
        [NSApplication sharedApplication];NSApp.delegate=test;[NSApp run];return test.result;
    }
}
