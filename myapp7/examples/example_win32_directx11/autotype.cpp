#include "autotype.h"
#include <thread>
#include <mutex>
#include <random>
#include <vector>
#include <algorithm>
#include <regex>
#include <sstream>

namespace AutoType {

static HWND s_overlayHwnd = NULL;
static std::string s_fullCode;
static std::atomic<size_t> s_resumeIndex{0};
static std::atomic<State> s_state{State::Idle};
static std::atomic<bool> s_shouldStop{false};
static bool s_pythonMode = false;
static std::mutex s_mutex;
static std::thread s_thread;
static ProgressCallback s_progressCb;

static HWND s_targetHwnd = NULL;
static std::string s_targetName;
static HWND s_preTarget = NULL;

static const int COUNTDOWN_MS = 1000;
static const int SETTLE_MS = 150;
static const int FOCUS_CHECK_INTERVAL = 50;

// ─── Code normalization helpers ───

static std::vector<std::string> SplitLines(const std::string& s) {
    std::vector<std::string> lines;
    std::istringstream stream(s);
    std::string line;
    while (std::getline(stream, line)) lines.push_back(line);
    if (!s.empty() && s.back() == '\n') lines.push_back("");
    return lines;
}

static std::string JoinLines(const std::vector<std::string>& lines) {
    std::string result;
    for (size_t i = 0; i < lines.size(); i++) {
        if (i > 0) result += '\n';
        result += lines[i];
    }
    return result;
}

static std::string ReplaceAll(const std::string& s, const std::string& from, const std::string& to) {
    std::string result = s;
    size_t pos = 0;
    while ((pos = result.find(from, pos)) != std::string::npos) {
        result.replace(pos, from.size(), to);
        pos += to.size();
    }
    return result;
}

static std::string TrimTrailing(const std::string& s) {
    size_t end = s.find_last_not_of(" \t");
    return (end == std::string::npos) ? "" : s.substr(0, end + 1);
}

static std::string EnsureCppPublicSpecifier(const std::string& code) {
    if (code.empty()) return code;

    std::regex classRe("class\\s+Solution\\b[^\\{]*\\{");
    std::smatch m;
    if (!std::regex_search(code, m, classRe)) return code;

    size_t insertAt = m.position() + m.length();
    std::string rest = code.substr(insertAt);

    size_t braceClose = rest.find('}');
    std::string firstBlock = (braceClose != std::string::npos) ? rest.substr(0, braceClose) : rest;

    std::regex accessRe("\\b(public|private|protected)\\s*:");
    if (std::regex_search(firstBlock, accessRe)) return code;

    size_t trimStart = 0;
    while (trimStart < rest.size() && rest[trimStart] == '\n') trimStart++;
    return code.substr(0, insertAt) + "\npublic:\n" + rest.substr(trimStart);
}

static std::string NormalizePython(const std::string& code) {
    auto lines = SplitLines(code);
    for (auto& l : lines) {
        l = ReplaceAll(l, "\t", "    ");
        l = TrimTrailing(l);
    }

    int minIndent = INT_MAX;
    for (auto& l : lines) {
        if (l.empty()) continue;
        int spaces = 0;
        for (char c : l) { if (c == ' ') spaces++; else break; }
        if (spaces < minIndent) minIndent = spaces;
    }
    if (minIndent == INT_MAX) minIndent = 0;

    for (auto& l : lines) {
        if (l.empty()) continue;
        l = l.substr((size_t)minIndent);
    }
    return JoinLines(lines);
}

static std::string NormalizeGeneral(const std::string& code) {
    auto lines = SplitLines(code);
    for (auto& l : lines) {
        l = ReplaceAll(l, "\t", "");
        size_t start = l.find_first_not_of(' ');
        if (start != std::string::npos) l = l.substr(start);
        else if (!l.empty()) l = "";
        l = TrimTrailing(l);
    }
    return JoinLines(lines);
}

// ─── UTF-8 helpers ───

static int Utf8CharLen(unsigned char c) {
    if (c < 0x80) return 1;
    if ((c & 0xE0) == 0xC0) return 2;
    if ((c & 0xF0) == 0xE0) return 3;
    if ((c & 0xF8) == 0xF0) return 4;
    return 1;
}

// ─── Window helpers ───

static std::string GetWindowTitle(HWND hwnd) {
    if (!hwnd || !IsWindow(hwnd)) return "";
    char buf[256];
    int len = GetWindowTextA(hwnd, buf, sizeof(buf));
    if (len > 0) return std::string(buf, len);
    return "";
}

static void NotifyProgress(State state, const std::string& msg) {
    s_state.store(state);
    if (s_progressCb) {
        Status st;
        st.state = state;
        st.resumeIndex = s_resumeIndex.load();
        st.totalChars = s_fullCode.size();
        st.message = msg;
        st.targetWindowName = s_targetName;
        s_progressCb(st);
    }
}

static void SendKey(WORD vk, bool keyUp) {
    INPUT inp = {};
    inp.type = INPUT_KEYBOARD;
    inp.ki.wVk = vk;
    inp.ki.wScan = (WORD)MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
    inp.ki.dwFlags = (keyUp ? KEYEVENTF_KEYUP : 0);
    if (vk == VK_UP || vk == VK_DOWN || vk == VK_LEFT || vk == VK_RIGHT ||
        vk == VK_HOME || vk == VK_END || vk == VK_PRIOR || vk == VK_NEXT ||
        vk == VK_INSERT || vk == VK_DELETE || vk == VK_NUMLOCK) {
        inp.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
    }
    SendInput(1, &inp, sizeof(INPUT));
}

static void SendUnicode(wchar_t wc) {
    INPUT inp[2] = {};
    inp[0].type = INPUT_KEYBOARD;
    inp[0].ki.wScan = wc;
    inp[0].ki.dwFlags = KEYEVENTF_UNICODE;
    inp[1].type = INPUT_KEYBOARD;
    inp[1].ki.wScan = wc;
    inp[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    SendInput(2, inp, sizeof(INPUT));
}

static void PressKey(WORD vk) {
    SendKey(vk, false);
    Sleep(10);
    SendKey(vk, true);
}

static void ForceForeground(HWND hwnd) {
    if (!hwnd || !IsWindow(hwnd)) return;
    DWORD targetTid = GetWindowThreadProcessId(hwnd, NULL);
    DWORD curTid = GetCurrentThreadId();
    if (targetTid != curTid) AttachThreadInput(curTid, targetTid, TRUE);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    if (targetTid != curTid) AttachThreadInput(curTid, targetTid, FALSE);
    Sleep(60);
}

static HWND FindTargetWindow() {
    if (!s_overlayHwnd || !IsWindow(s_overlayHwnd)) return NULL;

    ShowWindow(s_overlayHwnd, SW_HIDE);

    RECT r;
    GetWindowRect(s_overlayHwnd, &r);
    POINT pt = { (r.left + r.right) / 2, (r.top + r.bottom) / 2 };
    HWND target = WindowFromPoint(pt);
    if (target) {
        HWND root = GetAncestor(target, GA_ROOT);
        if (root) target = root;
    }

    ShowWindow(s_overlayHwnd, SW_SHOWNOACTIVATE);
    return target;
}

static bool EnsureTargetFocused() {
    if (!s_targetHwnd || !IsWindow(s_targetHwnd)) return false;

    HWND fg = GetForegroundWindow();
    if (fg == s_targetHwnd) return true;

    ForceForeground(s_targetHwnd);
    HWND newFg = GetForegroundWindow();
    return (newFg == s_targetHwnd);
}

static void TypeThread() {
    std::string code;
    size_t startIdx;
    bool pythonMode;
    bool isResume;
    {
        std::lock_guard<std::mutex> lock(s_mutex);
        code = s_fullCode;
        startIdx = s_resumeIndex.load();
        pythonMode = s_pythonMode;
        isResume = (startIdx > 0);
    }

    if (code.empty() || startIdx >= code.size()) {
        NotifyProgress(State::Error, "No code to type.");
        return;
    }

    // Resolve target before countdown so we know what we're typing into
    if (isResume && s_targetHwnd && IsWindow(s_targetHwnd)) {
        // Resume: reuse cached target
    } else if (s_preTarget && IsWindow(s_preTarget)) {
        // Hotkey-triggered: use the window that was focused when user pressed the hotkey
        s_targetHwnd = s_preTarget;
        s_targetName = GetWindowTitle(s_preTarget);
    } else {
        // Fallback: detect the window behind the overlay
        HWND target = FindTargetWindow();
        s_targetHwnd = target;
        s_targetName = GetWindowTitle(target);
    }
    s_preTarget = NULL;

    if (!s_targetHwnd || !IsWindow(s_targetHwnd)) {
        NotifyProgress(State::Error, "No target window found. Position the overlay over your editor.");
        return;
    }

    std::string countdownMsg = s_targetName.empty()
        ? "Auto-typing in 1s..."
        : "Auto-typing into " + s_targetName + " in 1s...";
    NotifyProgress(State::Countdown, countdownMsg);
    {
        int elapsed = 0;
        while (elapsed < COUNTDOWN_MS) {
            if (s_shouldStop.load()) {
                NotifyProgress(State::Paused, "Cancelled during countdown.");
                return;
            }
            Sleep(50);
            elapsed += 50;
        }
    }

    if (s_shouldStop.load()) {
        NotifyProgress(State::Paused, "Cancelled before typing.");
        return;
    }

    if (!IsWindow(s_targetHwnd)) {
        NotifyProgress(State::Error, "Target window closed before typing started.");
        return;
    }

    ForceForeground(s_targetHwnd);
    Sleep(SETTLE_MS);

    NotifyProgress(State::Typing, "Typing into " + s_targetName + "...");

    std::mt19937 rng((unsigned)GetTickCount64());
    std::uniform_int_distribution<int> charDelay(35, 110);
    std::uniform_int_distribution<int> lineDelay(80, 200);
    std::uniform_int_distribution<int> pauseChance(1, 30);
    std::uniform_int_distribution<int> longPause(200, 500);

    size_t i = startIdx;
    size_t len = code.size();
    size_t charsSinceCheck = 0;

    while (i < len) {
        if (s_shouldStop.load()) {
            s_resumeIndex.store(i);
            size_t remaining = len - i;
            NotifyProgress(State::Paused, "Paused (" + std::to_string(remaining) + " chars remaining).");
            return;
        }

        charsSinceCheck++;
        if (charsSinceCheck >= FOCUS_CHECK_INTERVAL) {
            charsSinceCheck = 0;

            if (!s_targetHwnd || !IsWindow(s_targetHwnd)) {
                s_resumeIndex.store(i);
                size_t remaining = len - i;
                NotifyProgress(State::Paused, "Target window closed (" + std::to_string(remaining) + " chars remaining). Resume to continue.");
                return;
            }

            if (!EnsureTargetFocused()) {
                s_resumeIndex.store(i);
                size_t remaining = len - i;
                NotifyProgress(State::Paused, "Lost focus (" + std::to_string(remaining) + " chars remaining). Resume to continue.");
                return;
            }
        }

        unsigned char c = (unsigned char)code[i];

        if (c == '\r') { i++; continue; }

        if (c == '\n') {
            PressKey(VK_RETURN);

            if (pythonMode) {
                Sleep(30);
                SHORT xVk = VkKeyScanA('x');
                if (xVk != -1) PressKey(LOBYTE(xVk));
                SendKey(VK_SHIFT, false);
                PressKey(VK_HOME);
                PressKey(VK_HOME);
                SendKey(VK_SHIFT, true);
                PressKey(VK_BACK);
            }

            int delay = lineDelay(rng);
            if (!pythonMode) delay += 150;
            Sleep(delay);
            i++;
        }
        else if (c == '\t') {
            PressKey(VK_TAB);
            Sleep(charDelay(rng));
            i++;
        }
        else if (c >= 0x80) {
            int clen = Utf8CharLen(c);
            if (i + clen > len) clen = (int)(len - i);

            wchar_t wbuf[3] = {};
            int wlen = MultiByteToWideChar(CP_UTF8, 0, &code[i], clen, wbuf, 2);
            for (int w = 0; w < wlen; w++) {
                SendUnicode(wbuf[w]);
            }

            Sleep(charDelay(rng));
            i += clen;
        }
        else {
            SHORT vkResult = VkKeyScanA((char)c);
            if (vkResult != -1) {
                BYTE vk = LOBYTE(vkResult);
                BYTE mods = HIBYTE(vkResult);
                bool needShift = (mods & 1) != 0;
                bool needCtrl  = (mods & 2) != 0;
                bool needAlt   = (mods & 4) != 0;

                if (needCtrl)  SendKey(VK_CONTROL, false);
                if (needAlt)   SendKey(VK_MENU, false);
                if (needShift) SendKey(VK_SHIFT, false);

                PressKey(vk);

                if (needShift) SendKey(VK_SHIFT, true);
                if (needAlt)   SendKey(VK_MENU, true);
                if (needCtrl)  SendKey(VK_CONTROL, true);
            }
            else {
                wchar_t wc = 0;
                MultiByteToWideChar(CP_UTF8, 0, &code[i], 1, &wc, 1);
                if (wc) SendUnicode(wc);
            }

            int delay = charDelay(rng);
            if (pauseChance(rng) == 1) delay = longPause(rng);
            if (!pythonMode && (c == '{' || c == '}' || c == ';')) delay += 150;
            Sleep(delay);
            i++;
        }

        s_resumeIndex.store(i);

        if ((i - startIdx) % 20 == 0) {
            NotifyProgress(State::Typing, "Typing into " + s_targetName + "... (" + std::to_string(i) + "/" + std::to_string(len) + ")");
        }
    }

    s_resumeIndex.store(len);
    NotifyProgress(State::Completed, "Auto-typing completed.");

    Sleep(3000);
    State afterWait = s_state.load();
    if (afterWait == State::Completed) {
        NotifyProgress(State::Idle, "");
    }
}

// ─── Public API ───

std::string NormalizeCode(const std::string& code, const std::string& language) {
    if (code.empty()) return code;

    std::string normalized = ReplaceAll(code, "\r\n", "\n");
    normalized = ReplaceAll(normalized, "\r", "\n");

    if (language == "python" || language == "python3") {
        normalized = NormalizePython(normalized);
    } else {
        normalized = NormalizeGeneral(normalized);
    }

    if (language == "cpp") {
        normalized = EnsureCppPublicSpecifier(normalized);
    }

    while (!normalized.empty() && normalized.back() == '\n') normalized.pop_back();

    return normalized;
}

void Init(HWND overlayHwnd) {
    s_overlayHwnd = overlayHwnd;
    s_state.store(State::Idle);
    s_shouldStop.store(false);
    s_resumeIndex.store(0);
    s_fullCode.clear();
    s_targetHwnd = NULL;
    s_targetName.clear();
}

void Shutdown() {
    s_shouldStop.store(true);
    if (s_thread.joinable()) s_thread.join();
    s_state.store(State::Idle);
}

void SetCode(const std::string& code, const std::string& language) {
    std::lock_guard<std::mutex> lock(s_mutex);
    s_fullCode = NormalizeCode(code, language);
    s_resumeIndex.store(0);
    s_targetHwnd = NULL;
    s_targetName.clear();
}

const std::string& GetCode() {
    return s_fullCode;
}

void SetPythonMode(bool enabled) {
    std::lock_guard<std::mutex> lock(s_mutex);
    s_pythonMode = enabled;
}

bool IsPythonMode() {
    return s_pythonMode;
}

void SetPreTarget(HWND hwnd) {
    s_preTarget = hwnd;
}

void Start() {
    State cur = s_state.load();
    if (cur == State::Typing || cur == State::Countdown) {
        Stop();
        if (s_thread.joinable()) s_thread.join();
    } else if (s_thread.joinable()) {
        s_thread.join();
    }

    s_resumeIndex.store(0);
    s_shouldStop.store(false);
    s_targetHwnd = NULL;
    s_targetName.clear();
    s_thread = std::thread(TypeThread);
}

void Resume() {
    State cur = s_state.load();
    if (cur == State::Typing || cur == State::Countdown) return;

    if (s_fullCode.empty()) {
        NotifyProgress(State::Error, "No code to resume.");
        return;
    }

    size_t idx = s_resumeIndex.load();
    if (idx == 0) {
        NotifyProgress(State::Error, "Nothing to resume. Use Start to type from the beginning.");
        return;
    }
    if (idx >= s_fullCode.size()) {
        NotifyProgress(State::Completed, "Already completed.");
        return;
    }

    if (s_thread.joinable()) s_thread.join();

    s_shouldStop.store(false);
    s_thread = std::thread(TypeThread);
}

void Stop() {
    s_shouldStop.store(true);
}

State GetState() {
    return s_state.load();
}

Status GetStatus() {
    Status st;
    st.state = s_state.load();
    st.resumeIndex = s_resumeIndex.load();
    st.totalChars = s_fullCode.size();
    st.targetWindowName = s_targetName;
    return st;
}

void SetProgressCallback(ProgressCallback cb) {
    std::lock_guard<std::mutex> lock(s_mutex);
    s_progressCb = cb;
}

}
