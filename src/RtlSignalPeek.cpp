#define WIN32_LEAN_AND_MEAN
#define _RICHEDIT_VER 0x0500
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <richedit.h>

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cwctype>
#include <filesystem>
#include <map>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "PluginInterface.h"

namespace {

constexpr int kCmdPeekAtCaret = 0;
constexpr int kCmdShowPanel = 1;
constexpr int kCmdSettings = 2;
constexpr int kCmdPinProjectRoot = 3;
constexpr int kCmdClearProjectRoot = 4;
constexpr int kFuncCount = 5;
constexpr UINT kIdList = 1001;
constexpr UINT kIdPreview = 1002;
constexpr UINT kIdHeader = 1003;
constexpr UINT kIdStatus = 1004;
constexpr int kIdSettingsUpLevels = 3001;
constexpr int kIdSettingsDownLevels = 3002;
constexpr int kIdSettingsMaxFiles = 3003;
constexpr int kIdSettingsMaxIndexMs = 3004;
constexpr int kIdSettingsExcludeDirs = 3005;
constexpr int kIdSettingsClickModifier = 3006;
constexpr int kIdSettingsDefaults = 3007;
constexpr int kPanelPadding = 8;
constexpr int kHeaderHeight = 28;
constexpr int kStatusHeight = 20;
constexpr int kListGap = 6;
constexpr int kThemeStyleCount = STYLE_LINENUMBER + 1;
constexpr int kPreviewFontHeight = 160;
constexpr int kListItemHeight = 68;
constexpr int kCategoryBadgeWidth = 44;
constexpr UINT_PTR kCenterTimerId = 0x5250;

const wchar_t kPluginName[] = L"RTL Signal Peek";
const wchar_t kPanelClass[] = L"RtlSignalPeekPanelClass";
const wchar_t kSettingsClass[] = L"RtlSignalPeekSettingsClass";
const wchar_t kPanelTitle[] = L"RTL Signal Peek";
const wchar_t kListPlaceholder[] = L"";

NppData g_nppData{};
FuncItem g_funcItems[kFuncCount]{};
HINSTANCE g_instance = nullptr;
std::wstring g_pluginDir;

struct Settings {
  std::wstring nodeExe = L"node.exe";
  std::wstring queryScript;
  std::vector<std::wstring> sourceRoots;
  std::wstring netgraphDir;
  std::wstring netgraphSourceRoot;
  std::wstring topModule = L"demo_top";
  int upLevels = 2;
  int downLevels = 8;
  int maxFiles = 2000;
  int maxIndexMs = 2000;
  std::wstring excludeDirs = L"archive;backup;doc;ai_output;.Xil";
  bool ctrlClick = true;
  bool altClick = false;
  bool requireBothModifiers = false;
};

Settings g_settings;
FILETIME g_iniWriteTime{};
bool g_settingsLoaded = false;
bool g_iniSeen = false;

struct Location {
  std::wstring file;
  int line = 1;
  std::wstring module;
  std::wstring instancePath;
  std::wstring kind;
  std::wstring lookupSignal;
  std::wstring detail;
  std::wstring highlightSignals;
};

struct QueryMeta {
  std::wstring signal;
  std::wstring module;
  std::wstring instancePath;
  int count = 0;
  std::wstring mode;
};

HWND g_panel = nullptr;
HWND g_settingsWindow = nullptr;
HWND g_header = nullptr;
HWND g_status = nullptr;
HWND g_list = nullptr;
HWND g_preview = nullptr;
WNDPROC g_oldListProc = nullptr;
WNDPROC g_oldPreviewProc = nullptr;
HFONT g_uiFont = nullptr;
HFONT g_boldFont = nullptr;
HFONT g_codeFont = nullptr;
HFONT g_smallFont = nullptr;
HBRUSH g_backgroundBrush = nullptr;
HBRUSH g_hoverBrush = nullptr;
HBRUSH g_selectedBrush = nullptr;
int g_hoverIndex = -1;
int g_previewIndex = -1;
int g_previewTargetLine = -1;
bool g_trackingListMouse = false;
bool g_hasPopupAnchor = false;
POINT g_popupAnchor{};
std::wstring g_richClass = L"RICHEDIT50W";
std::wstring g_querySignal;
std::vector<Location> g_locations;
std::map<std::wstring, COLORREF> g_moduleColors;
std::wstring g_pendingCenterFile;
int g_pendingCenterLine = 0;
int g_pendingCenterAttempts = 0;
std::map<std::wstring, std::vector<std::wstring>> g_lineCache;
std::map<HWND, WNDPROC> g_scintillaProc;

bool CreatePanel();
void HidePanel();
void CenterPreviewLine(int targetLine);

std::wstring Lower(std::wstring value) {
  for (wchar_t& ch : value) ch = static_cast<wchar_t>(towlower(ch));
  return value;
}

bool EndsWithNoCase(const std::wstring& value, const std::wstring& suffix) {
  if (value.size() < suffix.size()) return false;
  return Lower(value.substr(value.size() - suffix.size())) == Lower(suffix);
}

bool FileExists(const std::wstring& path) {
  if (path.empty()) return false;
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

std::wstring JoinPath(const std::wstring& a, const std::wstring& b) {
  if (a.empty()) return b;
  if (b.empty()) return a;
  if (a.back() == L'\\' || a.back() == L'/') return a + b;
  return a + L"\\" + b;
}

std::wstring BaseName(const std::wstring& path) {
  const size_t slash = path.find_last_of(L"\\/");
  return slash == std::wstring::npos ? path : path.substr(slash + 1);
}

std::wstring FileStem(const std::wstring& path) {
  const std::wstring name = BaseName(path);
  const size_t dot = name.find_last_of(L'.');
  return dot == std::wstring::npos ? name : name.substr(0, dot);
}

std::wstring ParentPath(const std::wstring& path) {
  const size_t slash = path.find_last_of(L"\\/");
  return slash == std::wstring::npos ? L"" : path.substr(0, slash);
}

std::wstring AbsolutePath(const std::wstring& value) {
  if (value.empty()) return value;
  std::filesystem::path p(value);
  if (p.is_relative()) p = std::filesystem::path(g_pluginDir) / p;
  return p.lexically_normal().wstring();
}

std::wstring IniPath() {
  return JoinPath(g_pluginDir, L"RtlSignalPeek.ini");
}

std::wstring ReadIni(const wchar_t* key, const wchar_t* fallback) {
  std::vector<wchar_t> buffer(32768);
  GetPrivateProfileStringW(L"rtl", key, fallback, buffer.data(), static_cast<DWORD>(buffer.size()), IniPath().c_str());
  return std::wstring(buffer.data());
}

std::wstring Trim(std::wstring value) {
  size_t first = 0;
  while (first < value.size() && iswspace(value[first])) ++first;
  size_t last = value.size();
  while (last > first && iswspace(value[last - 1])) --last;
  value = value.substr(first, last - first);
  if (value.size() >= 2 && value.front() == L'"' && value.back() == L'"') {
    value = value.substr(1, value.size() - 2);
  }
  return value;
}

int ReadIniInt(const wchar_t* key, int fallback, int minValue, int maxValue) {
  const std::wstring fallbackText = std::to_wstring(fallback);
  const std::wstring text = Trim(ReadIni(key, fallbackText.c_str()));
  if (text.empty()) return fallback;
  return std::clamp(_wtoi(text.c_str()), minValue, maxValue);
}

std::wstring ScopesFilePath() {
  std::vector<wchar_t> appData(32768);
  const DWORD length = GetEnvironmentVariableW(L"APPDATA", appData.data(), static_cast<DWORD>(appData.size()));
  const std::wstring directory = (length > 0 && length < appData.size())
    ? JoinPath(std::wstring(appData.data()), L"RtlSignalPeek")
    : g_pluginDir;
  CreateDirectoryW(directory.c_str(), nullptr);
  return JoinPath(directory, L"scopes.txt");
}

std::vector<std::wstring> SplitPathList(const std::wstring& value) {
  std::vector<std::wstring> paths;
  size_t start = 0;
  while (start <= value.size()) {
    size_t end = value.find(L';', start);
    if (end == std::wstring::npos) end = value.size();
    const std::wstring path = Trim(value.substr(start, end - start));
    if (!path.empty()) paths.push_back(AbsolutePath(path));
    if (end == value.size()) break;
    start = end + 1;
  }
  return paths;
}

std::wstring JoinPathList(const std::vector<std::wstring>& paths) {
  std::wstring text;
  for (const std::wstring& path : paths) {
    if (!text.empty()) text += L";";
    text += path;
  }
  return text;
}

void LoadSettings() {
  g_settings.nodeExe = ReadIni(L"nodeExe", L"node.exe");
  g_settings.queryScript = AbsolutePath(ReadIni(L"queryScript", L"js\\query.js"));
  g_settings.sourceRoots = SplitPathList(ReadIni(L"sourceRoot", L"demo\\rtl"));
  if (g_settings.sourceRoots.empty()) g_settings.sourceRoots.push_back(AbsolutePath(L"demo\\rtl"));
  g_settings.netgraphDir = AbsolutePath(ReadIni(L"netgraphDir", L"demo\\netgraph"));
  const std::wstring netgraphSourceRoot = Trim(ReadIni(L"netgraphSourceRoot", L""));
  g_settings.netgraphSourceRoot = netgraphSourceRoot.empty()
    ? g_settings.sourceRoots.front()
    : AbsolutePath(netgraphSourceRoot);
  g_settings.topModule = ReadIni(L"topModule", L"demo_top");
  g_settings.upLevels = ReadIniInt(L"upLevels", 2, 0, 8);
  g_settings.downLevels = ReadIniInt(L"downLevels", 8, 0, 32);
  g_settings.maxFiles = ReadIniInt(L"maxFiles", 2000, 10, 20000);
  g_settings.maxIndexMs = ReadIniInt(L"maxIndexMs", 2000, 100, 15000);
  g_settings.excludeDirs = Trim(ReadIni(L"excludeDirs", L"archive;backup;doc;ai_output;.Xil"));

  std::wstring modifier = Lower(ReadIni(L"clickModifier", L"Ctrl"));
  if (modifier == L"alt") {
    g_settings.ctrlClick = false;
    g_settings.altClick = true;
    g_settings.requireBothModifiers = false;
  } else if (modifier == L"ctrl+alt" || modifier == L"both") {
    g_settings.ctrlClick = true;
    g_settings.altClick = true;
    g_settings.requireBothModifiers = true;
  } else {
    g_settings.ctrlClick = true;
    g_settings.altClick = false;
    g_settings.requireBothModifiers = false;
  }
}

void LoadSettingsIfChanged() {
  WIN32_FILE_ATTRIBUTE_DATA data{};
  const std::wstring ini = IniPath();
  if (!GetFileAttributesExW(ini.c_str(), GetFileExInfoStandard, &data)) {
    if (!g_settingsLoaded || g_iniSeen) {
      LoadSettings();
      g_settingsLoaded = true;
      g_iniSeen = false;
      g_iniWriteTime = {};
    }
    return;
  }
  g_iniSeen = true;
  if (!g_settingsLoaded || CompareFileTime(&data.ftLastWriteTime, &g_iniWriteTime) != 0) {
    g_iniWriteTime = data.ftLastWriteTime;
    LoadSettings();
    g_settingsLoaded = true;
  }
}

std::wstring ClickHint() {
  if (g_settings.ctrlClick && g_settings.altClick) return L"Ctrl+Alt+单击信号查看相关片段";
  if (g_settings.altClick) return L"Alt+单击信号查看相关片段";
  return L"Ctrl+单击信号查看相关片段";
}

std::wstring ResolveNodeExe() {
  if (!g_settings.nodeExe.empty() && _wcsicmp(g_settings.nodeExe.c_str(), L"node.exe") != 0) {
    return AbsolutePath(g_settings.nodeExe);
  }
  wchar_t found[MAX_PATH]{};
  const DWORD length = SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, found, nullptr);
  if (length > 0 && length < MAX_PATH) return found;
  return L"node.exe";
}

std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int length = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (length <= 0) return {};
  std::string result(static_cast<size_t>(length), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), length, nullptr, nullptr);
  return result;
}

