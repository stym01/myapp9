#import "ImGuiBridge.h"

#include "imgui.h"
#include "imgui_impl_metal.h"
#include "imgui_impl_osx.h"

#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>

static id<MTLDevice>  g_device      = nil;
static NSView*        g_view        = nil;
static bool           g_initialized = false;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
void ImGuiBridge_Init(id<MTLDevice> device, NSView* view) {
    if (g_initialized) return;

    g_device = device;
    g_view   = view;

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();

    ImGuiIO& io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    io.IniFilename = nullptr; // no imgui.ini on disk

    // ---- Dark theme matching myapp5 ----
    ImGui::StyleColorsDark();
    ImGuiStyle& style = ImGui::GetStyle();
    style.WindowRounding    = 0.0f;
    style.FrameRounding     = 6.0f;
    style.ScrollbarRounding = 6.0f;
    style.GrabRounding      = 4.0f;
    style.WindowBorderSize  = 0.0f;
    style.FrameBorderSize   = 0.0f;
    style.WindowPadding     = ImVec2(16, 16);
    style.FramePadding      = ImVec2(8, 6);
    style.ItemSpacing       = ImVec2(8, 6);
    style.ScrollbarSize     = 10.0f;

    ImVec4* c = style.Colors;
    c[ImGuiCol_WindowBg]         = ImVec4(0.06f, 0.06f, 0.08f, 0.94f);
    c[ImGuiCol_ChildBg]          = ImVec4(0.06f, 0.06f, 0.08f, 0.00f);
    c[ImGuiCol_PopupBg]          = ImVec4(0.08f, 0.08f, 0.10f, 0.96f);
    c[ImGuiCol_Border]           = ImVec4(0.20f, 0.20f, 0.25f, 0.50f);
    c[ImGuiCol_FrameBg]          = ImVec4(0.12f, 0.12f, 0.15f, 1.00f);
    c[ImGuiCol_FrameBgHovered]   = ImVec4(0.18f, 0.18f, 0.22f, 1.00f);
    c[ImGuiCol_FrameBgActive]    = ImVec4(0.22f, 0.22f, 0.28f, 1.00f);
    c[ImGuiCol_TitleBg]          = ImVec4(0.06f, 0.06f, 0.08f, 1.00f);
    c[ImGuiCol_TitleBgActive]    = ImVec4(0.06f, 0.06f, 0.08f, 1.00f);
    c[ImGuiCol_ScrollbarBg]      = ImVec4(0.06f, 0.06f, 0.08f, 0.60f);
    c[ImGuiCol_ScrollbarGrab]    = ImVec4(0.30f, 0.30f, 0.35f, 1.00f);
    c[ImGuiCol_Button]           = ImVec4(0.15f, 0.15f, 0.20f, 1.00f);
    c[ImGuiCol_ButtonHovered]    = ImVec4(0.25f, 0.50f, 0.85f, 1.00f);
    c[ImGuiCol_ButtonActive]     = ImVec4(0.20f, 0.40f, 0.75f, 1.00f);
    c[ImGuiCol_Header]           = ImVec4(0.15f, 0.15f, 0.20f, 1.00f);
    c[ImGuiCol_HeaderHovered]    = ImVec4(0.25f, 0.50f, 0.85f, 0.80f);
    c[ImGuiCol_HeaderActive]     = ImVec4(0.20f, 0.40f, 0.75f, 1.00f);
    c[ImGuiCol_Separator]        = ImVec4(0.20f, 0.20f, 0.25f, 0.50f);
    c[ImGuiCol_Text]             = ImVec4(0.92f, 0.92f, 0.95f, 1.00f);
    c[ImGuiCol_TextDisabled]     = ImVec4(0.50f, 0.50f, 0.55f, 1.00f);

    // ---- Metal backend ----
    ImGui_ImplMetal_Init(device);

    // ---- macOS platform backend ----
    ImGui_ImplOSX_Init(view);

    // ---- Fonts ----
    ImFontConfig cfg;
    cfg.OversampleH = 2;
    cfg.OversampleV = 1;
    cfg.PixelSnapH  = true;

    ImFont* mainFont = nullptr;
    // Try several macOS font paths in order of preference
    const char* fontPaths[] = {
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/SFNSText.ttf",
        "/Library/Fonts/SF-Pro-Text-Regular.otf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/HelveticaNeue.ttc",
    };
    for (auto path : fontPaths) {
        mainFont = io.Fonts->AddFontFromFileTTF(path, 18.0f, &cfg);
        if (mainFont) {
            NSLog(@"[ImGuiBridge] Loaded font: %s", path);
            break;
        }
    }
    if (!mainFont) {
        io.Fonts->AddFontDefault();
        NSLog(@"[ImGuiBridge] Using default ImGui font");
    }

    g_initialized = true;
    NSLog(@"[ImGuiBridge] ImGui initialized — Metal + OSX backends active");
}

