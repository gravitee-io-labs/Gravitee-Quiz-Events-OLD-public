// Workaround for Playwright's bundled WebKit on macOS 26 ("Tahoe"): headless launch segfaults because the bundled
// WebKit calls WKWebView -_cornerConfiguration, a selector that macOS 26 changed. This library neutralises that one
// call (returns nil) when injected with DYLD_INSERT_LIBRARIES. Build + use: see build.sh and e2e/README.md.
#import <Foundation/Foundation.h>
#import <objc/runtime.h>

static id nilCorner(id self, SEL _cmd) { return nil; }

__attribute__((constructor)) static void shim_init(void) {
  Class c = objc_getClass("WKWebView");
  if (!c) return;
  Method m = class_getInstanceMethod(c, sel_registerName("_cornerConfiguration"));
  if (m) method_setImplementation(m, (IMP)nilCorner);
}
