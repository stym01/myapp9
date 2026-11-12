#import "ImGuiBridge.h"

#include "imgui.h"
#include "imgui_impl_metal.h"
#include "imgui_impl_osx.h"

#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#include <string>
#include <vector>
#include <cmath>

// ---------------------------------------------------------------------------
// Static state
// ---------------------------------------------------------------------------
static id<MTLDevice>  g_device      = nil;
static NSView*        g_view        = nil;
static bool           g_initialized = false;

// Service bridge state (written from Swift, read by ImGui)
struct BridgeMessage {
    std::string role;
    std::string text;
};

static std::vector<BridgeMessage> g_messages;
static bool        g_isLoading       = false;
static std::string g_statusText      = "Ready";
static std::string g_modelName       = "";
static std::string g_languageName    = "";
static bool        g_isLoggedIn      = false;
static std::string g_userEmail       = "";
static int         g_userTier        = 0;
static int         g_screenshotCount = 0;

// Input buffer (written by ImGui, consumed by Swift)
static char g_inputBuf[4096] = "";
static std::string g_pendingInput = "";

// Action flags (set by ImGui buttons, consumed by Swift polling)
static bool g_action_send          = false;
static bool g_action_reset         = false;
static bool g_action_cycleModel    = false;
static bool g_action_cycleLanguage = false;
static bool g_action_screenshot    = false;
static bool g_action_autoType      = false;
static bool g_action_copyLast      = false;

// Auto-scroll
static bool g_scrollToBottom = false;
static int  g_lastMessageCount = 0;

// ---------------------------------------------------------------------------
// Bridge: state setters (called from Swift)
// ---------------------------------------------------------------------------
void ImGuiBridge_SetViewModel(id viewModel) {
    // Reserved for future direct ObjC access
}

void ImGuiBridge_SetOverlayController(id controller) {
    // Reserved for future direct ObjC access
}

void ImGuiBridge_UpdateChatState(
    int messageCount,
    bool isLoading,
    const char* statusText,
    const char* modelName,
    const char* languageName,
    bool isLoggedIn,
    const char* userEmail,
    int userTier,
    int screenshotCount
) {
    g_isLoading       = isLoading;
    g_statusText      = statusText ? statusText : "";
    g_modelName       = modelName ? modelName : "";
    g_languageName    = languageName ? languageName : "";
    g_isLoggedIn      = isLoggedIn;
    g_userEmail       = userEmail ? userEmail : "";
    g_userTier        = userTier;
    g_screenshotCount = screenshotCount;
}

void ImGuiBridge_ClearMessages(void) {
    g_messages.clear();
}

void ImGuiBridge_PushMessage(const char* role, const char* text) {
    g_messages.push_back({ role ? role : "", text ? text : "" });
    if ((int)g_messages.size() != g_lastMessageCount) {
        g_scrollToBottom = true;
        g_lastMessageCount = (int)g_messages.size();
    }
}

const char* ImGuiBridge_ConsumeInput(void) {
    if (g_pendingInput.empty()) return nullptr;
    static std::string result;
    result = g_pendingInput;
    g_pendingInput.clear();
    return result.c_str();
}

bool ImGuiBridge_ConsumeAction_Send(void) {
    bool v = g_action_send; g_action_send = false; return v;
}
bool ImGuiBridge_ConsumeAction_Reset(void) {
    bool v = g_action_reset; g_action_reset = false; return v;
}
bool ImGuiBridge_ConsumeAction_CycleModel(void) {
    bool v = g_action_cycleModel; g_action_cycleModel = false; return v;
}
bool ImGuiBridge_ConsumeAction_CycleLanguage(void) {
    bool v = g_action_cycleLanguage; g_action_cycleLanguage = false; return v;
}
bool ImGuiBridge_ConsumeAction_Screenshot(void) {
    bool v = g_action_screenshot; g_action_screenshot = false; return v;
}
bool ImGuiBridge_ConsumeAction_AutoType(void) {
    bool v = g_action_autoType; g_action_autoType = false; return v;
}
bool ImGuiBridge_ConsumeAction_CopyLast(void) {
    bool v = g_action_copyLast; g_action_copyLast = false; return v;
}

// ---------------------------------------------------------------------------
// Helper: accent color
// ---------------------------------------------------------------------------
static ImVec4 g_accentColor = ImVec4(0.40f, 0.78f, 1.0f, 1.0f);

static ImU32 AccentColorU32(float alpha = 1.0f) {
    return ImGui::ColorConvertFloat4ToU32(
        ImVec4(g_accentColor.x, g_accentColor.y, g_accentColor.z, alpha));
}