std::wstring BytesToText(const std::string& bytes) {
  if (bytes.empty()) return {};
  const char* data = bytes.data();
  size_t length = bytes.size();
  if (length >= 3 && static_cast<unsigned char>(data[0]) == 0xEF &&
      static_cast<unsigned char>(data[1]) == 0xBB &&
      static_cast<unsigned char>(data[2]) == 0xBF) {
    data += 3;
    length -= 3;
  }
  int chars = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, data, static_cast<int>(length), nullptr, 0);
  if (chars > 0) {
    std::wstring result(static_cast<size_t>(chars), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, data, static_cast<int>(length), result.data(), chars);
    return result;
  }
  chars = MultiByteToWideChar(CP_ACP, 0, data, static_cast<int>(length), nullptr, 0);
  if (chars <= 0) return {};
  std::wstring result(static_cast<size_t>(chars), L'\0');
  MultiByteToWideChar(CP_ACP, 0, data, static_cast<int>(length), result.data(), chars);
  return result;
}

std::string ReadBytes(const std::wstring& path) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return {};
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size) || size.QuadPart < 0 || size.QuadPart > 64 * 1024 * 1024) {
    CloseHandle(file);
    return {};
  }
  std::string bytes(static_cast<size_t>(size.QuadPart), '\0');
  DWORD total = 0;
  while (total < bytes.size()) {
    DWORD got = 0;
    const DWORD request = static_cast<DWORD>(std::min<size_t>(bytes.size() - total, 1 << 20));
    if (!ReadFile(file, bytes.data() + total, request, &got, nullptr) || got == 0) break;
    total += got;
  }
  CloseHandle(file);
  bytes.resize(total);
  return bytes;
}

std::wstring ReadTextFile(const std::wstring& path) {
  return BytesToText(ReadBytes(path));
}

std::vector<std::wstring> SplitLines(const std::wstring& text) {
  std::vector<std::wstring> lines;
  std::wstring current;
  for (size_t i = 0; i < text.size(); ++i) {
    const wchar_t ch = text[i];
    if (ch == L'\r') {
      if (i + 1 < text.size() && text[i + 1] == L'\n') ++i;
      lines.push_back(current);
      current.clear();
    } else if (ch == L'\n') {
      lines.push_back(current);
      current.clear();
    } else {
      current.push_back(ch);
    }
  }
  if (!current.empty() || !text.empty()) lines.push_back(current);
  return lines;
}

bool IsPathWithin(const std::wstring& file, const std::wstring& root) {
  if (file.empty() || root.empty()) return false;
  std::wstring child = Lower(std::filesystem::path(file).lexically_normal().wstring());
  std::wstring parent = Lower(std::filesystem::path(root).lexically_normal().wstring());
  while (!parent.empty() && (parent.back() == L'\\' || parent.back() == L'/')) parent.pop_back();
  if (parent.empty()) return false;
  return child == parent ||
         child.rfind(parent + L"\\", 0) == 0 ||
         child.rfind(parent + L"/", 0) == 0;
}

using ScopePin = std::pair<std::wstring, std::wstring>;

std::vector<ScopePin> ReadScopePins() {
  std::vector<ScopePin> pins;
  const std::vector<std::wstring> lines = SplitLines(ReadTextFile(ScopesFilePath()));
  for (std::wstring line : lines) {
    if (!line.empty() && line.back() == L'\r') line.pop_back();
    const std::wstring trimmed = Trim(line);
    if (trimmed.empty() || trimmed.front() == L'#') continue;
    const size_t tab = trimmed.find(L'\t');
    if (tab == std::wstring::npos || tab == 0) continue;
    const std::wstring directory = Trim(trimmed.substr(0, tab));
    const std::wstring rootText = Trim(trimmed.substr(tab + 1));
    if (directory.empty()) continue;
    pins.emplace_back(AbsolutePath(directory), AbsolutePath(rootText.empty() ? directory : rootText));
  }
  return pins;
}

bool WriteScopePins(const std::vector<ScopePin>& pins) {
  std::wstring text = L"# RtlSignalPeek pinned project roots\r\n";
  for (const ScopePin& pin : pins) {
    text += pin.first + L"\t" + pin.second + L"\r\n";
  }
  const std::string bytes = WideToUtf8(text);
  HANDLE file = CreateFileW(ScopesFilePath().c_str(), GENERIC_WRITE, 0, nullptr,
                            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  const BOOL ok = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr);
  CloseHandle(file);
  return ok && written == bytes.size();
}

HWND CurrentScintilla() {
  int which = -1;
  SendMessageW(g_nppData._nppHandle, NPPM_GETCURRENTSCINTILLA, 0, reinterpret_cast<LPARAM>(&which));
  if (which == 0) return g_nppData._scintillaMainHandle;
  if (which == 1) return g_nppData._scintillaSecondHandle;
  return nullptr;
}

std::wstring CurrentFilePath() {
  std::vector<wchar_t> path(32768);
  SendMessageW(g_nppData._nppHandle, NPPM_GETFULLCURRENTPATH, path.size(), reinterpret_cast<LPARAM>(path.data()));
  return std::wstring(path.data());
}

std::wstring ReadScintillaText(HWND scintilla) {
  if (!scintilla) return {};
  const Sci_Position length = static_cast<Sci_Position>(SendMessageW(scintilla, SCI_GETTEXTLENGTH, 0, 0));
  if (length <= 0) return {};
  std::vector<char> bytes(static_cast<size_t>(length) + 1, '\0');
  Sci_TextRangeFull range{};
  range.chrg.cpMin = 0;
  range.chrg.cpMax = length;
  range.lpstrText = bytes.data();
  SendMessageW(scintilla, SCI_GETTEXTRANGEFULL, 0, reinterpret_cast<LPARAM>(&range));
  return BytesToText(std::string(bytes.data(), static_cast<size_t>(length)));
}

std::vector<std::wstring> LoadLines(const std::wstring& file, bool useLiveBuffer) {
  if (file.empty()) return {};
  if (useLiveBuffer) {
    const std::wstring current = CurrentFilePath();
    if (!current.empty() && _wcsicmp(current.c_str(), file.c_str()) == 0) {
      return SplitLines(ReadScintillaText(CurrentScintilla()));
    }
  }
  auto it = g_lineCache.find(file);
  if (it != g_lineCache.end()) return it->second;
  std::vector<std::wstring> lines = SplitLines(ReadTextFile(file));
  g_lineCache.emplace(file, lines);
  return lines;
}

std::wstring LineAt(const std::vector<std::wstring>& lines, int line) {
  if (line < 1 || static_cast<size_t>(line) > lines.size()) return {};
  return lines[static_cast<size_t>(line - 1)];
}

bool IsRtlFile(const std::wstring& path) {
  return EndsWithNoCase(path, L".v") || EndsWithNoCase(path, L".sv") ||
         EndsWithNoCase(path, L".vh") || EndsWithNoCase(path, L".svh");
}

bool ReadWordAtPosition(HWND scintilla, Sci_Position position, std::wstring& word) {
  if (!scintilla || position < 0) return false;
  const Sci_Position start = static_cast<Sci_Position>(SendMessageW(scintilla, SCI_WORDSTARTPOSITION, position, 1));
  const Sci_Position end = static_cast<Sci_Position>(SendMessageW(scintilla, SCI_WORDENDPOSITION, position, 1));
  if (end <= start) return false;
  std::vector<char> bytes(static_cast<size_t>(end - start) + 1, '\0');
  Sci_TextRangeFull range{};
  range.chrg.cpMin = start;
  range.chrg.cpMax = end;
  range.lpstrText = bytes.data();
  SendMessageW(scintilla, SCI_GETTEXTRANGEFULL, 0, reinterpret_cast<LPARAM>(&range));
  word = BytesToText(std::string(bytes.data(), static_cast<size_t>(end - start)));
  if (word.empty()) return false;
  const wchar_t first = word.front();
  return iswalpha(first) || first == L'_';
}

std::wstring KindLabel(const std::wstring& kind) {
  if (kind == L"port") return L"端口";
  if (kind == L"instance") return L"例化";
  if (kind == L"assign-lhs") return L"赋值";
  if (kind == L"assign-rhs") return L"使用";
  return L"引用";
}

std::wstring QuoteArg(const std::wstring& value) {
  if (value.empty()) return L"\"\"";
  if (value.find_first_of(L" \t\"") == std::wstring::npos) return value;
  std::wstring result = L"\"";
  for (wchar_t ch : value) {
    if (ch == L'"') result += L"\\\"";
    else result.push_back(ch);
  }
  result += L"\"";
  return result;
}

std::wstring GetTempError(const std::wstring& message) {
  return message;
}

bool RunProcessCapture(const std::wstring& application, const std::wstring& commandLine, std::string& output, std::wstring& error) {
  SECURITY_ATTRIBUTES attributes{};
  attributes.nLength = sizeof(attributes);
  attributes.bInheritHandle = TRUE;

  HANDLE readPipe = nullptr;
  HANDLE writePipe = nullptr;
  if (!CreatePipe(&readPipe, &writePipe, &attributes, 0)) {
    error = L"CreatePipe 失败";
    return false;
  }
  SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  startup.hStdOutput = writePipe;
  startup.hStdError = writePipe;
  startup.hStdInput = nullptr;

  PROCESS_INFORMATION process{};
  std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
  mutableCommand.push_back(L'\0');
  const wchar_t* app = application.empty() ? nullptr : application.c_str();
  if (!CreateProcessW(app, mutableCommand.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                      g_pluginDir.c_str(), &startup, &process)) {
    error = L"无法启动 Node 查询进程";
    CloseHandle(readPipe);
    CloseHandle(writePipe);
    return false;
  }

  CloseHandle(writePipe);
  char buffer[4096];
  DWORD got = 0;
  while (ReadFile(readPipe, buffer, sizeof(buffer), &got, nullptr) && got > 0) {
    output.append(buffer, got);
  }
  CloseHandle(readPipe);

  const DWORD wait = WaitForSingleObject(process.hProcess, 15000);
  if (wait == WAIT_TIMEOUT) {
    TerminateProcess(process.hProcess, 124);
    error = L"Node 查询超时";
  }
  DWORD exitCode = 0;
  GetExitCodeProcess(process.hProcess, &exitCode);
  CloseHandle(process.hProcess);
  CloseHandle(process.hThread);
  if (exitCode != 0) {
    if (error.empty()) error = L"Node 查询退出码 " + std::to_wstring(exitCode);
    if (output.empty()) return false;
  }
  return true;
}