// ---------------------------------------------------------------------------
// Render one frame
// ---------------------------------------------------------------------------
void ImGuiBridge_RenderFrame(CAMetalLayer* layer, id<MTLCommandQueue> commandQueue) {
    if (!g_initialized) return;

    @autoreleasepool {
        id<CAMetalDrawable> drawable = [layer nextDrawable];
        if (!drawable) return;

        id<MTLCommandBuffer> commandBuffer = [commandQueue commandBuffer];
        if (!commandBuffer) return;

        MTLRenderPassDescriptor* rpd = [MTLRenderPassDescriptor new];
        rpd.colorAttachments[0].texture    = drawable.texture;
        rpd.colorAttachments[0].loadAction = MTLLoadActionClear;
        rpd.colorAttachments[0].storeAction = MTLStoreActionStore;
        rpd.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);

        // ---- ImGui new frame ----
        ImGui_ImplMetal_NewFrame(rpd);
        ImGui_ImplOSX_NewFrame(g_view);
        ImGui::NewFrame();

        // ---- UI ----
        ImGuiIO& io = ImGui::GetIO();

        ImGui::SetNextWindowPos(ImVec2(0, 0));
        ImGui::SetNextWindowSize(io.DisplaySize);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(20, 16));
        ImGui::Begin("##SolvroMain", nullptr,
                     ImGuiWindowFlags_NoTitleBar  |
                     ImGuiWindowFlags_NoResize    |
                     ImGuiWindowFlags_NoMove      |
                     ImGuiWindowFlags_NoScrollbar |
                     ImGuiWindowFlags_NoBringToFrontOnFocus);

        // Title bar area
        {
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.40f, 0.78f, 1.0f, 1.0f));
            ImGui::SetWindowFontScale(1.3f);
            ImGui::Text("Solvro");
            ImGui::SetWindowFontScale(1.0f);
            ImGui::PopStyleColor();

            ImGui::SameLine();
            ImGui::TextDisabled("v1.0");
            ImGui::SameLine(io.DisplaySize.x - 120);
            ImGui::TextDisabled("ImGui + Metal");
        }

        ImGui::Separator();
        ImGui::Spacing();

        // Chat area placeholder
        float footerHeight = 70.0f;
        float chatHeight = io.DisplaySize.y - ImGui::GetCursorPosY() - footerHeight - 40;
        ImGui::BeginChild("##ChatArea", ImVec2(-1, chatHeight), ImGuiChildFlags_None,
                          ImGuiWindowFlags_AlwaysVerticalScrollbar);

        ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.70f, 0.70f, 0.75f, 1.0f));
        ImGui::TextWrapped("ImGui + Metal rendering is active inside the stealth overlay panel.");
        ImGui::Spacing();
        ImGui::TextWrapped("Phase 1 complete. The SwiftUI layer has been replaced with Dear ImGui.");
        ImGui::Spacing();
        ImGui::TextWrapped("The overlay is hidden from screen capture and floats above kiosk-mode applications.");
        ImGui::PopStyleColor();

        ImGui::Spacing();
        ImGui::Separator();
        ImGui::Spacing();

        ImGui::TextDisabled("Display: %.0fx%.0f @ %.1f fps",
                            io.DisplaySize.x, io.DisplaySize.y, io.Framerate);
        ImGui::TextDisabled("Mouse: (%.0f, %.0f)", io.MousePos.x, io.MousePos.y);

        ImGui::EndChild();

        // Input bar placeholder
        ImGui::Spacing();
        {
            float inputWidth = io.DisplaySize.x - 100;
            static char inputBuf[4096] = "";
            ImGui::PushItemWidth(inputWidth);
            ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(12, 10));
            ImGui::PushStyleColor(ImGuiCol_FrameBg, ImVec4(0.10f, 0.10f, 0.13f, 1.0f));
            bool sent = ImGui::InputText("##ChatInput", inputBuf, sizeof(inputBuf),
                                         ImGuiInputTextFlags_EnterReturnsTrue);
            ImGui::PopStyleColor();
            ImGui::PopStyleVar();
            ImGui::PopItemWidth();

            ImGui::SameLine();
            if (ImGui::Button("Send", ImVec2(60, 36)) || sent) {
                if (inputBuf[0] != '\0') {
                    NSLog(@"[ImGuiBridge] User typed: %s", inputBuf);
                    inputBuf[0] = '\0';
                }
            }
        }

        ImGui::End();
        ImGui::PopStyleVar(); // WindowPadding

        // ---- Render ----
        ImGui::Render();

        id<MTLRenderCommandEncoder> encoder =
            [commandBuffer renderCommandEncoderWithDescriptor:rpd];
        if (encoder) {
            ImGui_ImplMetal_RenderDrawData(ImGui::GetDrawData(),
                                           commandBuffer, encoder);
            [encoder endEncoding];
        }

        [commandBuffer presentDrawable:drawable];
        [commandBuffer commit];
    }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
void ImGuiBridge_Shutdown(void) {
    if (!g_initialized) return;

    ImGui_ImplMetal_Shutdown();
    ImGui_ImplOSX_Shutdown();
    ImGui::DestroyContext();

    g_device = nil;
    g_view   = nil;
    g_initialized = false;

    NSLog(@"[ImGuiBridge] shutdown complete");
}
