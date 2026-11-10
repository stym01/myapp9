#pragma once

#include <string>
#include <atomic>
#include <functional>
#include <windows.h>

namespace AutoType {

enum class State {
    Idle,
    Countdown,
    Typing,
    Paused,
    Completed,
    Error
};

struct Status {
    State state = State::Idle;
    size_t resumeIndex = 0;
    size_t totalChars = 0;
    std::string message;
    std::string targetWindowName;
};

using ProgressCallback = std::function<void(const Status&)>;

void Init(HWND overlayHwnd);
void Shutdown();

void SetCode(const std::string& code, const std::string& language = "");
const std::string& GetCode();

void SetPythonMode(bool enabled);
bool IsPythonMode();

std::string NormalizeCode(const std::string& code, const std::string& language);

void SetPreTarget(HWND hwnd);
void Start();
void Resume();
void Stop();

State GetState();
Status GetStatus();

void SetProgressCallback(ProgressCallback cb);

}