std::vector<std::wstring> SplitTabs(const std::wstring& line) {
  std::vector<std::wstring> fields;
  std::wstring current;
  for (wchar_t ch : line) {
    if (ch == L'\t') {
      fields.push_back(current);
      current.clear();
    } else if (ch != L'\r') {
      current.push_back(ch);
    }
  }
  fields.push_back(current);
  return fields;
}

bool ParseQueryOutput(const std::wstring& text, QueryMeta& meta, std::vector<Location>& records) {
  records.clear();
  std::wstringstream stream(text);
  std::wstring line;
  while (std::getline(stream, line)) {
    if (!line.empty() && line.back() == L'\r') line.pop_back();
    const std::vector<std::wstring> fields = SplitTabs(line);
    if (fields.empty()) continue;
    if (fields[0] == L"META" && fields.size() >= 6) {
      meta.signal = fields[1];
      meta.module = fields[2];
      meta.instancePath = fields[3];
      meta.count = _wtoi(fields[4].c_str());
      meta.mode = fields[5];
      continue;
    }
    if (fields[0] != L"R" || fields.size() < 9) continue;
    Location location;
    location.file = fields[1];
    location.line = std::max(1, _wtoi(fields[2].c_str()));
    location.module = fields[3];
    location.instancePath = fields[4];
    location.kind = fields[5];
    location.lookupSignal = fields[6];
    location.detail = fields[7];
    location.highlightSignals = fields[8];
    records.push_back(std::move(location));
  }
  return !meta.signal.empty();
}

struct PreviewThemeStyle {
  COLORREF fore = RGB(0, 0, 0);
  COLORREF back = RGB(255, 255, 255);
  bool bold = false;
  bool italic = false;
};

struct PreviewTheme {
  PreviewThemeStyle styles[kThemeStyleCount];
  COLORREF background = RGB(255, 255, 255);
  COLORREF highlight = RGB(224, 239, 255);
};

COLORREF BlendColor(COLORREF front, COLORREF back, int frontWeight) {
  frontWeight = std::clamp(frontWeight, 0, 255);
  const int backWeight = 255 - frontWeight;
  const int red = (GetRValue(front) * frontWeight + GetRValue(back) * backWeight + 127) / 255;
  const int green = (GetGValue(front) * frontWeight + GetGValue(back) * backWeight + 127) / 255;
  const int blue = (GetBValue(front) * frontWeight + GetBValue(back) * backWeight + 127) / 255;
  return RGB(red, green, blue);
}

int ColorDistance(COLORREF a, COLORREF b) {
  int red = static_cast<int>(GetRValue(a)) - static_cast<int>(GetRValue(b));
  int green = static_cast<int>(GetGValue(a)) - static_cast<int>(GetGValue(b));
  int blue = static_cast<int>(GetBValue(a)) - static_cast<int>(GetBValue(b));
  if (red < 0) red = -red;
  if (green < 0) green = -green;
  if (blue < 0) blue = -blue;
  return red + green + blue;
}

void InitializeDefaultPreviewTheme(PreviewTheme& theme) {
  for (PreviewThemeStyle& style : theme.styles) {
    style.fore = RGB(0, 0, 0);
    style.back = RGB(255, 255, 255);
    style.bold = false;
    style.italic = false;
  }
  theme.styles[1].fore = RGB(0, 128, 0);
  theme.styles[2].fore = RGB(0, 128, 0);
  theme.styles[3].fore = RGB(0, 128, 128);
  theme.styles[4].fore = RGB(255, 128, 0);
  theme.styles[5].fore = RGB(0, 0, 255);
  theme.styles[5].bold = true;
  theme.styles[6].fore = RGB(128, 128, 128);
  theme.styles[7].fore = RGB(128, 0, 255);
  theme.styles[9].fore = RGB(128, 64, 0);
  theme.styles[10].fore = RGB(0, 0, 128);
  theme.styles[10].bold = true;
  theme.styles[11].fore = RGB(0, 0, 0);
  theme.styles[STYLE_LINENUMBER].fore = RGB(128, 128, 128);
  theme.styles[STYLE_LINENUMBER].back = RGB(228, 228, 228);
  theme.background = RGB(255, 255, 255);
  theme.highlight = RGB(224, 239, 255);
}

PreviewTheme LoadPreviewTheme() {
  PreviewTheme theme;
  InitializeDefaultPreviewTheme(theme);
  const HWND scintilla = CurrentScintilla();
  if (!scintilla) return theme;

  constexpr int usedStyles[] = {0, 5, STYLE_DEFAULT, STYLE_LINENUMBER};
  for (int style : usedStyles) {
    const COLORREF fore = static_cast<COLORREF>(SendMessageW(scintilla, SCI_STYLEGETFORE, style, 0));
    const COLORREF back = static_cast<COLORREF>(SendMessageW(scintilla, SCI_STYLEGETBACK, style, 0));
    if (fore != CLR_INVALID) theme.styles[style].fore = fore;
    if (back != CLR_INVALID) theme.styles[style].back = back;
    theme.styles[style].bold = SendMessageW(scintilla, SCI_STYLEGETBOLD, style, 0) != 0;
    theme.styles[style].italic = SendMessageW(scintilla, SCI_STYLEGETITALIC, style, 0) != 0;
  }

  theme.background = theme.styles[STYLE_DEFAULT].back;
  const COLORREF caretBack = static_cast<COLORREF>(SendMessageW(scintilla, SCI_GETCARETLINEBACK, 0, 0));
  const int caretAlpha = static_cast<int>(SendMessageW(scintilla, SCI_GETCARETLINEBACKALPHA, 0, 0));
  if (caretBack != CLR_INVALID && ColorDistance(caretBack, theme.background) > 16 && caretAlpha > 0) {
    theme.highlight = caretAlpha >= SC_ALPHA_NOALPHA
      ? caretBack
      : BlendColor(caretBack, theme.background, caretAlpha);
  } else {
    theme.highlight = BlendColor(theme.styles[5].fore, theme.background, 34);
  }
  return theme;
}

void SetPreviewRangeFormat(int start, int end, const PreviewThemeStyle& style) {
  if (!g_preview || end <= start) return;
  CHARRANGE range{start, end};
  SendMessageW(g_preview, EM_EXSETSEL, 0, reinterpret_cast<LPARAM>(&range));
  CHARFORMAT2W format{};
  format.cbSize = sizeof(format);
  format.dwMask = CFM_COLOR | CFM_BOLD | CFM_ITALIC;
  format.dwEffects = (style.bold ? CFE_BOLD : 0) | (style.italic ? CFE_ITALIC : 0);
  format.crTextColor = style.fore;
  SendMessageW(g_preview, EM_SETCHARFORMAT, SCF_SELECTION, reinterpret_cast<LPARAM>(&format));
}

constexpr WPARAM kFindDown = 0x00000001;
constexpr WPARAM kFindWholeWord = 0x00000002;
constexpr WPARAM kFindMatchCase = 0x00000004;
constexpr WPARAM kPreviewFindFlags = kFindDown | kFindWholeWord | kFindMatchCase;

void HighlightPreviewSignal(const std::wstring& signal, const PreviewThemeStyle& style) {
  if (!g_preview || signal.empty()) return;
  const LONG textLength = GetWindowTextLengthW(g_preview);
  if (textLength <= 0) return;

  FINDTEXTEXW find{};
  find.chrg.cpMin = 0;
  find.chrg.cpMax = textLength;
  find.lpstrText = const_cast<wchar_t*>(signal.c_str());
  while (find.chrg.cpMin < textLength) {
    const LRESULT found = SendMessageW(g_preview, EM_FINDTEXTEXW,
      kPreviewFindFlags,
      reinterpret_cast<LPARAM>(&find));
    if (found < 0 || find.chrgText.cpMax <= find.chrgText.cpMin) break;
    SetPreviewRangeFormat(find.chrgText.cpMin, find.chrgText.cpMax, style);
    find.chrg.cpMin = find.chrgText.cpMax;
    find.chrg.cpMax = textLength;
  }
}

void SetPreviewMessage(const std::wstring& message) {
  if (!g_preview) return;
  g_previewTargetLine = -1;
  const PreviewTheme theme = LoadPreviewTheme();
  SendMessageW(g_preview, EM_SETBKGNDCOLOR, 0, theme.background);
  SetWindowTextW(g_preview, message.c_str());
  CHARFORMAT2W format{};
  format.cbSize = sizeof(format);
  format.dwMask = CFM_FACE | CFM_SIZE | CFM_COLOR | CFM_CHARSET | CFM_BACKCOLOR;
  wcscpy_s(format.szFaceName, L"Consolas");
  format.yHeight = kPreviewFontHeight;
  format.crTextColor = theme.styles[0].fore;
  format.crBackColor = theme.background;
  format.bCharSet = DEFAULT_CHARSET;
  SendMessageW(g_preview, EM_SETCHARFORMAT, SCF_ALL, reinterpret_cast<LPARAM>(&format));
}

void ClearResults() {
  g_querySignal.clear();
  g_locations.clear();
  g_moduleColors.clear();
  g_hoverIndex = -1;
  g_previewIndex = -1;
  if (g_list) SendMessageW(g_list, LB_RESETCONTENT, 0, 0);
  if (g_header) SetWindowTextW(g_header, kPanelTitle);
  if (g_status) SetWindowTextW(g_status, ClickHint().c_str());
  if (g_preview) {
    SetPreviewMessage(L"在 RTL 源码中 " + ClickHint() + L"。\r\n\r\n"
      L"悬浮窗会列出端口、例化、赋值和使用片段；双击片段跳转到源码。");
  }
}

void LayoutPanel(HWND panel) {
  if (!panel) return;
  RECT rect{};
  GetClientRect(panel, &rect);
  const int width = std::max(1L, rect.right - rect.left);
  const int height = std::max(1L, rect.bottom - rect.top);
  const int contentTop = kPanelPadding + kHeaderHeight + 4;
  const int contentBottom = height - kPanelPadding - kStatusHeight;
  const int contentHeight = std::max(1, contentBottom - contentTop);
  const int contentWidth = std::max(1, width - kPanelPadding * 2);
  const int leftWidth = std::max(240, contentWidth * 40 / 100);
  const int rightWidth = std::max(1, contentWidth - leftWidth - kListGap);
  MoveWindow(g_header, kPanelPadding, kPanelPadding, contentWidth, kHeaderHeight, TRUE);
  MoveWindow(g_list, kPanelPadding, contentTop, leftWidth, contentHeight, TRUE);
  MoveWindow(g_preview, kPanelPadding + leftWidth + kListGap, contentTop, rightWidth, contentHeight, TRUE);
  MoveWindow(g_status, kPanelPadding, height - kPanelPadding - kStatusHeight, contentWidth, kStatusHeight, TRUE);
  if (g_previewTargetLine >= 0) CenterPreviewLine(g_previewTargetLine);
}

