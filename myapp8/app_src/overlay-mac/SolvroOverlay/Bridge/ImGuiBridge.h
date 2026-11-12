#pragma once

#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <AppKit/NSView.h>

#ifdef __cplusplus
extern "C" {
#endif

// Lifecycle
void ImGuiBridge_Init(id<MTLDevice> _Nonnull device, NSView* _Nonnull view);
void ImGuiBridge_RenderFrame(CAMetalLayer* _Nonnull layer, id<MTLCommandQueue> _Nonnull commandQueue);
void ImGuiBridge_Shutdown(void);

// Service bridge — called from Swift to push state into C++ each frame
void ImGuiBridge_SetViewModel(id _Nonnull viewModel);
void ImGuiBridge_SetOverlayController(id _Nonnull controller);

// Chat state pushed from Swift
void ImGuiBridge_UpdateChatState(
    int messageCount,
    bool isLoading,
    const char* _Nullable statusText,
    const char* _Nullable modelName,
    const char* _Nullable languageName,
    bool isLoggedIn,
    const char* _Nullable userEmail,
    int userTier,
    int screenshotCount
);

// Push a single message into the C++ message array
void ImGuiBridge_ClearMessages(void);
void ImGuiBridge_PushMessage(const char* _Nonnull role, const char* _Nonnull text);

// Query what the user typed (returns the input buffer; cleared after read)
const char* _Nullable ImGuiBridge_ConsumeInput(void);

// Query UI actions triggered by ImGui buttons
bool ImGuiBridge_ConsumeAction_Send(void);
bool ImGuiBridge_ConsumeAction_Reset(void);
bool ImGuiBridge_ConsumeAction_CycleModel(void);
bool ImGuiBridge_ConsumeAction_CycleLanguage(void);
bool ImGuiBridge_ConsumeAction_Screenshot(void);
bool ImGuiBridge_ConsumeAction_AutoType(void);
bool ImGuiBridge_ConsumeAction_CopyLast(void);

#ifdef __cplusplus
}
#endif
