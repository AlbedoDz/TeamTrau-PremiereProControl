; Built by scripts/build-installer.mjs, which passes /DStage=<staging folder> /DAppVersion=<version>.
#define AppName "TeamTrau PremiereProControl"

[Setup]
AppId={{7D3F6A52-9B1E-4C0A-8E47-5A2C1F9D0B63}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=AlbedoDz
AppPublisherURL=https://github.com/AlbedoDz/TeamTrau-PremiereProControl
DefaultDirName={localappdata}\TeamTrau\PremiereProControl
DisableProgramGroupPage=yes
DefaultGroupName=TeamTrau
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/max
SolidCompression=yes
; The staged payload is ~850 MB; a single LZMA2 block thread made compiling take many minutes.
LZMAUseSeparateProcess=yes
LZMANumBlockThreads=8
WizardStyle=modern
ChangesEnvironment=yes
SetupLogging=yes
UninstallDisplayName={#AppName}
OutputBaseFilename=TeamTrau-PremiereProControl-{#AppVersion}-Setup

[Tasks]
Name: "whisper"; Description: "Tải thêm Whisper large-v3-turbo sau khi cài (khoảng 1,6 GB, cần Internet; có GPU NVIDIA thì tải thêm CUDA khoảng 2 GB)"; Flags: unchecked

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\TeamTrau\Tải thêm Whisper và CUDA"; Filename: "{cmd}"; Parameters: "/k ""{app}\bin\premiere-pro-mcp.cmd"" --setup-asr --engine whisper-turbo"
Name: "{autoprograms}\TeamTrau\Hướng dẫn sử dụng"; Filename: "{app}\HUONG-DAN-SU-DUNG.md"
Name: "{autoprograms}\TeamTrau\Hướng dẫn cài đặt"; Filename: "{app}\HUONG-DAN.md"

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\bin"; Check: NeedsPath(ExpandConstant('{app}\bin'))

[Run]
Filename: "{app}\bin\premiere-pro-mcp.cmd"; Parameters: "--setup-asr --engine whisper-turbo --yes"; Description: "Tải Whisper"; Tasks: whisper; Flags: waituntilterminated

[UninstallRun]
Filename: "{app}\bin\premiere-pro-mcp.cmd"; Parameters: "--unregister-clients"; RunOnceId: "UnregisterClients"; Flags: runhidden

[UninstallDelete]
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\MCPBridgeCEP"
Type: filesandordirs; Name: "{%USERPROFILE}\.premiere-mcp\venv"
Type: filesandordirs; Name: "{app}"

[Messages]
FinishedLabel=Đã cài xong [name]. Hãy mở lại Claude Desktop, Claude Code hoặc Antigravity để dùng bản mới.

[Code]
// AI clients keep {app}\node\node.exe running as the MCP server (and the sidecar keeps the bundled
// Python busy), so replacing or deleting those files fails with "Access is denied" (code 5).
// Stop every process running from the install folder or the sidecar venv before touching files.
function PsQuote(S: string): string;
begin
  StringChangeEx(S, '''', '''''', True);
  Result := '''' + S + '''';
end;

procedure StopRunningCopies();
var
  Dirs, Script: string;
  Code: Integer;
begin
  Dirs := PsQuote(ExpandConstant('{app}') + '\') + ',' + PsQuote(ExpandConstant('{%USERPROFILE}') + '\.premiere-mcp\venv\');
  Script :=
    '$dirs=@(' + Dirs + ');' +
    '$p=Get-CimInstance Win32_Process | Where-Object { $e=$_.ExecutablePath; $e -and ($dirs | Where-Object { $e.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) };' +
    'foreach($x in $p){ Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue };' +
    'foreach($x in $p){ Wait-Process -Id $x.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }';
  Exec('powershell.exe', '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Script + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningCopies();
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  StopRunningCopies();
  Result := True;
end;

function NeedsPath(Dir: string): Boolean;
var
  Paths: string;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Paths) then
    Paths := '';
  Result := Pos(';' + Lowercase(Dir) + ';', ';' + Lowercase(Paths) + ';') = 0;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Đang cài Python, cầu nối Premiere và cấu hình các ứng dụng AI...';
    if (not Exec(ExpandConstant('{app}\post-install.cmd'), '', '', SW_HIDE, ewWaitUntilTerminated, Code)) or (Code <> 0) then
      MsgBox('Một bước cài đặt báo lỗi. Xem chi tiết trong:' + #13#10 + ExpandConstant('{app}\install.log'), mbError, MB_OK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Dir, Paths: string;
  P: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Dir := ExpandConstant('{app}\bin');
    if RegQueryStringValue(HKCU, 'Environment', 'Path', Paths) then
    begin
      P := Pos(';' + Lowercase(Dir), Lowercase(Paths));
      if P > 0 then
      begin
        Delete(Paths, P, Length(Dir) + 1);
        RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Paths);
      end;
    end;
  end;
end;