void PositionPopup(HWND panel) {
  if (!panel) return;
  RECT owner{};
  if (!GetWindowRect(g_nppData._nppHandle, &owner)) {
    owner.left = 0;
    owner.top = 0;
    owner.right = GetSystemMetrics(SM_CXSCREEN);
    owner.bottom = GetSystemMetrics(SM_CYSCREEN);
  }
  RECT window{};
  GetWindowRect(panel, &window);
  int width = std::max(620, static_cast<int>(window.right - window.left));
  int height = std::max(380, static_cast<int>(window.bottom - window.top));
  const POINT ownerCenter{
    owner.left + (owner.right - owner.left) / 2,
    owner.top + (owner.bottom - owner.top) / 2};
  const HMONITOR monitor = MonitorFromPoint(ownerCenter, MONITOR_DEFAULTTONEAREST);
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  RECT work{};
  if (GetMonitorInfoW(monitor, &info)) {
    work = info.rcWork;
  } else {
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  }

  width = std::min(width, std::max(400, static_cast<int>(work.right - work.left) - 16));
  height = std::min(height, std::max(300, static_cast<int>(work.bottom - work.top) - 16));
  int x = owner.left + (owner.right - owner.left - width) / 2;
  int y = owner.top + (owner.bottom - owner.top - height) / 2;
  x = std::max(static_cast<int>(work.left), std::min(x, static_cast<int>(work.right - width)));
  y = std::max(static_cast<int>(work.top), std::min(y, static_cast<int>(work.bottom - height)));
  SetWindowPos(panel, HWND_TOP, x, y, width, height, SWP_NOOWNERZORDER);
}

void ApplyPreviewFont(const PreviewTheme& theme) {
  if (!g_preview) return;
  CHARFORMAT2W format{};
  format.cbSize = sizeof(format);
  format.dwMask = CFM_FACE | CFM_SIZE | CFM_COLOR | CFM_CHARSET | CFM_BACKCOLOR;
  wcscpy_s(format.szFaceName, L"Consolas");
  format.yHeight = kPreviewFontHeight;
  format.crTextColor = theme.styles[0].fore;
  format.crBackColor = theme.background;
  format.bCharSet = DEFAULT_CHARSET;
  SendMessageW(g_preview, EM_SETCHARFORMAT, SCF_ALL, reinterpret_cast<LPARAM>(&format));
}

int PreviewLineHeightPx() {
  if (!g_preview) return 0;
  const int lineCount = static_cast<int>(SendMessageW(g_preview, EM_GETLINECOUNT, 0, 0));
  if (lineCount >= 2) {
    int probeLine = static_cast<int>(SendMessageW(g_preview, EM_GETFIRSTVISIBLELINE, 0, 0));
    probeLine = std::clamp(probeLine, 0, lineCount - 2);
    const LONG firstStart = static_cast<LONG>(SendMessageW(
      g_preview, EM_LINEINDEX, static_cast<WPARAM>(probeLine), 0));
    const LONG nextStart = static_cast<LONG>(SendMessageW(
      g_preview, EM_LINEINDEX, static_cast<WPARAM>(probeLine + 1), 0));
    if (firstStart >= 0 && nextStart > firstStart) {
      const int firstY = GET_Y_LPARAM(SendMessageW(
        g_preview, EM_POSFROMCHAR, static_cast<WPARAM>(firstStart), 0));
      const int nextY = GET_Y_LPARAM(SendMessageW(
        g_preview, EM_POSFROMCHAR, static_cast<WPARAM>(nextStart), 0));
      if (nextY > firstY) return nextY - firstY;
    }
  }

  HDC dc = GetDC(g_preview);
  if (!dc) return 0;
  HGDIOBJ oldFont = SelectObject(dc, g_codeFont ? g_codeFont : g_uiFont);
  TEXTMETRICW metrics{};
  const int lineHeight = GetTextMetricsW(dc, &metrics)
    ? metrics.tmHeight + metrics.tmExternalLeading
    : 0;
  if (oldFont) SelectObject(dc, oldFont);
  ReleaseDC(g_preview, dc);
  return lineHeight;
}

int PreviewVisibleLineCount() {
  if (!g_preview) return 1;
  RECT rect{};
  SendMessageW(g_preview, EM_GETRECT, 0, reinterpret_cast<LPARAM>(&rect));
  int height = rect.bottom - rect.top;
  if (height <= 0) {
    GetClientRect(g_preview, &rect);
    height = rect.bottom - rect.top;
  }
  const int lineHeight = PreviewLineHeightPx();
  if (height <= 0 || lineHeight <= 0) return 1;
  return std::max(1, (height + lineHeight / 2) / lineHeight);
}

void CenterPreviewLine(int targetLine) {
  if (!g_preview || targetLine < 0) return;
  const int lineCount = static_cast<int>(SendMessageW(g_preview, EM_GETLINECOUNT, 0, 0));
  if (lineCount <= 0) return;
  targetLine = std::clamp(targetLine, 0, lineCount - 1);
  const int firstVisible = static_cast<int>(SendMessageW(
    g_preview, EM_GETFIRSTVISIBLELINE, 0, 0));
  const int visibleLines = PreviewVisibleLineCount();
  const int desiredFirst = std::max(0, targetLine - visibleLines / 2);
  if (desiredFirst != firstVisible) {
    SendMessageW(g_preview, EM_LINESCROLL, 0, desiredFirst - firstVisible);
  }
}

void UpdatePreview(int index, bool force = false) {
  if (!g_preview) return;
  if (index < 0 || static_cast<size_t>(index) >= g_locations.size()) {
    g_previewIndex = -1;
    return;
  }
  if (!force && index == g_previewIndex && GetWindowTextLengthW(g_preview) > 0) return;
  g_previewIndex = index;
  const Location& location = g_locations[static_cast<size_t>(index)];
  std::vector<std::wstring> lines = LoadLines(location.file, true);
  if (lines.empty()) {
    SetPreviewMessage(L"无法读取源码文件：\r\n" + location.file);
  } else {
    const PreviewTheme theme = LoadPreviewTheme();
    const int lineCount = static_cast<int>(lines.size());
    int digits = 3;
    for (int count = lineCount; count >= 1000; count /= 10) ++digits;
    const int paddingLines = std::max(1, PreviewVisibleLineCount() + 2);
    std::wstring text;
    text.reserve(static_cast<size_t>(lineCount + paddingLines * 2) * 40);
    for (int i = 0; i < paddingLines; ++i) text += L"\r\n";
    for (int i = 0; i < lineCount; ++i) {
      const int number = i + 1;
      const std::wstring numberText = std::to_wstring(number);
      text.append(static_cast<size_t>(std::max(0, digits - static_cast<int>(numberText.size()))), L' ');
      text += numberText;
      text += (number == location.line) ? L" > " : L"   ";
      text += lines[static_cast<size_t>(i)];
      text += L"\r\n";
    }
    for (int i = 0; i < paddingLines; ++i) text += L"\r\n";

    SendMessageW(g_preview, WM_SETREDRAW, FALSE, 0);
    SendMessageW(g_preview, EM_SETBKGNDCOLOR, 0, theme.background);
    SetWindowTextW(g_preview, text.c_str());
    ApplyPreviewFont(theme);
    HighlightPreviewSignal(g_querySignal, theme.styles[5]);
    if (!location.lookupSignal.empty() && location.lookupSignal != g_querySignal) {
      HighlightPreviewSignal(location.lookupSignal, theme.styles[5]);
    }

    const int maxLine = static_cast<int>(SendMessageW(g_preview, EM_GETLINECOUNT, 0, 0));
    const int targetLine = std::max(0, std::min(location.line - 1 + paddingLines, maxLine - 1));
    const LONG start = static_cast<LONG>(SendMessageW(g_preview, EM_LINEINDEX, targetLine, 0));
    LONG end = static_cast<LONG>(SendMessageW(g_preview, EM_LINEINDEX, targetLine + 1, 0));
    if (end < 0) end = static_cast<LONG>(GetWindowTextLengthW(g_preview));
    SendMessageW(g_preview, EM_SETSEL, start, end);
    CHARFORMAT2W highlight{};
    highlight.cbSize = sizeof(highlight);
    highlight.dwMask = CFM_BACKCOLOR;
    highlight.crBackColor = theme.highlight;
    SendMessageW(g_preview, EM_SETCHARFORMAT, SCF_SELECTION, reinterpret_cast<LPARAM>(&highlight));
    SendMessageW(g_preview, EM_SETSEL, 0, 0);
    SendMessageW(g_preview, WM_SETREDRAW, TRUE, 0);
    InvalidateRect(g_preview, nullptr, TRUE);
    g_previewTargetLine = targetLine;
    CenterPreviewLine(targetLine);
  }

  if (g_status) {
    const std::wstring detail = BaseName(location.file) + L":" + std::to_wstring(location.line) +
      L"  ·  " + KindLabel(location.kind) +
      (location.module.empty() ? L"" : L"  ·  " + location.module) +
      L"  ·  双击跳转";
    SetWindowTextW(g_status, detail.c_str());
  }
}

struct CategoryBadgeColors {
  COLORREF background;
  COLORREF foreground;
  COLORREF border;
};

CategoryBadgeColors GetCategoryBadgeColors(const std::wstring& kind) {
  if (kind == L"port") return {RGB(218, 235, 252), RGB(18, 74, 132), RGB(154, 194, 234)};
  if (kind == L"instance") return {RGB(222, 244, 226), RGB(29, 104, 52), RGB(158, 207, 170)};
  if (kind == L"assign-lhs") return {RGB(255, 235, 205), RGB(133, 78, 0), RGB(231, 191, 130)};
  if (kind == L"assign-rhs") return {RGB(238, 229, 252), RGB(82, 48, 140), RGB(191, 171, 226)};
  return {RGB(236, 238, 241), RGB(75, 85, 99), RGB(196, 201, 208)};
}

constexpr COLORREF kMorandiPalette[] = {
  RGB(230, 238, 242),
  RGB(232, 239, 230),
  RGB(244, 236, 226),
  RGB(242, 230, 233),
  RGB(237, 232, 242),
  RGB(228, 240, 237),
  RGB(242, 235, 228),
  RGB(233, 235, 244),
  RGB(238, 242, 228),
  RGB(245, 233, 228),
  RGB(236, 240, 243),
  RGB(246, 241, 226),
};

std::wstring ModuleColorKey(const Location& location) {
  std::wstring key = location.module.empty() ? FileStem(location.file) : location.module;
  return Lower(key);
}

void RebuildModuleColors() {
  g_moduleColors.clear();
  std::vector<std::wstring> keys;
  for (const Location& location : g_locations) {
    const std::wstring key = ModuleColorKey(location);
    if (g_moduleColors.emplace(key, RGB(0, 0, 0)).second) keys.push_back(key);
  }
  std::sort(keys.begin(), keys.end());
  constexpr size_t paletteSize = sizeof(kMorandiPalette) / sizeof(kMorandiPalette[0]);
  for (size_t i = 0; i < keys.size(); ++i) {
    g_moduleColors[keys[i]] = kMorandiPalette[i % paletteSize];
  }
}

