#pragma once

#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <AppKit/NSView.h>

void ImGuiBridge_Init(id<MTLDevice> _Nonnull device, NSView* _Nonnull view);
void ImGuiBridge_RenderFrame(CAMetalLayer* _Nonnull layer, id<MTLCommandQueue> _Nonnull commandQueue);
void ImGuiBridge_Shutdown(void);