// ---------------------------------------------------------------------------
// Helper: thinking animation
// ---------------------------------------------------------------------------
static void DrawThinkingLoader() {
    float time = (float)ImGui::GetTime();
    const char* text = "Thinking...";
    float w = ImGui::CalcTextSize(text).x;
    float startX = (ImGui::GetWindowWidth() - w) * 0.5f;
    if (startX < 5.0f) startX = 5.0f;
    ImGui::SetCursorPosX(startX);
    for (int i = 0; text[i] != 0; i++) {
        float t = time * 4.0f - (i * 0.3f);
        float intensity = (sinf(t) + 1.0f) * 0.5f;
        intensity = powf(intensity, 3.0f);
        float r = 0.4f + 0.6f * intensity;
        float g = 0.4f + 0.6f * intensity;
        float b = 0.4f + 0.6f * intensity;
        float a = 0.5f + 0.5f * intensity;
        ImGui::TextColored(ImVec4(r, g, b, a), "%c", text[i]);
        ImGui::SameLine(0, 0);
    }
    ImGui::NewLine();
}

// ---------------------------------------------------------------------------
// Helper: strip markdown formatting
// ---------------------------------------------------------------------------
static std::string StripMarkdown(const std::string& line) {
    std::string s = line;
    while (!s.empty() && s[0] == '#') s.erase(0, 1);
    if (!s.empty() && s[0] == ' ') s.erase(0, 1);
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); i++) {
        if (i + 1 < s.size() && s[i] == '*' && s[i + 1] == '*') {
            i++;
            continue;
        }
        out.push_back(s[i]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Helper: render a message bubble
// ---------------------------------------------------------------------------
static void RenderBubble(const std::string& text, bool isUser, bool isCode, float maxWidth) {
    if (text.empty()) return;

    ImDrawList* draw = ImGui::GetWindowDrawList();
    ImVec2 pos = ImGui::GetCursorScreenPos();

    ImU32 bgCol;
    ImU32 textCol = IM_COL32(240, 240, 240, 255);

    if (isCode) {
        bgCol = IM_COL32(20, 20, 22, 255);
        textCol = IM_COL32(200, 200, 200, 255);
    } else if (isUser) {
        bgCol = AccentColorU32(0.20f);
    } else {
        bgCol = IM_COL32(40, 40, 45, 255);
    }

    ImVec2 textSize = ImGui::CalcTextSize(text.c_str(), NULL, false, maxWidth);
    ImVec2 padding = isCode ? ImVec2(10.0f, 10.0f) : ImVec2(12.0f, 8.0f);
    ImVec2 bubbleSize = ImVec2(textSize.x + padding.x * 2.0f, textSize.y + padding.y * 2.0f);

    float availWidth = ImGui::GetContentRegionAvail().x;
    float offsetX = 0.0f;
    if (isUser) {
        offsetX = availWidth - bubbleSize.x;
        if (offsetX < 0) offsetX = 0;
    } else {
        offsetX = 5.0f;
    }

    ImVec2 bubbleMin = ImVec2(pos.x + offsetX, pos.y);
    ImVec2 bubbleMax = ImVec2(bubbleMin.x + bubbleSize.x, bubbleMin.y + bubbleSize.y);

    float rounding = isCode ? 4.0f : 12.0f;
    ImDrawFlags flags = ImDrawFlags_None;
    if (!isCode && isUser)
        flags = ImDrawFlags_RoundCornersTopLeft | ImDrawFlags_RoundCornersBottomLeft | ImDrawFlags_RoundCornersBottomRight;
    else if (!isCode && !isUser)
        flags = ImDrawFlags_RoundCornersTopRight | ImDrawFlags_RoundCornersBottomLeft | ImDrawFlags_RoundCornersBottomRight;

    draw->AddRectFilled(bubbleMin, bubbleMax, bgCol, rounding, flags);

    if (isCode) {
        draw->AddRect(bubbleMin, bubbleMax, IM_COL32(60, 60, 65, 255), rounding);
    } else if (!isUser) {
        draw->AddRect(bubbleMin, bubbleMax, IM_COL32(60, 60, 65, 100), rounding, flags);
    }

    ImGui::SetCursorScreenPos(ImVec2(bubbleMin.x + padding.x, bubbleMin.y + padding.y));
    ImGui::PushTextWrapPos(ImGui::GetCursorPos().x + maxWidth);
    ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(textCol), "%s", text.c_str());
    ImGui::PopTextWrapPos();

    ImGui::SetCursorScreenPos(ImVec2(pos.x, pos.y + bubbleSize.y + 5.0f));
}

// ---------------------------------------------------------------------------
// Helper: render a full message with markdown parsing
// ---------------------------------------------------------------------------
static void RenderSmartMessage(const BridgeMessage& msg) {
    bool isUser = (msg.role == "user");
    float windowWidth = ImGui::GetContentRegionAvail().x;
    float maxBubbleWidth = windowWidth * 0.85f;

    if (!isUser) {
        ImGui::SetCursorPosX(5.0f);
        ImGui::TextDisabled("AI");
    }

    std::string currentBuffer;
    bool inCodeBlock = false;
    size_t start = 0;
    const std::string& text = msg.text;

    while (start < text.size()) {
        size_t end = text.find('\n', start);
        std::string line;
        if (end == std::string::npos) {
            line = text.substr(start);
            start = text.size();
        } else {
            line = text.substr(start, end - start);
            start = end + 1;
        }

        if (line.size() >= 3 && line.substr(0, 3) == "```") {
            if (!currentBuffer.empty()) {
                RenderBubble(currentBuffer, isUser, inCodeBlock, maxBubbleWidth);
                currentBuffer.clear();
            }
            inCodeBlock = !inCodeBlock;
            continue;
        }

        if (inCodeBlock) {
            currentBuffer += line + "\n";
        } else {
            currentBuffer += StripMarkdown(line) + "\n";
        }
    }

    if (!currentBuffer.empty()) {
        RenderBubble(currentBuffer, isUser, inCodeBlock, maxBubbleWidth);
    }

    ImGui::Dummy(ImVec2(0.0f, 10.0f));
}

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
    io.IniFilename = nullptr;

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

    ImGui_ImplMetal_Init(device);
    ImGui_ImplOSX_Init(view);

    ImFontConfig cfg;
    cfg.OversampleH = 2;
    cfg.OversampleV = 1;
    cfg.PixelSnapH  = true;

    ImFont* mainFont = nullptr;
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
    NSLog(@"[ImGuiBridge] initialized — Metal + OSX backends active");
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

        ImGui_ImplMetal_NewFrame(rpd);
        ImGui_ImplOSX_NewFrame(g_view);
        ImGui::NewFrame();

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

        // ---- TITLE BAR ----
        {
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(g_accentColor.x, g_accentColor.y, g_accentColor.z, 1.0f));
            ImGui::SetWindowFontScale(1.3f);
            ImGui::Text("Solvro");
            ImGui::SetWindowFontScale(1.0f);
            ImGui::PopStyleColor();

            ImGui::SameLine(0, 8);
            ImGui::TextDisabled("v1.0");

            // Model badge
            if (!g_modelName.empty()) {
                ImGui::SameLine(0, 12);
                ImDrawList* dl = ImGui::GetWindowDrawList();
                ImVec2 tpos = ImGui::GetCursorScreenPos();
                ImVec2 tsz = ImGui::CalcTextSize(g_modelName.c_str());
                float px = 8.0f, py = 2.0f;
                dl->AddRectFilled(
                    ImVec2(tpos.x - px, tpos.y - py),
                    ImVec2(tpos.x + tsz.x + px, tpos.y + tsz.y + py),
                    IM_COL32(255, 255, 255, 10), 10.0f);
                dl->AddRect(
                    ImVec2(tpos.x - px, tpos.y - py),
                    ImVec2(tpos.x + tsz.x + px, tpos.y + tsz.y + py),
                    AccentColorU32(0.25f), 10.0f);
                ImGui::TextColored(ImVec4(0.94f, 0.94f, 0.96f, 0.7f), "%s", g_modelName.c_str());
            }

            // Language badge
            if (!g_languageName.empty()) {
                ImGui::SameLine(0, 8);
                ImGui::TextColored(ImVec4(0.94f, 0.94f, 0.96f, 0.5f), "[%s]", g_languageName.c_str());
            }

            // Right side: status + screenshot count
            float rightX = io.DisplaySize.x - 200;
            if (rightX > ImGui::GetCursorPosX() + 20) {
                ImGui::SameLine(rightX);
                if (g_screenshotCount > 0) {
                    ImGui::TextColored(ImVec4(0.3f, 0.9f, 0.4f, 0.9f), "%d img", g_screenshotCount);
                    ImGui::SameLine(0, 8);
                }
                ImGui::TextDisabled("%s", g_statusText.c_str());
            }
        }

        ImGui::Separator();
        ImGui::Spacing();

        // ---- TOOLBAR (below title bar) ----
        {
            ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, 8.0f);
            ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(10, 4));

            if (ImGui::Button("New Chat")) {
                g_action_reset = true;
            }
            ImGui::SameLine(0, 6);
            if (ImGui::Button("Screenshot")) {
                g_action_screenshot = true;
            }
            ImGui::SameLine(0, 6);
            if (ImGui::Button("Model")) {
                g_action_cycleModel = true;
            }
            ImGui::SameLine(0, 6);
            if (ImGui::Button("Lang")) {
                g_action_cycleLanguage = true;
            }
            ImGui::SameLine(0, 6);
            if (ImGui::Button("Auto-Type")) {
                g_action_autoType = true;
            }
            if (!g_messages.empty()) {
                ImGui::SameLine(0, 6);
                if (ImGui::Button("Copy Last")) {
                    g_action_copyLast = true;
                }
            }

            ImGui::PopStyleVar(2);
        }

        ImGui::Spacing();
        ImGui::Separator();
        ImGui::Spacing();

        // ---- CHAT AREA ----
        float footerHeight = 70.0f;
        float chatHeight = io.DisplaySize.y - ImGui::GetCursorPosY() - footerHeight - 40;
        if (chatHeight < 100) chatHeight = 100;

        ImGui::BeginChild("##ChatArea", ImVec2(-1, chatHeight), ImGuiChildFlags_None,
                          ImGuiWindowFlags_AlwaysVerticalScrollbar);

        if (g_messages.empty() && !g_isLoading) {
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.50f, 0.50f, 0.55f, 1.0f));
            float centerY = chatHeight * 0.35f;
            if (centerY > 50) ImGui::SetCursorPosY(centerY);
            float textW = ImGui::CalcTextSize("Ask me anything...").x;
            ImGui::SetCursorPosX((ImGui::GetWindowWidth() - textW) * 0.5f);
            ImGui::Text("Ask me anything...");
            ImGui::Spacing();
            if (g_isLoggedIn) {
                const char* hint = "Type a question or take a screenshot (Cmd+Shift+S)";
                float hintW = ImGui::CalcTextSize(hint).x;
                ImGui::SetCursorPosX((ImGui::GetWindowWidth() - hintW) * 0.5f);
                ImGui::TextDisabled("%s", hint);
            } else {
                const char* hint = "Please sign in via the Solvro app";
                float hintW = ImGui::CalcTextSize(hint).x;
                ImGui::SetCursorPosX((ImGui::GetWindowWidth() - hintW) * 0.5f);
                ImGui::TextColored(ImVec4(0.96f, 0.62f, 0.04f, 0.9f), "%s", hint);
            }
            ImGui::PopStyleColor();
        } else {
            for (auto& msg : g_messages) {
                RenderSmartMessage(msg);
            }

            if (g_isLoading) {
                DrawThinkingLoader();
            }
        }

        if (g_scrollToBottom) {
            ImGui::SetScrollHereY(1.0f);
            g_scrollToBottom = false;
        }

        ImGui::EndChild();

        // ---- INPUT BAR ----
        ImGui::Spacing();
        {
            float inputWidth = io.DisplaySize.x - 100;
            ImGui::PushItemWidth(inputWidth);
            ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(12, 10));
            ImGui::PushStyleColor(ImGuiCol_FrameBg, ImVec4(0.10f, 0.10f, 0.13f, 1.0f));

            bool sent = ImGui::InputText("##ChatInput", g_inputBuf, sizeof(g_inputBuf),
                                         ImGuiInputTextFlags_EnterReturnsTrue);
            ImGui::PopStyleColor();
            ImGui::PopStyleVar();
            ImGui::PopItemWidth();

            ImGui::SameLine();

            bool sendDisabled = g_isLoading || (g_inputBuf[0] == '\0' && g_screenshotCount == 0);
            if (sendDisabled) {
                ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.12f, 0.12f, 0.15f, 1.0f));
                ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.4f, 0.4f, 0.4f, 1.0f));
            }

            if (ImGui::Button("Send", ImVec2(60, 36)) || (sent && !sendDisabled)) {
                if (!sendDisabled && (g_inputBuf[0] != '\0' || g_screenshotCount > 0)) {
                    g_pendingInput = g_inputBuf;
                    g_action_send = true;
                    g_inputBuf[0] = '\0';
                }
            }

            if (sendDisabled) {
                ImGui::PopStyleColor(2);
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
    g_messages.clear();

    NSLog(@"[ImGuiBridge] shutdown complete");
}