COLORREF ModuleBackgroundColor(const Location& location) {
  const auto found = g_moduleColors.find(ModuleColorKey(location));
  if (found != g_moduleColors.end()) return found->second;
  return kMorandiPalette[0];
}

void DrawCategoryBadge(HDC dc, const RECT& rect, const std::wstring& kind, HFONT font) {
  const CategoryBadgeColors colors = GetCategoryBadgeColors(kind);
  HBRUSH brush = CreateSolidBrush(colors.background);
  HPEN pen = CreatePen(PS_SOLID, 1, colors.border);
  HGDIOBJ oldBrush = SelectObject(dc, brush);
  HGDIOBJ oldPen = SelectObject(dc, pen);
  RoundRect(dc, rect.left, rect.top, rect.right, rect.bottom, 10, 10);
  SelectObject(dc, oldPen);
  SelectObject(dc, oldBrush);
  DeleteObject(pen);
  DeleteObject(brush);

  SetTextColor(dc, colors.foreground);
  HGDIOBJ oldFont = SelectObject(dc, font ? font : g_boldFont);
  RECT textRect = rect;
  DrawTextW(dc, KindLabel(kind).c_str(), -1, &textRect,
    DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  SelectObject(dc, oldFont);
}

void DrawListItem(const DRAWITEMSTRUCT* draw) {
  if (!draw || !g_list) return;
  const int index = static_cast<int>(draw->itemData);
  if (index < 0 || static_cast<size_t>(index) >= g_locations.size()) return;
  const Location& location = g_locations[static_cast<size_t>(index)];
  RECT rect = draw->rcItem;
  const bool selected = (draw->itemState & ODS_SELECTED) != 0;
  const bool hovered = index == g_hoverIndex;
  const COLORREF moduleBackground = ModuleBackgroundColor(location);
  const COLORREF rowBackground = selected
    ? RGB(43, 58, 74)
    : (hovered ? BlendColor(RGB(255, 255, 255), moduleBackground, 56) : moduleBackground);
  HBRUSH brush = CreateSolidBrush(rowBackground);
  FillRect(draw->hDC, &rect, brush);
  DeleteObject(brush);

  RECT accent = rect;
  accent.right = accent.left + 3;
  HBRUSH accentBrush = CreateSolidBrush(selected
    ? RGB(214, 169, 88)
    : BlendColor(RGB(80, 95, 112), moduleBackground, 41));
  FillRect(draw->hDC, &accent, accentBrush);
  DeleteObject(accentBrush);

  SetBkMode(draw->hDC, TRANSPARENT);
  const COLORREF primaryText = selected ? RGB(248, 250, 252) : RGB(44, 54, 70);
  const COLORREF secondaryText = selected ? RGB(199, 211, 223) : RGB(105, 115, 126);
  const COLORREF lineNumberText = selected ? RGB(240, 198, 119) : RGB(74, 86, 99);
  SetTextColor(draw->hDC, primaryText);

  RECT badgeRect = rect;
  badgeRect.left += 8;
  badgeRect.right = badgeRect.left + kCategoryBadgeWidth;
  badgeRect.top += 4;
  badgeRect.bottom = badgeRect.top + 18;
  DrawCategoryBadge(draw->hDC, badgeRect, location.kind, g_boldFont ? g_boldFont : g_uiFont);

  RECT titleRect = rect;
  titleRect.left = badgeRect.right + 8;
  titleRect.right -= 8;
  titleRect.top += 2;
  titleRect.bottom = titleRect.top + 18;

  const std::wstring fileStem = FileStem(location.file);
  const std::wstring moduleName = location.module.empty() ? fileStem : location.module;
  const std::wstring fileName = BaseName(location.file);
  const bool showFile = _wcsicmp(moduleName.c_str(), fileStem.c_str()) != 0;

  RECT lineRect = titleRect;
  lineRect.left = std::max(titleRect.left + 60, titleRect.right - 52);
  RECT fileRect = titleRect;
  fileRect.right = lineRect.left - 6;
  fileRect.left = std::min(fileRect.right, titleRect.left + 110);
  RECT moduleRect = titleRect;
  moduleRect.right = (showFile ? fileRect.left : lineRect.left) - 6;
  if (moduleRect.right <= moduleRect.left) {
    moduleRect.right = std::min(titleRect.right, moduleRect.left + 48);
  }

  HGDIOBJ oldFont = SelectObject(draw->hDC, g_boldFont ? g_boldFont : g_uiFont);
  SetTextColor(draw->hDC, primaryText);
  DrawTextW(draw->hDC, moduleName.c_str(), -1, &moduleRect,
    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);

  if (showFile) {
    SelectObject(draw->hDC, g_uiFont ? g_uiFont : g_boldFont);
    SetTextColor(draw->hDC, secondaryText);
    DrawTextW(draw->hDC, fileName.c_str(), -1, &fileRect,
      DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
  }

  const std::wstring lineText = std::to_wstring(location.line);
  SelectObject(draw->hDC, g_boldFont ? g_boldFont : g_uiFont);
  SetTextColor(draw->hDC, lineNumberText);
  DrawTextW(draw->hDC, lineText.c_str(), -1, &lineRect,
    DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX);

  SelectObject(draw->hDC, g_codeFont ? g_codeFont : g_uiFont);
  SetTextColor(draw->hDC, primaryText);

  std::vector<std::wstring> lines = LoadLines(location.file, true);
  const int firstLine = std::max(1, location.line - 1);
  RECT codeRect = rect;
  codeRect.left += 10;
  codeRect.right -= 8;
  codeRect.top += 25;
  codeRect.bottom = codeRect.top + 13;
  for (int delta = 0; delta < 3; ++delta) {
    const int number = firstLine + delta;
    std::wstring text = (number == location.line) ? L"> " : L"  ";
    text += std::to_wstring(number);
    text += L"  ";
    text += LineAt(lines, number);
    DrawTextW(draw->hDC, text.c_str(), -1, &codeRect, DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
    codeRect.top += 13;
    codeRect.bottom += 13;
  }
  SelectObject(draw->hDC, oldFont);
}

bool SameFilePath(const std::wstring& left, const std::wstring& right) {
  if (left.empty() || right.empty()) return false;
  const std::wstring normalizedLeft = Lower(std::filesystem::path(left).lexically_normal().wstring());
  const std::wstring normalizedRight = Lower(std::filesystem::path(right).lexically_normal().wstring());
  return normalizedLeft == normalizedRight;
}

void CenterLineInEditor(HWND scintilla, int line) {
  if (!scintilla || line <= 0) return;
  const int targetLine = line - 1;
  SendMessageW(scintilla, SCI_GOTOLINE, static_cast<WPARAM>(targetLine), 0);
  SendMessageW(scintilla, SCI_SCROLLCARET, 0, 0);
  const int targetVisibleLine = static_cast<int>(
    SendMessageW(scintilla, SCI_VISIBLEFROMDOCLINE, static_cast<WPARAM>(targetLine), 0));
  const int linesOnScreen = static_cast<int>(SendMessageW(scintilla, SCI_LINESONSCREEN, 0, 0));
  if (targetVisibleLine >= 0 && linesOnScreen > 0) {
    const int firstVisible = std::max(0, targetVisibleLine - linesOnScreen / 2);
    SendMessageW(scintilla, SCI_SETFIRSTVISIBLELINE, static_cast<WPARAM>(firstVisible), 0);
    RedrawWindow(scintilla, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
  }
}

void HandleCenterTimer(HWND panel) {
  if (g_pendingCenterLine <= 0) {
    KillTimer(panel, kCenterTimerId);
    return;
  }
  if (SameFilePath(CurrentFilePath(), g_pendingCenterFile)) {
    CenterLineInEditor(CurrentScintilla(), g_pendingCenterLine);
    g_pendingCenterFile.clear();
    g_pendingCenterLine = 0;
    g_pendingCenterAttempts = 0;
    KillTimer(panel, kCenterTimerId);
    return;
  }
  if (++g_pendingCenterAttempts >= 12) {
    g_pendingCenterFile.clear();
    g_pendingCenterLine = 0;
    g_pendingCenterAttempts = 0;
    KillTimer(panel, kCenterTimerId);
  }
}

void OpenLocation(int index) {
  if (index < 0 || static_cast<size_t>(index) >= g_locations.size()) return;
  const Location& location = g_locations[static_cast<size_t>(index)];
  if (location.file.empty() || !FileExists(location.file)) return;
  SendMessageW(g_nppData._nppHandle, NPPM_DOOPEN, 0, reinterpret_cast<LPARAM>(location.file.c_str()));
  HWND scintilla = CurrentScintilla();
  const bool sameFile = SameFilePath(CurrentFilePath(), location.file);
  if (scintilla && sameFile) CenterLineInEditor(scintilla, location.line);

  g_pendingCenterFile = location.file;
  g_pendingCenterLine = location.line;
  g_pendingCenterAttempts = 0;
  if (g_panel) {
    KillTimer(g_panel, kCenterTimerId);
    SetTimer(g_panel, kCenterTimerId, 80, nullptr);
  }
  if (scintilla && sameFile) SetFocus(scintilla);
}

void PopulateResults(const QueryMeta& meta) {
  g_querySignal = meta.signal;
  RebuildModuleColors();
  if (g_list) {
    SendMessageW(g_list, LB_RESETCONTENT, 0, 0);
    for (size_t i = 0; i < g_locations.size(); ++i) {
      const LRESULT item = SendMessageW(g_list, LB_ADDSTRING, 0, reinterpret_cast<LPARAM>(kListPlaceholder));
      SendMessageW(g_list, LB_SETITEMDATA, static_cast<WPARAM>(item), static_cast<LPARAM>(i));
    }
  }
  if (g_header) {
    std::wstring header = meta.signal;
    if (!meta.module.empty()) header += L"  ·  " + meta.module;
    header += L"  ·  " + std::to_wstring(g_locations.size()) + L" 处片段";
    SetWindowTextW(g_header, header.c_str());
  }
  if (g_status) SetWindowTextW(g_status, meta.mode.c_str());
  if (g_list && !g_locations.empty()) {
    SendMessageW(g_list, LB_SETCURSEL, 0, 0);
    UpdatePreview(0);
  } else if (g_preview) {
    SetPreviewMessage(L"没有找到该信号的相关源码片段。");
  }
  if (g_list) InvalidateRect(g_list, nullptr, TRUE);
}

void QuerySignal(const std::wstring& signal, const std::wstring& file, int line) {
  if (g_header) SetWindowTextW(g_header, (signal + L"  ·  正在查询…").c_str());
  if (g_status) SetWindowTextW(g_status, L"正在识别工程范围并生成源码片段");
  if (g_preview) SetPreviewMessage(L"正在查询 " + signal + L" 的端口、例化、赋值和使用位置…");
  ClearResults();
  if (g_header) SetWindowTextW(g_header, (signal + L"  ·  正在查询…").c_str());
  if (g_status) SetWindowTextW(g_status, L"正在识别工程范围并生成源码片段");
  UpdateWindow(g_panel);
  g_lineCache.clear();

  if (!FileExists(g_settings.queryScript)) {
    SetPreviewMessage(L"找不到查询脚本：\r\n" + g_settings.queryScript + L"\r\n\r\n请检查 RtlSignalPeek.ini。");
    return;
  }
  const std::wstring node = ResolveNodeExe();
  std::wstring commandLine = QuoteArg(node) + L" " +
    QuoteArg(g_settings.queryScript) + L" --file " + QuoteArg(file) +
    L" --line " + std::to_wstring(line) +
    L" --signal " + QuoteArg(signal) +
    L" --netgraph " + QuoteArg(g_settings.netgraphDir) +
    L" --source-roots " + QuoteArg(JoinPathList(g_settings.sourceRoots)) +
    L" --netgraph-source-root " + QuoteArg(g_settings.netgraphSourceRoot) +
    L" --top " + QuoteArg(g_settings.topModule) +
    L" --up-levels " + std::to_wstring(g_settings.upLevels) +
    L" --down-levels " + std::to_wstring(g_settings.downLevels) +
    L" --max-files " + std::to_wstring(g_settings.maxFiles) +
    L" --max-index-ms " + std::to_wstring(g_settings.maxIndexMs) +
    L" --exclude-dirs " + QuoteArg(g_settings.excludeDirs) +
    L" --scopes-file " + QuoteArg(ScopesFilePath());

  std::string output;
  std::wstring error;
  if (!RunProcessCapture(node, commandLine, output, error)) {
    SetPreviewMessage(L"查询失败：\r\n" + error + L"\r\n\r\n命令：\r\n" + commandLine);
    if (g_status) SetWindowTextW(g_status, error.c_str());
    return;
  }

  QueryMeta meta;
  std::vector<Location> records;
  if (!ParseQueryOutput(BytesToText(output), meta, records)) {
    const std::wstring text = BytesToText(output);
    SetPreviewMessage(L"查询返回了无法解析的结果。\r\n\r\n" + (text.empty() ? error : text));
    if (g_status) SetWindowTextW(g_status, L"查询结果解析失败");
    return;
  }
  g_locations = std::move(records);
  if (g_list) {
    SendMessageW(g_list, LB_SETITEMHEIGHT, 0, kListItemHeight);
    PopulateResults(meta);
  }
}

void ShowPanel() {
  if (!g_panel) return;
  PositionPopup(g_panel);
  ShowWindow(g_panel, SW_SHOWNORMAL);
  SetWindowPos(g_panel, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
  SetForegroundWindow(g_panel);
  if (g_list) SetFocus(g_list);
}

void HidePanel() {
  if (g_panel && IsWindowVisible(g_panel)) ShowWindow(g_panel, SW_HIDE);
}

void ShowSignalPeek(const std::wstring& signal, const std::wstring& file, int line) {
  if (signal.empty()) return;
  LoadSettingsIfChanged();
  if (!CreatePanel()) return;
  ShowPanel();
  QuerySignal(signal, file, line);
}

LRESULT CALLBACK ListSubclassProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  if (message == WM_KEYDOWN && wParam == VK_ESCAPE) {
    HidePanel();
    return 0;
  }
  WNDPROC original = g_oldListProc;
  const LRESULT result = original ? CallWindowProcW(original, hwnd, message, wParam, lParam) : DefWindowProcW(hwnd, message, wParam, lParam);
  if (message == WM_MOUSEMOVE) {
    if (!g_trackingListMouse) {
      TRACKMOUSEEVENT track{};
      track.cbSize = sizeof(track);
      track.dwFlags = TME_LEAVE;
      track.hwndTrack = hwnd;
      TrackMouseEvent(&track);
      g_trackingListMouse = true;
    }
    POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
    const LRESULT hit = SendMessageW(hwnd, LB_ITEMFROMPOINT, 0, MAKELPARAM(point.x, point.y));
    const int index = HIWORD(hit) ? -1 : static_cast<int>(LOWORD(hit));
    if (index != g_hoverIndex || (index >= 0 && index != g_previewIndex)) {
      const int oldHover = g_hoverIndex;
      g_hoverIndex = index;
      if (oldHover >= 0) InvalidateRect(hwnd, nullptr, FALSE);
      InvalidateRect(hwnd, nullptr, FALSE);
      if (index >= 0) UpdatePreview(index);
    }
  } else if (message == WM_MOUSELEAVE) {
    g_trackingListMouse = false;
    g_hoverIndex = -1;
    InvalidateRect(hwnd, nullptr, FALSE);
    const int selected = static_cast<int>(SendMessageW(hwnd, LB_GETCURSEL, 0, 0));
    if (selected >= 0) UpdatePreview(selected);
  } else if (message == WM_KEYDOWN && wParam == VK_RETURN) {
    const int selected = static_cast<int>(SendMessageW(hwnd, LB_GETCURSEL, 0, 0));
    if (selected >= 0) OpenLocation(selected);
  }
  return result;
}

LRESULT CALLBACK PreviewSubclassProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  if (message == WM_KEYDOWN && wParam == VK_ESCAPE) {
    HidePanel();
    return 0;
  }
  if (g_oldPreviewProc) return CallWindowProcW(g_oldPreviewProc, hwnd, message, wParam, lParam);
  return DefWindowProcW(hwnd, message, wParam, lParam);
}

LRESULT CALLBACK PanelProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_ACTIVATE:
      if (LOWORD(wParam) == WA_INACTIVE) {
        HidePanel();
        return 0;
      }
      break;
    case WM_CLOSE:
      HidePanel();
      return 0;
    case WM_KEYDOWN:
      if (wParam == VK_ESCAPE) {
        HidePanel();
        return 0;
      }
      break;
    case WM_TIMER:
      if (wParam == kCenterTimerId) {
        HandleCenterTimer(hwnd);
        return 0;
      }
      break;
    case WM_SIZE:
      LayoutPanel(hwnd);
      return 0;
    case WM_EXITSIZEMOVE:
      if (g_previewIndex >= 0 && static_cast<size_t>(g_previewIndex) < g_locations.size()) {
        UpdatePreview(g_previewIndex, true);
      }
      return 0;
    case WM_ERASEBKGND: {
      RECT rect{};
      GetClientRect(hwnd, &rect);
      FillRect(reinterpret_cast<HDC>(wParam), &rect, g_backgroundBrush);
      return 1;
    }
    case WM_CTLCOLORSTATIC: {
      HDC hdc = reinterpret_cast<HDC>(wParam);
      SetBkMode(hdc, TRANSPARENT);
      SetTextColor(hdc, RGB(45, 55, 72));
      return reinterpret_cast<LRESULT>(g_backgroundBrush);
    }
    case WM_DRAWITEM:
      DrawListItem(reinterpret_cast<DRAWITEMSTRUCT*>(lParam));
      return TRUE;
    case WM_COMMAND:
      if (LOWORD(wParam) == kIdList) {
        const int notification = HIWORD(wParam);
        if (notification == LBN_SELCHANGE) {
          const int selected = static_cast<int>(SendMessageW(g_list, LB_GETCURSEL, 0, 0));
          if (selected >= 0) UpdatePreview(selected);
        } else if (notification == LBN_DBLCLK) {
          const int selected = static_cast<int>(SendMessageW(g_list, LB_GETCURSEL, 0, 0));
          if (selected >= 0) OpenLocation(selected);
        }
      }
      return 0;
    default:
      break;
  }
  return DefWindowProcW(hwnd, message, wParam, lParam);
}

bool LoadRichEdit() {
  if (GetModuleHandleW(L"Msftedit.dll") || LoadLibraryW(L"Msftedit.dll")) {
    g_richClass = L"RICHEDIT50W";
    return true;
  }
  if (GetModuleHandleW(L"Riched20.dll") || LoadLibraryW(L"Riched20.dll")) {
    g_richClass = L"RICHEDIT20W";
    return true;
  }
  return false;
}

void CreateFonts() {
  if (!g_uiFont) {
    g_uiFont = CreateFontW(-14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
      OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
  }
  if (!g_boldFont) {
    g_boldFont = CreateFontW(-14, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
      OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
  }
  if (!g_codeFont) {
    g_codeFont = CreateFontW(-11, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
      OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, FIXED_PITCH | FF_MODERN, L"Consolas");
  }
  if (!g_smallFont) {
    g_smallFont = CreateFontW(-11, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
      OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Microsoft YaHei UI");
  }
}

bool CreatePanel() {
  if (g_panel) return true;
  if (!LoadRichEdit()) return false;
  CreateFonts();
  if (!g_backgroundBrush) g_backgroundBrush = CreateSolidBrush(RGB(250, 251, 253));
  if (!g_hoverBrush) g_hoverBrush = CreateSolidBrush(RGB(241, 247, 254));
  if (!g_selectedBrush) g_selectedBrush = CreateSolidBrush(RGB(218, 235, 252));

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = PanelProc;
  wc.hInstance = g_instance;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = g_backgroundBrush;
  wc.lpszClassName = kPanelClass;
  RegisterClassExW(&wc);

  g_panel = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_CONTROLPARENT, kPanelClass, kPanelTitle,
    WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
    0, 0, 1200, 560, g_nppData._nppHandle, nullptr, g_instance, nullptr);
  if (!g_panel) return false;

  g_header = CreateWindowExW(0, L"STATIC", kPanelTitle,
    WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX,
    0, 0, 0, 0, g_panel, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kIdHeader)), g_instance, nullptr);
  g_status = CreateWindowExW(0, L"STATIC", ClickHint().c_str(),
    WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX,
    0, 0, 0, 0, g_panel, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kIdStatus)), g_instance, nullptr);
  g_list = CreateWindowExW(WS_EX_CLIENTEDGE, L"LISTBOX", L"",
    WS_CHILD | WS_VISIBLE | WS_TABSTOP | LBS_NOTIFY | LBS_OWNERDRAWFIXED | LBS_HASSTRINGS | WS_VSCROLL,
    0, 0, 0, 0, g_panel, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kIdList)), g_instance, nullptr);
  g_preview = CreateWindowExW(WS_EX_CLIENTEDGE, g_richClass.c_str(), L"",
    WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL,
    0, 0, 0, 0, g_panel, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kIdPreview)), g_instance, nullptr);
  if (!g_header || !g_status || !g_list || !g_preview) return false;

  SendMessageW(g_header, WM_SETFONT, reinterpret_cast<WPARAM>(g_boldFont), TRUE);
  SendMessageW(g_status, WM_SETFONT, reinterpret_cast<WPARAM>(g_smallFont), TRUE);
  SendMessageW(g_list, WM_SETFONT, reinterpret_cast<WPARAM>(g_uiFont), TRUE);
  const PreviewTheme theme = LoadPreviewTheme();
  SendMessageW(g_preview, EM_SETBKGNDCOLOR, 0, theme.background);
  SendMessageW(g_preview, EM_SETREADONLY, TRUE, 0);
  SendMessageW(g_preview, EM_SETTARGETDEVICE, 0, 0);
  ApplyPreviewFont(theme);
  SendMessageW(g_list, LB_SETITEMHEIGHT, 0, kListItemHeight);

  g_oldListProc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(g_list, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(ListSubclassProc)));
  g_oldPreviewProc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(g_preview, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(PreviewSubclassProc)));
  LayoutPanel(g_panel);

  ClearResults();
  return true;
}

bool HandleModifierClick(HWND scintilla, WPARAM wParam, LPARAM lParam) {
  if (!scintilla) return false;
  LoadSettingsIfChanged();
  const bool ctrl = (wParam & MK_CONTROL) != 0 || (GetKeyState(VK_CONTROL) & 0x8000) != 0;
  const bool alt = (GetKeyState(VK_MENU) & 0x8000) != 0;
  const bool ctrlConfigured = g_settings.ctrlClick && ctrl;
  const bool altConfigured = g_settings.altClick && alt;
  const bool modifierActive = g_settings.requireBothModifiers
    ? (ctrlConfigured && altConfigured)
    : (ctrlConfigured || altConfigured);
  if (!modifierActive) return false;
  const std::wstring file = CurrentFilePath();
  if (!IsRtlFile(file)) return false;
  const int x = GET_X_LPARAM(lParam);
  const int y = GET_Y_LPARAM(lParam);
  const Sci_Position position = static_cast<Sci_Position>(SendMessageW(scintilla, SCI_POSITIONFROMPOINTCLOSE, x, y));
  if (position < 0) return false;
  std::wstring word;
  if (!ReadWordAtPosition(scintilla, position, word)) return false;
  POINT anchor{x, y};
  if (ClientToScreen(scintilla, &anchor)) {
    g_popupAnchor = anchor;
    g_hasPopupAnchor = true;
  }
  const Sci_Position line = static_cast<Sci_Position>(SendMessageW(scintilla, SCI_LINEFROMPOSITION, position, 0));
  ShowSignalPeek(word, file, static_cast<int>(line) + 1);
  return true;
}

LRESULT CALLBACK ScintillaProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  if (message == WM_LBUTTONDOWN) {
    try {
      if (HandleModifierClick(hwnd, wParam, lParam)) return 0;
    } catch (...) {
    }
    HidePanel();
  }
  auto it = g_scintillaProc.find(hwnd);
  if (it != g_scintillaProc.end()) return CallWindowProcW(it->second, hwnd, message, wParam, lParam);
  return DefWindowProcW(hwnd, message, wParam, lParam);
}

void InstallScintillaHook() {
  const HWND handles[] = {g_nppData._scintillaMainHandle, g_nppData._scintillaSecondHandle};
  for (HWND hwnd : handles) {
    if (!hwnd || g_scintillaProc.count(hwnd)) continue;
    WNDPROC original = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(ScintillaProc)));
    if (original) g_scintillaProc[hwnd] = original;
  }
}

void PeekAtCaret() {
  HWND scintilla = CurrentScintilla();
  if (!scintilla) return;
  const std::wstring file = CurrentFilePath();
  if (!IsRtlFile(file)) return;
  const Sci_Position position = static_cast<Sci_Position>(SendMessageW(scintilla, SCI_GETCURRENTPOS, 0, 0));
  std::wstring word;
  if (!ReadWordAtPosition(scintilla, position, word)) return;
  const int x = static_cast<int>(SendMessageW(scintilla, SCI_POINTXFROMPOSITION, 0, position));
  const int y = static_cast<int>(SendMessageW(scintilla, SCI_POINTYFROMPOSITION, 0, position));
  POINT anchor{x, y};
  if (ClientToScreen(scintilla, &anchor)) {
    g_popupAnchor = anchor;
    g_hasPopupAnchor = true;
  }
  const Sci_Position line = static_cast<Sci_Position>(SendMessageW(scintilla, SCI_LINEFROMPOSITION, position, 0));
  ShowSignalPeek(word, file, static_cast<int>(line) + 1);
}

void ShowPanelCommand() {
  if (!CreatePanel()) return;
  ShowPanel();
}

void PinCurrentProjectRoot() {
  const std::wstring file = CurrentFilePath();
  if (!IsRtlFile(file)) {
    MessageBoxW(g_nppData._nppHandle, L"请先打开一个 .v / .sv 文件。",
                L"RTL Signal Peek", MB_OK | MB_ICONINFORMATION);
    return;
  }
  const std::wstring directory = ParentPath(file);
  if (directory.empty()) return;
  std::vector<ScopePin> pins = ReadScopePins();
  const std::wstring lowerDirectory = Lower(directory);
  pins.erase(std::remove_if(pins.begin(), pins.end(), [&](const ScopePin& pin) {
    return Lower(pin.first) == lowerDirectory;
  }), pins.end());
  pins.emplace_back(directory, directory);
  if (!WriteScopePins(pins)) {
    MessageBoxW(g_nppData._nppHandle,
                (L"无法写入固定工程根文件：\r\n" + ScopesFilePath()).c_str(),
                L"RTL Signal Peek", MB_OK | MB_ICONERROR);
    return;
  }
  MessageBoxW(g_nppData._nppHandle,
              (L"已固定工程根：\r\n" + directory +
               L"\r\n\r\n下次查询会以该目录为起点，按 upLevels/downLevels 搜索。").c_str(),
              L"RTL Signal Peek", MB_OK | MB_ICONINFORMATION);
}

void ClearCurrentProjectRoot() {
  const std::wstring file = CurrentFilePath();
  std::vector<ScopePin> pins = ReadScopePins();
  size_t best = static_cast<size_t>(-1);
  size_t bestLength = 0;
  for (size_t i = 0; i < pins.size(); ++i) {
    if (!IsPathWithin(file, pins[i].first)) continue;
    if (pins[i].first.size() > bestLength) {
      best = i;
      bestLength = pins[i].first.size();
    }
  }
  if (best == static_cast<size_t>(-1)) {
    MessageBoxW(g_nppData._nppHandle, L"当前文件没有固定的工程根。",
                L"RTL Signal Peek", MB_OK | MB_ICONINFORMATION);
    return;
  }
  const std::wstring removed = pins[best].first;
  pins.erase(pins.begin() + static_cast<std::ptrdiff_t>(best));
  if (!WriteScopePins(pins)) {
    MessageBoxW(g_nppData._nppHandle,
                (L"无法写入固定工程根文件：\r\n" + ScopesFilePath()).c_str(),
                L"RTL Signal Peek", MB_OK | MB_ICONERROR);
    return;
  }
  MessageBoxW(g_nppData._nppHandle,
              (L"已清除固定工程根：\r\n" + removed).c_str(),
              L"RTL Signal Peek", MB_OK | MB_ICONINFORMATION);
}

void SetSettingsControlFont(HWND control, HFONT font = nullptr) {
  if (!control) return;
  SendMessageW(control, WM_SETFONT,
               reinterpret_cast<WPARAM>(font ? font : (g_uiFont ? g_uiFont : GetStockObject(DEFAULT_GUI_FONT))),
               TRUE);
}

HWND AddSettingsLabel(HWND parent, const wchar_t* text, int x, int y, int width, int height, HFONT font = nullptr) {
  HWND control = CreateWindowExW(0, L"STATIC", text,
    WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX,
    x, y, width, height, parent, nullptr, g_instance, nullptr);
  SetSettingsControlFont(control, font);
  return control;
}

HWND AddSettingsEdit(HWND parent, int id, int x, int y, int width, DWORD extraStyle = 0) {
  HWND control = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
    WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL | extraStyle,
    x, y, width, 24, parent, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), g_instance, nullptr);
  SetSettingsControlFont(control);
  return control;
}

HWND AddSettingsButton(HWND parent, int id, const wchar_t* text, int x, int y, int width, bool defaultButton) {
  HWND control = CreateWindowExW(0, L"BUTTON", text,
    WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON | (defaultButton ? BS_DEFPUSHBUTTON : 0),
    x, y, width, 28, parent, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), g_instance, nullptr);
  SetSettingsControlFont(control);
  return control;
}

std::wstring SettingsControlText(HWND hwnd, int id) {
  HWND control = GetDlgItem(hwnd, id);
  if (!control) return {};
  const int length = GetWindowTextLengthW(control);
  std::vector<wchar_t> buffer(static_cast<size_t>(length) + 1, L'\0');
  GetWindowTextW(control, buffer.data(), static_cast<int>(buffer.size()));
  return Trim(std::wstring(buffer.data()));
}

bool ReadSettingsInt(HWND hwnd, int id, const wchar_t* label, int minValue, int maxValue, int& value) {
  BOOL translated = FALSE;
  const UINT number = GetDlgItemInt(hwnd, id, &translated, FALSE);
  if (!translated || number < static_cast<UINT>(minValue) || number > static_cast<UINT>(maxValue)) {
    const std::wstring message = std::wstring(L"“") + label + L"”必须是 " +
      std::to_wstring(minValue) + L"–" + std::to_wstring(maxValue) + L" 之间的整数。";
    MessageBoxW(hwnd, message.c_str(), L"RTL Signal Peek", MB_OK | MB_ICONWARNING);
    SetFocus(GetDlgItem(hwnd, id));
    return false;
  }
  value = static_cast<int>(number);
  return true;
}

void ResetSettingsDialog(HWND hwnd) {
  SetWindowTextW(GetDlgItem(hwnd, kIdSettingsUpLevels), L"2");
  SetWindowTextW(GetDlgItem(hwnd, kIdSettingsDownLevels), L"8");
  SetWindowTextW(GetDlgItem(hwnd, kIdSettingsMaxFiles), L"2000");
  SetWindowTextW(GetDlgItem(hwnd, kIdSettingsMaxIndexMs), L"2000");
  SetWindowTextW(GetDlgItem(hwnd, kIdSettingsExcludeDirs), L"archive;backup;doc;ai_output;.Xil");
  SendMessageW(GetDlgItem(hwnd, kIdSettingsClickModifier), CB_SETCURSEL, 0, 0);
  SetFocus(GetDlgItem(hwnd, kIdSettingsUpLevels));
}

void SaveSettingsDialog(HWND hwnd) {
  int upLevels = 0;
  int downLevels = 0;
  int maxFiles = 0;
  int maxIndexMs = 0;
  if (!ReadSettingsInt(hwnd, kIdSettingsUpLevels, L"向上层数", 0, 8, upLevels) ||
      !ReadSettingsInt(hwnd, kIdSettingsDownLevels, L"向下层数", 0, 32, downLevels) ||
      !ReadSettingsInt(hwnd, kIdSettingsMaxFiles, L"最大文件数", 10, 20000, maxFiles) ||
      !ReadSettingsInt(hwnd, kIdSettingsMaxIndexMs, L"索引时间预算（毫秒）", 100, 15000, maxIndexMs)) {
    return;
  }

  const std::wstring excludeDirs = SettingsControlText(hwnd, kIdSettingsExcludeDirs);
  const int modifierIndex = static_cast<int>(SendMessageW(
    GetDlgItem(hwnd, kIdSettingsClickModifier), CB_GETCURSEL, 0, 0));
  const wchar_t* modifier = modifierIndex == 1 ? L"Alt" : (modifierIndex == 2 ? L"Ctrl+Alt" : L"Ctrl");

  const auto writeValue = [](const wchar_t* key, const std::wstring& value) {
    return WritePrivateProfileStringW(L"rtl", key, value.c_str(), IniPath().c_str()) != FALSE;
  };
  bool saved = writeValue(L"upLevels", std::to_wstring(upLevels));
  saved = writeValue(L"downLevels", std::to_wstring(downLevels)) && saved;
  saved = writeValue(L"maxFiles", std::to_wstring(maxFiles)) && saved;
  saved = writeValue(L"maxIndexMs", std::to_wstring(maxIndexMs)) && saved;
  saved = writeValue(L"excludeDirs", excludeDirs) && saved;
  saved = writeValue(L"clickModifier", modifier) && saved;
  if (!saved) {
    MessageBoxW(hwnd,
      (L"无法写入配置文件：\r\n" + IniPath() +
       L"\r\n\r\n请检查文件是否只读，或确认当前用户有写入权限。").c_str(),
      L"RTL Signal Peek", MB_OK | MB_ICONERROR);
    return;
  }

  LoadSettings();
  g_settingsLoaded = true;
  g_iniSeen = true;
  WIN32_FILE_ATTRIBUTE_DATA data{};
  if (GetFileAttributesExW(IniPath().c_str(), GetFileExInfoStandard, &data)) {
    g_iniWriteTime = data.ftLastWriteTime;
  }
  DestroyWindow(hwnd);
}

LRESULT CALLBACK SettingsProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_COMMAND: {
      const int id = LOWORD(wParam);
      if (id == IDOK) {
        SaveSettingsDialog(hwnd);
        return 0;
      }
      if (id == IDCANCEL) {
        DestroyWindow(hwnd);
        return 0;
      }
      if (id == kIdSettingsDefaults) {
        ResetSettingsDialog(hwnd);
        return 0;
      }
      break;
    }
    case WM_KEYDOWN:
      if (wParam == VK_ESCAPE) {
        DestroyWindow(hwnd);
        return 0;
      }
      if (wParam == VK_RETURN) {
        SaveSettingsDialog(hwnd);
        return 0;
      }
      break;
    case WM_CLOSE:
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      g_settingsWindow = nullptr;
      return 0;
    case WM_CTLCOLORSTATIC: {
      HDC dc = reinterpret_cast<HDC>(wParam);
      SetBkMode(dc, TRANSPARENT);
      SetTextColor(dc, RGB(45, 55, 72));
      return reinterpret_cast<LRESULT>(GetSysColorBrush(COLOR_BTNFACE));
    }
    default:
      break;
  }
  return DefWindowProcW(hwnd, message, wParam, lParam);
}

void CreateSettingsControls(HWND hwnd) {
  AddSettingsLabel(hwnd, L"查询范围与索引参数（保存后下次查询生效）", 20, 16, 520, 20, g_boldFont);
  AddSettingsLabel(hwnd, L"向上层数", 20, 50, 140, 20);
  AddSettingsEdit(hwnd, kIdSettingsUpLevels, 180, 48, 70, ES_NUMBER);
  AddSettingsLabel(hwnd, L"0 = 只看当前目录；遇到 Desktop 等会自动停止", 270, 50, 270, 20);

  AddSettingsLabel(hwnd, L"向下层数", 20, 82, 140, 20);
  AddSettingsEdit(hwnd, kIdSettingsDownLevels, 180, 80, 70, ES_NUMBER);
  AddSettingsLabel(hwnd, L"8 层通常足够", 270, 82, 270, 20);

  AddSettingsLabel(hwnd, L"最大文件数", 20, 114, 140, 20);
  AddSettingsEdit(hwnd, kIdSettingsMaxFiles, 180, 112, 70, ES_NUMBER);
  AddSettingsLabel(hwnd, L"10–20000；超出预算时限制范围", 270, 114, 270, 20);

  AddSettingsLabel(hwnd, L"索引时间预算（ms）", 20, 146, 140, 20);
  AddSettingsEdit(hwnd, kIdSettingsMaxIndexMs, 180, 144, 70, ES_NUMBER);
  AddSettingsLabel(hwnd, L"100–15000；超时返回部分结果", 270, 146, 270, 20);

  AddSettingsLabel(hwnd, L"点击修饰键", 20, 178, 140, 20);
  HWND modifier = CreateWindowExW(0, L"COMBOBOX", nullptr,
    WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST | WS_VSCROLL,
    180, 176, 120, 200, hwnd,
    reinterpret_cast<HMENU>(static_cast<INT_PTR>(kIdSettingsClickModifier)), g_instance, nullptr);
  SetSettingsControlFont(modifier);
  SendMessageW(modifier, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"Ctrl"));
  SendMessageW(modifier, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"Alt"));
  SendMessageW(modifier, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"Ctrl+Alt"));

  AddSettingsLabel(hwnd, L"排除目录", 20, 210, 140, 20);
  AddSettingsEdit(hwnd, kIdSettingsExcludeDirs, 180, 208, 360);
  AddSettingsLabel(hwnd, L"分号分隔；可写目录名或绝对路径", 180, 236, 360, 20);

  SetWindowTextW(GetDlgItem(hwnd, kIdSettingsUpLevels), std::to_wstring(g_settings.upLevels).c_str());
  SetWindowTextW(GetDlgItem(hwnd, kIdSettingsDownLevels), std::to_wstring(g_settings.downLevels).c_str());
  SetWindowTextW(GetDlgItem(hwnd, kIdSettingsMaxFiles), std::to_wstring(g_settings.maxFiles).c_str());
  SetWindowTextW(GetDlgItem(hwnd, kIdSettingsMaxIndexMs), std::to_wstring(g_settings.maxIndexMs).c_str());
  SetWindowTextW(GetDlgItem(hwnd, kIdSettingsExcludeDirs), g_settings.excludeDirs.c_str());
  const int modifierIndex = (g_settings.ctrlClick && g_settings.altClick)
    ? 2
    : (g_settings.altClick ? 1 : 0);
  SendMessageW(modifier, CB_SETCURSEL, modifierIndex, 0);

  AddSettingsButton(hwnd, kIdSettingsDefaults, L"恢复默认", 20, 285, 100, false);
  AddSettingsButton(hwnd, IDOK, L"保存", 360, 285, 90, true);
  AddSettingsButton(hwnd, IDCANCEL, L"取消", 460, 285, 80, false);
}

void ShowSettingsDialog() {
  if (g_settingsWindow) {
    SetForegroundWindow(g_settingsWindow);
    return;
  }
  LoadSettingsIfChanged();
  CreateFonts();

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = SettingsProc;
  wc.hInstance = g_instance;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = GetSysColorBrush(COLOR_BTNFACE);
  wc.lpszClassName = kSettingsClass;
  RegisterClassExW(&wc);

  constexpr int width = 580;
  constexpr int height = 370;
  RECT owner{};
  GetWindowRect(g_nppData._nppHandle, &owner);
  int x = owner.left + ((owner.right - owner.left) - width) / 2;
  int y = owner.top + ((owner.bottom - owner.top) - height) / 2;
  RECT work{};
  if (SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0)) {
    x = std::max(static_cast<int>(work.left), std::min(x, static_cast<int>(work.right) - width));
    y = std::max(static_cast<int>(work.top), std::min(y, static_cast<int>(work.bottom) - height));
  }

  HWND hwnd = CreateWindowExW(WS_EX_DLGMODALFRAME | WS_EX_CONTROLPARENT, kSettingsClass,
    L"RTL Signal Peek 参数", WS_POPUP | WS_CAPTION | WS_SYSMENU,
    x, y, width, height, g_nppData._nppHandle, nullptr, g_instance, nullptr);
  if (!hwnd) return;
  g_settingsWindow = hwnd;
  CreateSettingsControls(hwnd);

  EnableWindow(g_nppData._nppHandle, FALSE);
  ShowWindow(hwnd, SW_SHOW);
  SetFocus(GetDlgItem(hwnd, kIdSettingsUpLevels));

  MSG msg{};
  while (g_settingsWindow && IsWindow(g_settingsWindow)) {
    const BOOL result = GetMessageW(&msg, nullptr, 0, 0);
    if (result <= 0) break;
    if (!IsDialogMessageW(hwnd, &msg)) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
  }
  if (IsWindow(g_nppData._nppHandle)) EnableWindow(g_nppData._nppHandle, TRUE);
  SetForegroundWindow(g_nppData._nppHandle);
  g_settingsWindow = nullptr;
}

bool SetCommand(size_t index, const wchar_t* name, PFUNCPLUGINCMD function, ShortcutKey* shortcut = nullptr, bool checked = false) {
  if (index >= kFuncCount || !name || !function) return false;
  wcsncpy_s(g_funcItems[index]._itemName, name, _TRUNCATE);
  g_funcItems[index]._pFunc = function;
  g_funcItems[index]._pShKey = shortcut;
  g_funcItems[index]._init2Check = checked;
  return true;
}

void CommandMenuInit() {
  SetCommand(kCmdPeekAtCaret, L"RTL: 查看光标下信号", PeekAtCaret);
  SetCommand(kCmdShowPanel, L"RTL: 显示 Signal Peek 悬浮窗", ShowPanelCommand);
  SetCommand(kCmdSettings, L"RTL: 参数设置...", ShowSettingsDialog);
  SetCommand(kCmdPinProjectRoot, L"RTL: 固定当前目录为工程根", PinCurrentProjectRoot);
  SetCommand(kCmdClearProjectRoot, L"RTL: 清除当前目录的工程根", ClearCurrentProjectRoot);
}

void PluginCleanup() {
  if (g_panel) {
    DestroyWindow(g_panel);
    g_panel = nullptr;
  }
  for (const auto& entry : g_scintillaProc) {
    SetWindowLongPtrW(entry.first, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(entry.second));
  }
  g_scintillaProc.clear();
  if (g_uiFont) DeleteObject(g_uiFont);
  if (g_boldFont) DeleteObject(g_boldFont);
  if (g_codeFont) DeleteObject(g_codeFont);
  if (g_smallFont) DeleteObject(g_smallFont);
  if (g_backgroundBrush) DeleteObject(g_backgroundBrush);
  if (g_hoverBrush) DeleteObject(g_hoverBrush);
  if (g_selectedBrush) DeleteObject(g_selectedBrush);
}

}  // namespace

BOOL APIENTRY DllMain(HANDLE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_instance = static_cast<HINSTANCE>(module);
    DisableThreadLibraryCalls(g_instance);
  }
  return TRUE;
}

extern "C" __declspec(dllexport) void setInfo(NppData notepadPlusData) {
  g_nppData = notepadPlusData;
  wchar_t modulePath[MAX_PATH]{};
  GetModuleFileNameW(g_instance, modulePath, MAX_PATH);
  g_pluginDir = ParentPath(modulePath);
  LoadSettingsIfChanged();
  InstallScintillaHook();
  CommandMenuInit();
}

extern "C" __declspec(dllexport) const wchar_t* getName() {
  return kPluginName;
}

extern "C" __declspec(dllexport) FuncItem* getFuncsArray(int* count) {
  if (count) *count = kFuncCount;
  return g_funcItems;
}

extern "C" __declspec(dllexport) void beNotified(SCNotification* notification) {
  if (notification && notification->nmhdr.code == NPPN_SHUTDOWN) {
    PluginCleanup();
  }
}

extern "C" __declspec(dllexport) LRESULT messageProc(UINT, WPARAM, LPARAM) {
  return TRUE;
}

extern "C" __declspec(dllexport) BOOL isUnicode() {
  return TRUE;
}
