#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#define NOMINMAX
#include <windows.h>
#include <commdlg.h>
#include <commctrl.h>
#include <shlobj.h>
#include <string>
#include <vector>
#include <map>
#include <set>
#include <deque>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <fstream>
#include <algorithm>
#include "../vendor/Scintilla.h"
#include "../vendor/Notepad_plus_msgs.h"
#include "../vendor/json.hpp"
#include "../out/plugin-version.h"
using json=nlohmann::json;
struct NppData {HWND _nppHandle;HWND _scintillaMainHandle;HWND _scintillaSecondHandle;};
struct ShortcutKey {bool ctrl,alt,shift;UCHAR key;};
struct FuncItem {wchar_t name[64];void (__cdecl *function)();int id;bool checked;ShortcutKey* shortcut;};
static NppData npp{};static HINSTANCE instance;static HWND window,listbox,issueTree,details;static std::wstring base,config;
static HWND datasetDialog=nullptr,datasetList=nullptr;static bool datasetDialogAccepted=false;static std::vector<std::string> datasetDialogFiles,datasetDialogLabels,datasetDialogSelected;static std::vector<bool> datasetDialogInitialChecks;
static HWND identifierDialog=nullptr,identifierInput=nullptr;static bool identifierAccepted=false;static std::string identifierCommand,identifierValue;
static HANDLE process=nullptr,inputPipe=nullptr,outputPipe=nullptr;static std::thread thread;
static std::mutex mutex;static std::condition_variable condition;static std::deque<json> requests;static bool stopping=false;
static unsigned long long sequence=0,revision=0;static json visible={{"kind",""},{"items",json::array()}},completion;static std::map<std::string,std::string> buffers;
static std::string issueGrouping="severity";static std::map<HTREEITEM,std::string> issueGroups;static std::set<std::string> collapsedGroups;static bool buildingIssueTree=false;
static HWND hintWindow=nullptr,hintText=nullptr,statusWindow=nullptr;static WNDPROC statusProc=nullptr;
static json diagnostics;static intptr_t hoverPosition=-1;
static bool profileStatusAvailable=true;
static bool snapshotting=false,snapshotReady=false,internalEdit=false,suppressTab=false;static WNDPROC mainProc=nullptr,secondProc=nullptr;
struct Field{int index,start,end;};static std::vector<Field> fields;static size_t fieldAt=0;static std::string snippetFile;
// Layout follows the public Notepad++ Docking.h interface.
struct DockedWidgetData { HWND hClient; const wchar_t* pszName; int dlgID; UINT uMask; HICON hIconTab; const wchar_t* pszAddInfo; RECT rcFloat; int iPrevCont; const wchar_t* pszModuleName; };
static constexpr UINT DWS_DF_CONT_BOTTOM=0x00000008;
static bool dockRegistered=false;
static void showPane(){if(!dockRegistered){DockedWidgetData d{};d.hClient=window;d.pszName=L"CIM Search & Issues";d.dlgID=2;d.uMask=DWS_DF_CONT_BOTTOM;d.pszModuleName=L"CGMESNotepad.dll";SendMessage(npp._nppHandle,NPPM_DMMREGASDCKDLG,0,(LPARAM)&d);dockRegistered=true;}SendMessage(npp._nppHandle,NPPM_DMMSHOW,0,(LPARAM)window);}
static void hidePane(){SendMessage(npp._nppHandle,NPPM_DMMHIDE,0,(LPARAM)window);}
static constexpr UINT RESULT=WM_APP+9;static int indicator=-1;
static std::wstring wide(const std::string&s){if(s.empty())return {};int n=MultiByteToWideChar(CP_UTF8,0,s.data(),(int)s.size(),nullptr,0);std::wstring o(n,0);MultiByteToWideChar(CP_UTF8,0,s.data(),(int)s.size(),o.data(),n);return o;}
static std::string utf8(const std::wstring&s){if(s.empty())return {};int n=WideCharToMultiByte(CP_UTF8,0,s.data(),(int)s.size(),nullptr,0,nullptr,nullptr);std::string o(n,0);WideCharToMultiByte(CP_UTF8,0,s.data(),(int)s.size(),o.data(),n,nullptr,nullptr);return o;}
static HWND editor(){int view=0;SendMessage(npp._nppHandle,NPPM_GETCURRENTSCINTILLA,0,(LPARAM)&view);return view?npp._scintillaSecondHandle:npp._scintillaMainHandle;}
static void hideHint(){if(hintWindow)ShowWindow(hintWindow,SW_HIDE);}
static void showHint(intptr_t position,const std::string& message){
  if(!hintWindow){hintWindow=CreateWindowEx(WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,L"STATIC",L"CGMES Hover",WS_POPUP|WS_BORDER,0,0,0,0,npp._nppHandle,nullptr,instance,nullptr);hintText=CreateWindow(L"EDIT",L"",WS_CHILD|WS_VISIBLE|WS_VSCROLL|ES_MULTILINE|ES_READONLY|ES_AUTOVSCROLL,0,0,0,0,hintWindow,(HMENU)301,instance,nullptr);SendMessage(hintText,WM_SETFONT,(WPARAM)GetStockObject(DEFAULT_GUI_FONT),FALSE);}
  RECT bounds{};GetClientRect(npp._nppHandle,&bounds);MapWindowPoints(npp._nppHandle,nullptr,(POINT*)&bounds,2);
  MONITORINFO monitor{sizeof(monitor)};GetMonitorInfo(MonitorFromWindow(npp._nppHandle,MONITOR_DEFAULTTONEAREST),&monitor);RECT available{};if(!IntersectRect(&available,&bounds,&monitor.rcWork))available=monitor.rcWork;
  int width=std::max(1,std::min(640,(int)(available.right-available.left)-16)),height=std::max(1,std::min(300,(int)(available.bottom-available.top)/2));
  POINT anchor{(LONG)SendMessage(editor(),SCI_POINTXFROMPOSITION,0,position),(LONG)SendMessage(editor(),SCI_POINTYFROMPOSITION,0,position)};ClientToScreen(editor(),&anchor);
  int x=std::clamp((int)anchor.x,(int)available.left,(int)available.right-width),y=anchor.y+24;if(y+height>available.bottom)y=anchor.y-height-8;y=std::clamp(y,(int)available.top,(int)available.bottom-height);
  auto value=wide(message);std::wstring normalized;for(wchar_t c:value){if(c=='\n'&&(normalized.empty()||normalized.back()!='\r'))normalized+='\r';normalized+=c;}SetWindowText(hintText,normalized.c_str());
  SetWindowPos(hintWindow,HWND_TOP,x,y,width,height,SWP_NOACTIVATE);MoveWindow(hintText,4,4,std::max(1,width-10),std::max(1,height-10),TRUE);ShowWindow(hintWindow,SW_SHOWNOACTIVATE);SetTimer(window,4,200,nullptr);
}
static LRESULT CALLBACK statusHook(HWND h,UINT m,WPARAM w,LPARAM l){
  if(profileStatusAvailable&&m==WM_LBUTTONUP){RECT r{};SendMessage(h,SB_GETRECT,0,(LPARAM)&r);POINT p{(short)LOWORD(l),(short)HIWORD(l)};if(PtInRect(&r,p)){PostMessage(window,WM_COMMAND,106,0);return 0;}}
  return CallWindowProc(statusProc,h,m,w,l);
}
static void hookStatus(){if(!statusWindow){statusWindow=FindWindowEx(npp._nppHandle,nullptr,STATUSCLASSNAME,nullptr);if(statusWindow)statusProc=(WNDPROC)SetWindowLongPtr(statusWindow,GWLP_WNDPROC,(LONG_PTR)statusHook);}}
static std::string filename(){wchar_t name[32768]{};SendMessage(npp._nppHandle,NPPM_GETFULLCURRENTPATH,32768,(LPARAM)name);return utf8(name);}
static std::string editorText(HWND e){size_t len=SendMessage(e,SCI_GETLENGTH,0,0);std::string s(len+1,0);SendMessage(e,SCI_GETTEXT,len+1,(LPARAM)s.data());s.resize(len);return s;}
static std::string text(){return editorText(editor());}
static bool validUtf8(const std::string& s){return s.empty() || MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),(int)s.size(),nullptr,0)>0;}
static void rememberBuffer(const std::string& file,const std::string& content){if(validUtf8(content))buffers[file]=content;else buffers.erase(file);}
static void captureAll(){
  if(snapshotting||snapshotReady)return;snapshotting=true;
  int active=0;SendMessage(npp._nppHandle,NPPM_GETCURRENTSCINTILLA,0,(LPARAM)&active);
  int saved[2]={(int)SendMessage(npp._nppHandle,NPPM_GETCURRENTDOCINDEX,0,0),(int)SendMessage(npp._nppHandle,NPPM_GETCURRENTDOCINDEX,0,1)};
  HWND focus=GetFocus();SendMessage(npp._nppHandle,WM_SETREDRAW,FALSE,0);buffers.clear();
  for(int view=0;view<2;++view){int count=(int)SendMessage(npp._nppHandle,NPPM_GETNBOPENFILES,0,view+1);for(int i=0;i<count;++i){
    SendMessage(npp._nppHandle,NPPM_ACTIVATEDOC,view,i);rememberBuffer(filename(),text());
  }if(saved[view]>=0)SendMessage(npp._nppHandle,NPPM_ACTIVATEDOC,view,saved[view]);}
  if(saved[active]>=0)SendMessage(npp._nppHandle,NPPM_ACTIVATEDOC,active,saved[active]);
  SendMessage(npp._nppHandle,WM_SETREDRAW,TRUE,0);RedrawWindow(npp._nppHandle,nullptr,nullptr,RDW_INVALIDATE|RDW_ALLCHILDREN);if(focus)SetFocus(focus);
  snapshotting=false;snapshotReady=true;
}
static void selectField(){if(fieldAt>=fields.size()){fields.clear();return;}auto f=fields[fieldAt];SendMessage(editor(),SCI_SETSEL,f.start,f.end);SendMessage(editor(),SCI_SCROLLCARET,0,0);}
static void startFields(){std::stable_sort(fields.begin(),fields.end(),[](const Field&a,const Field&b){int x=a.index?a.index:INT_MAX,y=b.index?b.index:INT_MAX;return x<y;});fieldAt=0;snippetFile=filename();if(!fields.empty())selectField();}
static void adjustFields(int pos,int removed,int added){
  for(size_t i=0;i<fields.size();++i){auto&f=fields[i];int finish=pos+removed;
    if(i==fieldAt&&pos>=f.start&&pos<=f.end){f.end=std::max(f.start,f.end-removed+added);continue;}
    if(f.start>=finish){f.start+=added-removed;f.end+=added-removed;}
    else if(f.end>pos){f.end=std::max(f.start,f.end-std::min(removed,f.end-pos)+added);}
  }
}
static void nextField(bool back){
  if(fields.empty()||fieldAt>=fields.size())return;HWND e=editor();auto current=fields[fieldAt];
  std::string full=text(),value=full.substr(current.start,std::max(0,current.end-current.start));
  // Synchronize repeated numeric placeholders before leaving their field.
  std::vector<size_t> mirrors;for(size_t i=0;i<fields.size();++i)if(i!=fieldAt&&fields[i].index==current.index&&current.index)mirrors.push_back(i);
  std::sort(mirrors.begin(),mirrors.end(),[](size_t a,size_t b){return fields[a].start>fields[b].start;});
  SendMessage(e,SCI_BEGINUNDOACTION,0,0);for(size_t i:mirrors){auto f=fields[i];SendMessage(e,SCI_SETTARGETSTART,f.start,0);SendMessage(e,SCI_SETTARGETEND,f.end,0);SendMessage(e,SCI_REPLACETARGET,value.size(),(LPARAM)value.c_str());}SendMessage(e,SCI_ENDUNDOACTION,0,0);
  if(back){if(fieldAt)do{--fieldAt;}while(fieldAt&&fields[fieldAt].index==current.index);}
  else{do{++fieldAt;}while(fieldAt<fields.size()&&fields[fieldAt].index==current.index);}
  selectField();
}
static LRESULT CALLBACK editorProc(HWND h,UINT msg,WPARAM w,LPARAM l){
  if(msg==WM_KEYDOWN&&w==VK_TAB&&!fields.empty()&&snippetFile==filename()){suppressTab=true;nextField((GetKeyState(VK_SHIFT)&0x8000)!=0);return 0;}
  if(msg==WM_CHAR&&w=='\t'&&suppressTab){suppressTab=false;return 0;}
  if(msg==WM_KEYDOWN&&w==VK_ESCAPE)fields.clear();
  return CallWindowProc(h==npp._scintillaMainHandle?mainProc:secondProc,h,msg,w,l);
}
static void error(const std::string&s){
// Modal dialogs pump WM_TIMER, recursively opening more dialogs on periodic failures.
visible={{"kind","error"},{"items",json::array()}};
ShowWindow(issueTree,SW_HIDE);ShowWindow(listbox,SW_SHOW);
SendMessage(listbox,LB_RESETCONTENT,0,0);
SendMessage(listbox,LB_ADDSTRING,0,(LPARAM)L"CGMES: analysis paused (see details)");
SetWindowText(details,wide(s).c_str());showPane();
}
static bool launch(){
  SECURITY_ATTRIBUTES sa{sizeof(sa),nullptr,TRUE};HANDLE childIn=nullptr,childOut=nullptr;
  if(!CreatePipe(&childIn,&inputPipe,&sa,0)||!CreatePipe(&outputPipe,&childOut,&sa,0))return false;
  SetHandleInformation(inputPipe,HANDLE_FLAG_INHERIT,0);SetHandleInformation(outputPipe,HANDLE_FLAG_INHERIT,0);
  HANDLE err=CreateFile(L"NUL",GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,&sa,OPEN_EXISTING,0,nullptr);
  STARTUPINFOW si{};si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES|STARTF_USESHOWWINDOW;si.wShowWindow=SW_HIDE;si.hStdInput=childIn;si.hStdOutput=childOut;si.hStdError=err;
  PROCESS_INFORMATION pi{};std::wstring exe=base+L"\\node.exe",cmd=L"\""+exe+L"\" \""+base+L"\\worker.cjs\" \""+config+L"\"";
  BOOL ok=CreateProcessW(exe.c_str(),cmd.data(),nullptr,nullptr,TRUE,CREATE_NO_WINDOW,nullptr,base.c_str(),&si,&pi);
  CloseHandle(childIn);CloseHandle(childOut);CloseHandle(err);
  if(!ok){CloseHandle(inputPipe);CloseHandle(outputPipe);inputPipe=outputPipe=nullptr;return false;}
  process=pi.hProcess;CloseHandle(pi.hThread);return true;
}
static void run(){
  while(true){json request;{std::unique_lock<std::mutex> lock(mutex);condition.wait(lock,[]{return stopping||!requests.empty();});if(stopping)return;request=std::move(requests.front());requests.pop_front();}
    json response;try{
      std::string payload=request.dump()+"\n";DWORD written=0;size_t pos=0;
      while(pos<payload.size()){if(!WriteFile(inputPipe,payload.data()+pos,(DWORD)std::min<size_t>(65536,payload.size()-pos),&written,nullptr)||!written)throw std::runtime_error("Worker pipe closed");pos+=written;}
      std::string line;char chunk[65536];DWORD count;
      while(true){if(!ReadFile(outputPipe,chunk,sizeof(chunk),&count,nullptr)||!count)throw std::runtime_error("CGMES worker stopped. Restart Notepad++.");line.append(chunk,count);if(!line.empty()&&line.back()=='\n')break;}
      response=json::parse(line);response["position"]=request["position"];
    }catch(const std::exception&e){response={{"kind","error"},{"text",e.what()},{"revision",request["revision"]},{"file",request["file"]}};}
    {std::lock_guard<std::mutex> lock(mutex);if(stopping)return;}
    auto value=new json(std::move(response));if(!PostMessage(window,RESULT,0,(LPARAM)value))delete value;
  }
}
static void request(const char*command,json argument=nullptr,intptr_t position=-1){
  if(!window)return;
  captureAll();
  if(!thread.joinable()){if(!launch()){error("Cannot start bundled node.exe. Reinstall the complete CGMESNotepad folder.");return;}thread=std::thread(run);}
  std::string file=filename(),content=text();
// Never replace invalid bytes: doing so would invalidate edit positions.
if(!validUtf8(content)){buffers.erase(file);error("This document contains bytes that are not valid UTF-8. Analysis is paused. In Notepad++, select the correct source encoding, then Encoding > Convert to UTF-8. Your document has not been changed.");return;}
rememberBuffer(file,content);
  json open=json::array();for(auto&b:buffers)open.push_back({{"file",b.first},{"text",b.second}});
  json r={{"id",++sequence},{"revision",revision},{"command",command},{"file",file},{"text",content},{"position",position<0?(intptr_t)SendMessage(editor(),SCI_GETCURRENTPOS,0,0):position},{"argument",argument},{"buffers",open}};
  {std::lock_guard<std::mutex> lock(mutex);if(stopping)return;
    if(std::string(command)=="validate"||std::string(command)=="hover"||std::string(command)=="complete")requests.erase(std::remove_if(requests.begin(),requests.end(),[&](const json&x){return x["command"]==command;}),requests.end());
    if(std::string(command)=="validate")requests.push_back(std::move(r));else requests.push_front(std::move(r));}condition.notify_one();
}
static bool current(const json&r){return r.value("file","")==filename()&&r.value("revision",0ULL)==revision;}
// Keep diagnostics independent from the currently displayed choices/outline pane.
static bool issueHover(intptr_t position){
  if(diagnostics.is_null()||!current(diagnostics))return false;
  std::string tip;std::vector<std::string> seen;
  for(const auto&i:diagnostics["items"]){
    int start=i.value("start",0),end=i.value("end",0);
    if(i.value("file","")!=filename()||position<start||position>=std::max(start+1,end))continue;
    std::string message=i.value("severity","")+": "+i.value("detail","");
    if(std::find(seen.begin(),seen.end(),message)!=seen.end())continue;
    seen.push_back(message);if(!tip.empty())tip+="\n\n";tip+=message;
  }
  if(tip.empty())return false;
  showHint(position,tip);return true;
}
static void hoverAt(intptr_t position){KillTimer(window,3);hoverPosition=position;if(!issueHover(position))request("hover",nullptr,position);}
static void applyEdits(const json&item,const json&owner){
  if(!current(owner)){error("The file changed. Request fresh results before applying this edit.");return;}
  HWND e=editor();auto edits=item["edits"].get<std::vector<json>>();std::sort(edits.begin(),edits.end(),[](const json&a,const json&b){return a["start"].get<int>()>b["start"].get<int>();});
  fields.clear();internalEdit=true;SendMessage(e,SCI_BEGINUNDOACTION,0,0);
  for(auto&v:edits){std::string s=v["text"];int start=v["start"],end=v["end"];int delta=(int)s.size()-(end-start);for(auto&f:fields){f.start+=delta;f.end+=delta;}SendMessage(e,SCI_SETTARGETSTART,start,0);SendMessage(e,SCI_SETTARGETEND,end,0);SendMessage(e,SCI_REPLACETARGET,s.size(),(LPARAM)s.c_str());for(auto&f:v.value("fields",json::array()))fields.push_back({f["index"],start+f["start"].get<int>(),start+f["end"].get<int>()});}
  SendMessage(e,SCI_ENDUNDOACTION,0,0);internalEdit=false;startFields();SetFocus(e);
}
static constexpr int DATASET_SELECT_ALL=501,DATASET_CLEAR=502,DATASET_APPLY=503,DATASET_CANCEL=504;
static LRESULT CALLBACK datasetDialogProc(HWND h,UINT m,WPARAM w,LPARAM l){
  if(m==WM_CREATE){
    CreateWindowW(L"STATIC",L"Select open CIM files. Only .xml files are validated; other formats are reference-only. Applying replaces the current dataset selection.",WS_CHILD|WS_VISIBLE,10,10,650,38,h,nullptr,instance,nullptr);
    datasetList=CreateWindowExW(WS_EX_CLIENTEDGE,WC_LISTVIEWW,L"",WS_CHILD|WS_VISIBLE|WS_TABSTOP|LVS_REPORT|LVS_SINGLESEL|LVS_SHOWSELALWAYS,10,52,650,280,h,(HMENU)505,instance,nullptr);
    ListView_SetExtendedListViewStyle(datasetList,LVS_EX_CHECKBOXES|LVS_EX_FULLROWSELECT|LVS_EX_LABELTIP);
    LVCOLUMNW column{};column.mask=LVCF_TEXT|LVCF_WIDTH;column.pszText=(LPWSTR)L"Open CIM documents";column.cx=630;ListView_InsertColumn(datasetList,0,&column);
    for(size_t i=0;i<datasetDialogFiles.size();++i){auto item=wide(datasetDialogLabels[i]);LVITEMW row{};row.mask=LVIF_TEXT;row.iItem=(int)i;row.pszText=item.data();ListView_InsertItem(datasetList,&row);ListView_SetCheckState(datasetList,(int)i,datasetDialogInitialChecks[i]);}
    CreateWindowW(L"BUTTON",L"Select all",WS_CHILD|WS_VISIBLE|WS_TABSTOP,10,344,100,28,h,(HMENU)DATASET_SELECT_ALL,instance,nullptr);
    CreateWindowW(L"BUTTON",L"Clear all",WS_CHILD|WS_VISIBLE|WS_TABSTOP,118,344,100,28,h,(HMENU)DATASET_CLEAR,instance,nullptr);
    CreateWindowW(L"BUTTON",L"Apply",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_DEFPUSHBUTTON,450,344,100,28,h,(HMENU)DATASET_APPLY,instance,nullptr);
    CreateWindowW(L"BUTTON",L"Cancel",WS_CHILD|WS_VISIBLE|WS_TABSTOP,560,344,100,28,h,(HMENU)DATASET_CANCEL,instance,nullptr);
    return 0;
  }
  if(m==WM_SIZE){
    const int width=LOWORD(l),height=HIWORD(l);MoveWindow(datasetList,10,52,std::max(1,width-20),std::max(1,height-102),TRUE);
    MoveWindow(GetDlgItem(h,DATASET_SELECT_ALL),10,height-42,100,28,TRUE);MoveWindow(GetDlgItem(h,DATASET_CLEAR),118,height-42,100,28,TRUE);
    MoveWindow(GetDlgItem(h,DATASET_APPLY),std::max(230,width-220),height-42,100,28,TRUE);MoveWindow(GetDlgItem(h,DATASET_CANCEL),std::max(340,width-110),height-42,100,28,TRUE);return 0;
  }
  if(m==WM_COMMAND){
    const int command=LOWORD(w);
    if(command==DATASET_SELECT_ALL||command==DATASET_CLEAR){const BOOL checked=command==DATASET_SELECT_ALL;for(int i=0;i<(int)datasetDialogFiles.size();++i)ListView_SetCheckState(datasetList,i,checked);return 0;}
    if(command==DATASET_APPLY){
      datasetDialogSelected.clear();for(int i=0;i<(int)datasetDialogFiles.size();++i)if(ListView_GetCheckState(datasetList,i))datasetDialogSelected.push_back(datasetDialogFiles[i]);
      datasetDialogAccepted=!datasetDialogSelected.empty();
      if(!datasetDialogAccepted){MessageBoxW(h,L"Select at least one open CIM file, or cancel and use Dataset: automatic.",L"CGMES dataset",MB_OK|MB_ICONINFORMATION);return 0;}
      DestroyWindow(h);return 0;
    }
    if(command==DATASET_CANCEL){DestroyWindow(h);return 0;}
  }
  if(m==WM_CLOSE){DestroyWindow(h);return 0;}
  if(m==WM_DESTROY){datasetDialog=nullptr;datasetList=nullptr;return 0;}
  return DefWindowProcW(h,m,w,l);
}
static void showDatasetSelection(const json&r){
  datasetDialogFiles.clear();datasetDialogLabels.clear();datasetDialogInitialChecks.clear();datasetDialogSelected.clear();
  for(const auto&i:r.value("items",json::array())){datasetDialogFiles.push_back(i.value("file",""));datasetDialogLabels.push_back(i.value("label",""));datasetDialogInitialChecks.push_back(i.value("checked",false));}
  if(datasetDialogFiles.empty()){MessageBoxW(npp._nppHandle,L"No open CIM/XML files were found.",L"CGMES dataset",MB_OK|MB_ICONINFORMATION);return;}
  INITCOMMONCONTROLSEX controls{sizeof(controls),ICC_LISTVIEW_CLASSES};if(!InitCommonControlsEx(&controls)){error("Cannot initialize the open-file selection list.");return;}
  static const wchar_t* className=L"CGMESOpenDatasetSelection";
  WNDCLASSW wc{};wc.hInstance=instance;wc.lpfnWndProc=datasetDialogProc;wc.lpszClassName=className;wc.hCursor=LoadCursor(nullptr,IDC_ARROW);wc.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);
  if(!RegisterClassW(&wc)&&GetLastError()!=ERROR_CLASS_ALREADY_EXISTS){error("Cannot register the open-file selection dialog.");return;}
  datasetDialogAccepted=false;
  datasetDialog=CreateWindowExW(WS_EX_DLGMODALFRAME|WS_EX_CONTROLPARENT,className,L"Choose open files for the CIM dataset",WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_SIZEBOX,CW_USEDEFAULT,CW_USEDEFAULT,680,430,npp._nppHandle,nullptr,instance,nullptr);
  if(!datasetDialog){error("Cannot create the open-file selection dialog.");return;}
  RECT owner{},dialog{};GetWindowRect(npp._nppHandle,&owner);GetWindowRect(datasetDialog,&dialog);
  SetWindowPos(datasetDialog,nullptr,owner.left+(owner.right-owner.left-(dialog.right-dialog.left))/2,owner.top+(owner.bottom-owner.top-(dialog.bottom-dialog.top))/2,0,0,SWP_NOSIZE|SWP_NOZORDER);
  EnableWindow(npp._nppHandle,FALSE);ShowWindow(datasetDialog,SW_SHOW);SetForegroundWindow(datasetDialog);
  MSG message;while(datasetDialog){const BOOL result=GetMessageW(&message,nullptr,0,0);if(result<=0)break;if(!IsDialogMessageW(datasetDialog,&message)){TranslateMessage(&message);DispatchMessageW(&message);}}
  EnableWindow(npp._nppHandle,TRUE);SetForegroundWindow(npp._nppHandle);
  if(!datasetDialogAccepted)return;
  json files=datasetDialogSelected;
  request("dataset",files);
}
static constexpr int IDENTIFIER_INPUT=601,IDENTIFIER_FIND=602,IDENTIFIER_CANCEL=603;
static LRESULT CALLBACK identifierDialogProc(HWND h,UINT m,WPARAM w,LPARAM l){
  if(m==WM_CREATE){
    CreateWindowW(L"STATIC",L"Enter a CIM mRID (rdf:ID/rdf:about):",WS_CHILD|WS_VISIBLE,10,10,390,22,h,nullptr,instance,nullptr);
    identifierInput=CreateWindowExW(WS_EX_CLIENTEDGE,L"EDIT",L"",WS_CHILD|WS_VISIBLE|WS_TABSTOP|ES_AUTOHSCROLL,10,36,390,26,h,(HMENU)IDENTIFIER_INPUT,instance,nullptr);
    CreateWindowW(L"BUTTON",L"Find",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_DEFPUSHBUTTON,190,76,100,28,h,(HMENU)IDENTIFIER_FIND,instance,nullptr);
    CreateWindowW(L"BUTTON",L"Cancel",WS_CHILD|WS_VISIBLE|WS_TABSTOP,300,76,100,28,h,(HMENU)IDENTIFIER_CANCEL,instance,nullptr);
    return 0;
  }
  if(m==WM_COMMAND){
    const int command=LOWORD(w);
    if(command==IDENTIFIER_FIND){
      const int length=GetWindowTextLengthW(identifierInput);std::vector<wchar_t> value(length+1);GetWindowTextW(identifierInput,value.data(),length+1);
      identifierValue=utf8(value.data());if(identifierValue.find_first_not_of(" \t\r\n")==std::string::npos){MessageBoxW(h,L"Enter an mRID to search.",L"CIM dataset search",MB_OK|MB_ICONINFORMATION);SetFocus(identifierInput);return 0;}
      identifierAccepted=true;DestroyWindow(h);return 0;
    }
    if(command==IDENTIFIER_CANCEL){DestroyWindow(h);return 0;}
  }
  if(m==WM_CLOSE){DestroyWindow(h);return 0;}
  if(m==WM_DESTROY){identifierDialog=nullptr;identifierInput=nullptr;return 0;}
  return DefWindowProcW(h,m,w,l);
}
static void promptIdentifier(const char* command){
  hideHint();identifierCommand=command;identifierValue.clear();identifierAccepted=false;
  static const wchar_t* className=L"CGMESIdentifierPrompt";
  WNDCLASSW wc{};wc.hInstance=instance;wc.lpfnWndProc=identifierDialogProc;wc.lpszClassName=className;wc.hCursor=LoadCursor(nullptr,IDC_ARROW);wc.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);
  if(!RegisterClassW(&wc)&&GetLastError()!=ERROR_CLASS_ALREADY_EXISTS){error("Cannot register the CIM identifier prompt.");return;}
  identifierDialog=CreateWindowExW(WS_EX_DLGMODALFRAME|WS_EX_CONTROLPARENT,className,L"Search the selected CIM dataset",WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU,CW_USEDEFAULT,CW_USEDEFAULT,430,155,npp._nppHandle,nullptr,instance,nullptr);
  if(!identifierDialog){error("Cannot create the CIM identifier prompt.");return;}
  RECT owner{},dialog{};GetWindowRect(npp._nppHandle,&owner);GetWindowRect(identifierDialog,&dialog);
  SetWindowPos(identifierDialog,nullptr,owner.left+(owner.right-owner.left-(dialog.right-dialog.left))/2,owner.top+(owner.bottom-owner.top-(dialog.bottom-dialog.top))/2,0,0,SWP_NOSIZE|SWP_NOZORDER);
  EnableWindow(npp._nppHandle,FALSE);ShowWindow(identifierDialog,SW_SHOW);SetForegroundWindow(identifierDialog);SetFocus(identifierInput);
  MSG message;while(identifierDialog){const BOOL result=GetMessageW(&message,nullptr,0,0);if(result<=0)break;if(!IsDialogMessageW(identifierDialog,&message)){TranslateMessage(&message);DispatchMessageW(&message);}}
  EnableWindow(npp._nppHandle,TRUE);SetForegroundWindow(npp._nppHandle);
  if(identifierAccepted)request(identifierCommand.c_str(),identifierValue);
}
static int selectedIssue(){
  HTREEITEM item=TreeView_GetSelection(issueTree);if(!item)return -1;
  TVITEM value{};value.mask=TVIF_PARAM;value.hItem=item;if(!TreeView_GetItem(issueTree,&value)||value.lParam<=0)return -1;
  return (int)value.lParam-1;
}
static HTREEITEM addIssueNode(HTREEITEM parent,const std::string& label,LPARAM index){
  auto text=wide(label);TVINSERTSTRUCT entry{};entry.hParent=parent;entry.hInsertAfter=TVI_LAST;entry.item.mask=TVIF_TEXT|TVIF_PARAM;entry.item.pszText=text.data();entry.item.lParam=index;
  return TreeView_InsertItem(issueTree,&entry);
}
static std::string ruleTitle(const std::string& rule){
  if(rule=="schema")return "Schema (RDFS)";if(rule=="shacl")return "SHACL";if(rule=="dataset")return "Cross-file references";if(rule=="reference")return "Reference data";if(rule=="file")return "File and identifiers";return rule;
}
static void populateIssues(const json& previous=json()){
  int selected=selectedIssue();json selectedItem;
  if(previous.is_object()&&previous.value("kind","")=="issues"&&selected>=0&&selected<(int)previous["items"].size())selectedItem=previous["items"][selected];
  else if(previous.is_null()&&selected>=0)selectedItem=visible["items"][selected];
  for(const auto& group:issueGroups){if(TreeView_GetItemState(issueTree,group.first,TVIS_EXPANDED)&TVIS_EXPANDED)collapsedGroups.erase(group.second);else collapsedGroups.insert(group.second);}
  buildingIssueTree=true;SendMessage(issueTree,WM_SETREDRAW,FALSE,0);TreeView_DeleteAllItems(issueTree);issueGroups.clear();
  std::map<std::string,std::map<std::string,std::vector<int>>> groups;
  for(size_t i=0;i<visible["items"].size();++i){const auto& item=visible["items"][i];groups[item.value("rule","schema")][item.value(issueGrouping,"")].push_back((int)i);}
  HTREEITEM selection=nullptr;
  for(const auto& rule:groups){
    auto root=addIssueNode(TVI_ROOT,ruleTitle(rule.first),0);std::string rootKey="rule:"+rule.first;issueGroups[root]=rootKey;
    for(const auto& group:rule.second){
      auto branch=addIssueNode(root,group.first+" ("+std::to_string(group.second.size())+")",0);std::string key=rootKey+"/"+issueGrouping+":"+group.first;issueGroups[branch]=key;
      for(int index:group.second){const auto& item=visible["items"][index];auto leaf=addIssueNode(branch,item.value("label",""),(LPARAM)index+1);if(!selectedItem.is_null()&&item==selectedItem&&!collapsedGroups.count(rootKey)&&!collapsedGroups.count(key))selection=leaf;}
      if(!collapsedGroups.count(key))TreeView_Expand(issueTree,branch,TVE_EXPAND);
    }
    TreeView_Expand(issueTree,root,collapsedGroups.count(rootKey)?TVE_COLLAPSE:TVE_EXPAND);
  }
  if(selection)TreeView_SelectItem(issueTree,selection);
  SendMessage(issueTree,WM_SETREDRAW,TRUE,0);InvalidateRect(issueTree,nullptr,TRUE);buildingIssueTree=false;
  if(!selection)SetWindowText(details,L"Expand a category; double-click an issue or press Apply / Go.");
}
static void populate(const json& previous=json()){
  bool issues=visible.value("kind","")=="issues";ShowWindow(listbox,issues?SW_HIDE:SW_SHOW);ShowWindow(issueTree,issues?SW_SHOW:SW_HIDE);
  if(issues){populateIssues(previous);return;}
  int selected=(int)SendMessage(listbox,LB_GETCURSEL,0,0),top=(int)SendMessage(listbox,LB_GETTOPINDEX,0,0);SendMessage(listbox,WM_SETREDRAW,FALSE,0);SendMessage(listbox,LB_RESETCONTENT,0,0);for(auto&i:visible["items"])SendMessage(listbox,LB_ADDSTRING,0,(LPARAM)wide(i.value("label","")).c_str());if(!visible["items"].empty())SendMessage(listbox,LB_SETCURSEL,std::max(0,std::min(selected,(int)visible["items"].size()-1)),0);SendMessage(listbox,LB_SETTOPINDEX,top,0);SendMessage(listbox,WM_SETREDRAW,TRUE,0);InvalidateRect(listbox,nullptr,TRUE);auto hint=visible.value("kind","")=="searchResults"?visible.value("status",""): "Double-click a row or press Apply / Go.";SetWindowText(details,wide(hint).c_str());
}
static void choose(){
  int n=visible.value("kind","")=="issues"?selectedIssue():(int)SendMessage(listbox,LB_GETCURSEL,0,0);if(n<0||n>=(int)visible["items"].size())return;auto item=visible["items"][n];
  if(item.contains("edits")){applyEdits(item,visible);hidePane();}
  else if(item.contains("command")){
    if(!current(visible)){error("The active document changed. Reopen this selection.");return;}
    std::string command=item["command"];
    if(command=="newText"){SendMessage(npp._nppHandle,NPPM_MENUCOMMAND,0,41001);auto arg=item["argument"];std::string s=arg["text"];internalEdit=true;SendMessage(editor(),SCI_ADDTEXT,s.size(),(LPARAM)s.c_str());fields.clear();for(auto&f:arg.value("fields",json::array()))fields.push_back({f["index"],f["start"],f["end"]});internalEdit=false;startFields();}
    else request(command.c_str(),item["argument"]);hidePane();
  }else if(item.contains("start")){
    std::string file=item.value("file","");if(file==filename()&&!current(visible)){error("The file changed. Refresh these results before navigating.");return;}
    if(file!=filename())SendMessage(npp._nppHandle,NPPM_DOOPEN,0,(LPARAM)wide(file).c_str());
    if(filename()==file){SendMessage(editor(),SCI_SETSEL,item["start"].get<int>(),item["end"].get<int>());SendMessage(editor(),SCI_SCROLLCARET,0,0);SetFocus(editor());}
  }
}
static void display(json r){
  if(!current(r))return;std::string kind=r.value("kind","");
  if(kind=="error"){error(r.value("text","Unknown worker error"));return;}
  if(kind=="datasetSelection"){showDatasetSelection(r);return;}
  if(kind=="hover"){if(r.value("position",-1)!=hoverPosition||issueHover(hoverPosition))return;auto s=r.value("text","");if(!s.empty())showHint(r.value("position",0),s);return;}
  if(kind=="completion"){
    if(r.value("position",-1)!=(intptr_t)SendMessage(editor(),SCI_GETCURRENTPOS,0,0))return;
    completion=r;std::string labels;for(auto&i:r["items"]){if(!labels.empty())labels+='\n';labels+=i["label"].get<std::string>();}
    if(!labels.empty()){SendMessage(editor(),SCI_AUTOCSETSEPARATOR,'\n',0);SendMessage(editor(),SCI_AUTOCSETORDER,2,0);SendMessage(editor(),SCI_AUTOCSHOW,0,(LPARAM)labels.c_str());}return;
  }
  if(kind=="issues"){
    diagnostics=r;
    if(visible.value("kind","")=="issues" && visible.value("file","")==r.value("file","") && visible.value("status","")==r.value("status","") && visible["items"]==r["items"]){visible=std::move(r);return;}
    const auto statusText=r.value("status","CGMES");profileStatusAvailable=statusText!="Not a supported CIM file";auto status=wide(statusText);SendMessage(npp._nppHandle,NPPM_SETSTATUSBAR,STATUSBAR_DOC_TYPE,(LPARAM)status.c_str());
    HWND e=editor();if(indicator>=0){SendMessage(e,SCI_SETINDICATORCURRENT,indicator,0);SendMessage(e,SCI_INDICATORCLEARRANGE,0,SendMessage(e,SCI_GETLENGTH,0,0));SendMessage(e,SCI_INDICSETSTYLE,indicator,INDIC_SQUIGGLE);SendMessage(e,SCI_INDICSETFORE,indicator,RGB(230,90,30));
    for(auto&i:r["items"])if(i.value("file","")==filename()){int start=i["start"],end=i["end"];SendMessage(e,SCI_INDICATORFILLRANGE,start,std::max(1,end-start));}}
    // Background checks update the panel only when it is already displaying issues.
    bool show=r.value("show",false);if((!IsWindowVisible(window)||visible.value("kind","")!="issues")&&!show)return;
  }
  bool wasVisible=IsWindowVisible(window);json previous=std::move(visible);visible=std::move(r);populate(previous);if(!wasVisible)showPane();
}
static LRESULT CALLBACK wndproc(HWND h,UINT msg,WPARAM w,LPARAM l){
  if(msg==WM_CREATE){INITCOMMONCONTROLSEX ic{sizeof(ic),ICC_TREEVIEW_CLASSES};InitCommonControlsEx(&ic);listbox=CreateWindow(L"LISTBOX",L"",WS_CHILD|WS_VISIBLE|WS_VSCROLL|WS_HSCROLL|LBS_NOTIFY|LBS_NOINTEGRALHEIGHT,8,40,800,290,h,(HMENU)101,instance,nullptr);issueTree=CreateWindowEx(WS_EX_CLIENTEDGE,WC_TREEVIEW,L"",WS_CHILD|WS_VSCROLL|WS_HSCROLL|TVS_HASBUTTONS|TVS_HASLINES|TVS_LINESATROOT|TVS_SHOWSELALWAYS,8,40,800,290,h,(HMENU)107,instance,nullptr);details=CreateWindow(L"EDIT",L"",WS_CHILD|WS_VISIBLE|WS_VSCROLL|ES_MULTILINE|ES_READONLY,8,340,800,90,h,(HMENU)102,instance,nullptr);CreateWindow(L"BUTTON",L"Apply / Go",WS_CHILD|WS_VISIBLE,8,8,110,26,h,(HMENU)103,instance,nullptr);CreateWindow(L"BUTTON",L"Group by severity",WS_CHILD|WS_VISIBLE,130,8,150,26,h,(HMENU)104,instance,nullptr);CreateWindow(L"BUTTON",L"Group by check",WS_CHILD|WS_VISIBLE,290,8,150,26,h,(HMENU)105,instance,nullptr);return 0;}
  if(msg==WM_SIZE){int width=LOWORD(l),height=HIWORD(l);int bw=std::max(40,(width-32)/3);for(int id=103;id<=105;++id)MoveWindow(GetDlgItem(h,id),8+(id-103)*(bw+8),8,bw,26,TRUE);MoveWindow(listbox,8,40,std::max(1,width-16),std::max(40,height-150),TRUE);MoveWindow(issueTree,8,40,std::max(1,width-16),std::max(40,height-150),TRUE);MoveWindow(details,8,std::max(85,height-104),width-16,96,TRUE);return 0;}
  if(msg==WM_CLOSE){hidePane();return 0;}
  if(msg==WM_COMMAND){if(LOWORD(w)==106){hideHint();request("profiles");return 0;}if(LOWORD(w)==103||(LOWORD(w)==101&&HIWORD(w)==LBN_DBLCLK))choose();if(LOWORD(w)==101&&HIWORD(w)==LBN_SELCHANGE){int n=(int)SendMessage(listbox,LB_GETCURSEL,0,0);if(n>=0&&n<(int)visible["items"].size())SetWindowText(details,wide(visible["items"][n].value("detail",visible["items"][n].value("label",""))).c_str());}if((LOWORD(w)==104||LOWORD(w)==105)&&visible.value("kind","")=="issues"){issueGrouping=LOWORD(w)==104?"severity":"code";populateIssues();}return 0;}
  if(msg==WM_NOTIFY&&((NMHDR*)l)->hwndFrom==issueTree){
    auto header=(NMHDR*)l;
    if((header->code==TVN_SELCHANGEDA||header->code==TVN_SELCHANGEDW)&&!buildingIssueTree){int n=selectedIssue();if(n>=0&&n<(int)visible["items"].size())SetWindowText(details,wide(visible["items"][n].value("detail","")).c_str());else SetWindowText(details,L"Select an issue to see details.");}
    if(header->code==NM_DBLCLK&&selectedIssue()>=0)choose();
    if(header->code==TVN_KEYDOWN&&((NMTVKEYDOWN*)l)->wVKey==VK_RETURN)choose();
    return 0;
  }
  if(msg==WM_TIMER&&(datasetDialog||identifierDialog)){if(w==1)KillTimer(h,1);return 0;}
  if(msg==WM_TIMER){if(w==4){RECT a{},b{};GetClientRect(npp._nppHandle,&a);MapWindowPoints(npp._nppHandle,nullptr,(POINT*)&a,2);GetWindowRect(hintWindow,&b);if(!IsWindowVisible(hintWindow)||b.left<a.left||b.top<a.top||b.right>a.right||b.bottom>a.bottom){hideHint();KillTimer(h,4);}return 0;}if(w==3){POINT p;GetCursorPos(&p);RECT r{};GetWindowRect(hintWindow,&r);if(!PtInRect(&r,p)){hideHint();KillTimer(h,3);}return 0;}if(w==1)KillTimer(h,1);if(w==1||w==2)request("validate");return 0;}
  if(msg==RESULT){auto value=(json*)l;try{display(std::move(*value));}catch(const std::exception&e){error(e.what());}delete value;return 0;}
  return DefWindowProc(h,msg,w,l);
}
static void completeCmd(){request("complete");}static void hoverCmd(){hoverAt(SendMessage(editor(),SCI_GETCURRENTPOS,0,0));}static void outlineCmd(){request("outline");}static void defCmd(){promptIdentifier("findDefinitionById");}static void refsCmd(){promptIdentifier("findReferencesById");}
static void issuesCmd(){visible={{"kind","issues"},{"items",json::array()}};showPane();request("validate");}static void profilesCmd(){request("profiles");}static void versionsCmd(){request("versions");}static void reloadCmd(){request("reload");}static void automaticCmd(){request("dataset",json::array());}static void validateDatasetCmd(){visible={{"kind","issues"},{"items",json::array()}};showPane();request("validateDataset");}
static void aboutCmd(){MessageBoxW(npp._nppHandle,L"CGMES & NC Profile Hints for Notepad++\nVersion " CGMES_NOTEPAD_VERSION,L"About CGMES & NC Profile Hints",MB_OK|MB_ICONINFORMATION);}
static void datasetCmd(){std::vector<wchar_t> names(65536);OPENFILENAME ofn{};ofn.lStructSize=sizeof(ofn);ofn.hwndOwner=npp._nppHandle;ofn.lpstrFilter=L"CIM/XML\0*.xml;*.rdf;*.cimxml\0All files\0*.*\0";ofn.lpstrFile=names.data();ofn.nMaxFile=(DWORD)names.size();ofn.Flags=OFN_ALLOWMULTISELECT|OFN_EXPLORER|OFN_FILEMUSTEXIST;if(GetOpenFileName(&ofn)){json files=json::array();std::wstring first=names.data();auto next=names.data()+first.size()+1;if(!*next)files.push_back(utf8(first));else while(*next){std::wstring name=next;files.push_back(utf8(first+L"\\"+name));next+=name.size()+1;}request("dataset",files);}}
static void openDatasetCmd(){request("openDatasetSelection");}
static void folderCmd(){BROWSEINFO bi{};bi.hwndOwner=npp._nppHandle;bi.lpszTitle=L"Choose a folder whose CIM files form the dataset";bi.ulFlags=BIF_RETURNONLYFSDIRS|BIF_NEWDIALOGSTYLE;auto id=SHBrowseForFolder(&bi);if(id){wchar_t p[MAX_PATH]{};if(SHGetPathFromIDList(id,p))request("datasetFolder",utf8(p));CoTaskMemFree(id);}}
static void membersCmd(){request("datasetMembers");}
static ShortcutKey completionKey{true,false,false,VK_SPACE};
static FuncItem functions[]={
 {L"Complete CIM/XML",completeCmd,0,false,&completionKey},{L"Show hover information",hoverCmd},{L"Show issues",issuesCmd},{L"Object outline",outlineCmd},{L"Go to definition by mRID...",defCmd},{L"Find references by mRID...",refsCmd},{L"Select profile for this file",profilesCmd},{L"Select CIM version for this file",versionsCmd},{L"Choose dataset files...",datasetCmd},{L"Choose open files to validate together...",openDatasetCmd},{L"Dataset: automatic",automaticCmd},{L"Validate selected dataset",validateDatasetCmd},{L"Reload profiles and settings",reloadCmd},{L"Choose dataset folder...",folderCmd},{L"Show dataset files",membersCmd},{L"About CGMES & NC Profile Hints",aboutCmd}};
extern "C" __declspec(dllexport) const wchar_t* getName(){return L"CGMES & NC Profile Hints";}
extern "C" __declspec(dllexport) BOOL isUnicode(){return TRUE;}
extern "C" __declspec(dllexport) FuncItem* getFuncsArray(int*n){*n=sizeof(functions)/sizeof(functions[0]);return functions;}
extern "C" __declspec(dllexport) void setInfo(NppData data){npp=data;wchar_t p[32768]{};GetModuleFileName(instance,p,32768);base=p;base=base.substr(0,base.find_last_of(L"\\"));GetEnvironmentVariable(L"APPDATA",p,32768);config=std::wstring(p)+L"\\CGMESNotepad\\settings.json";WNDCLASS wc{};wc.hInstance=instance;wc.lpfnWndProc=wndproc;wc.lpszClassName=L"CGMESNotepadResults";wc.hCursor=LoadCursor(nullptr,IDC_ARROW);wc.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);RegisterClass(&wc);window=CreateWindow(wc.lpszClassName,L"CGMES — Issues, outline and actions",WS_CHILD|WS_CLIPCHILDREN,0,0,380,600,npp._nppHandle,nullptr,instance,nullptr);SendMessage(npp._scintillaMainHandle,SCI_SETMOUSEDWELLTIME,700,0);SendMessage(npp._scintillaSecondHandle,SCI_SETMOUSEDWELLTIME,700,0);mainProc=(WNDPROC)SetWindowLongPtr(npp._scintillaMainHandle,GWLP_WNDPROC,(LONG_PTR)editorProc);if(npp._scintillaSecondHandle!=npp._scintillaMainHandle)secondProc=(WNDPROC)SetWindowLongPtr(npp._scintillaSecondHandle,GWLP_WNDPROC,(LONG_PTR)editorProc);if(!SendMessage(npp._nppHandle,NPPM_ALLOCATEINDICATOR,1,(LPARAM)&indicator))indicator=-1;hookStatus();SetTimer(window,2,2500,nullptr);}
extern "C" __declspec(dllexport) void beNotified(SCNotification*n){if(snapshotting)return;
  if(n->nmhdr.code==NPPN_SHUTDOWN){KillTimer(window,1);KillTimer(window,2);KillTimer(window,3);KillTimer(window,4);if(statusProc)SetWindowLongPtr(statusWindow,GWLP_WNDPROC,(LONG_PTR)statusProc);if(hintWindow)DestroyWindow(hintWindow);if(mainProc)SetWindowLongPtr(npp._scintillaMainHandle,GWLP_WNDPROC,(LONG_PTR)mainProc);if(secondProc)SetWindowLongPtr(npp._scintillaSecondHandle,GWLP_WNDPROC,(LONG_PTR)secondProc);{std::lock_guard<std::mutex> lock(mutex);stopping=true;requests.clear();}condition.notify_one();if(process)TerminateProcess(process,0);if(thread.joinable()){CancelSynchronousIo((HANDLE)thread.native_handle());thread.join();}if(inputPipe)CloseHandle(inputPipe);if(outputPipe)CloseHandle(outputPipe);if(process)CloseHandle(process);MSG m;while(PeekMessage(&m,window,RESULT,RESULT,PM_REMOVE))delete (json*)m.lParam;DestroyWindow(window);window=nullptr;return;}
  if(n->nmhdr.code==SCN_MODIFIED&&(n->modificationType&(SC_MOD_INSERTTEXT|SC_MOD_DELETETEXT))){hideHint();++revision;if(n->nmhdr.hwndFrom!=editor()){snapshotReady=false;SetTimer(window,1,700,nullptr);return;}if(!internalEdit&&!fields.empty()&&snippetFile==filename())adjustFields((int)n->position,(n->modificationType&SC_MOD_DELETETEXT)?(int)n->length:0,(n->modificationType&SC_MOD_INSERTTEXT)?(int)n->length:0);rememberBuffer(filename(),text());SetTimer(window,1,700,nullptr);}
  if(n->nmhdr.code==NPPN_READY||n->nmhdr.code==NPPN_BUFFERACTIVATED){hideHint();hookStatus();SendMessage(npp._scintillaMainHandle,SCI_SETMOUSEDWELLTIME,700,0);SendMessage(npp._scintillaSecondHandle,SCI_SETMOUSEDWELLTIME,700,0);}
  if(n->nmhdr.code==NPPN_BUFFERACTIVATED||n->nmhdr.code==NPPN_FILESAVED){++revision;if(filename()!=snippetFile)fields.clear();SetTimer(window,1,350,nullptr);}
  if(n->nmhdr.code==NPPN_FILEOPENED||n->nmhdr.code==NPPN_FILESAVED)snapshotReady=false;
  if(n->nmhdr.code==NPPN_FILEBEFORECLOSE){wchar_t name[32768]{};SendMessage(npp._nppHandle,NPPM_GETFULLPATHFROMBUFFERID,n->nmhdr.idFrom,(LPARAM)name);buffers.erase(utf8(name));++revision;}
  if(n->nmhdr.code==SCN_CHARADDED&&n->nmhdr.hwndFrom==editor()&&(n->ch=='<'||n->ch=='"'))request("complete");
  if(n->nmhdr.code==SCN_DWELLSTART&&n->nmhdr.hwndFrom==editor()&&n->position>=0)hoverAt(n->position);
  if(n->nmhdr.code==SCN_DWELLEND){hoverPosition=-1;SetTimer(window,3,300,nullptr);SendMessage(editor(),SCI_CALLTIPCANCEL,0,0);}
  if(n->nmhdr.code==SCN_AUTOCSELECTION&&n->nmhdr.hwndFrom==editor()&&!completion.is_null()&&n->text&&completion.value("position",-1)==(intptr_t)SendMessage(editor(),SCI_GETCURRENTPOS,0,0)){for(auto&i:completion["items"])if(i.value("label","")==n->text){SendMessage(editor(),SCI_AUTOCCANCEL,0,0);applyEdits(i,completion);break;}}
}
extern "C" __declspec(dllexport) LRESULT messageProc(UINT,WPARAM,LPARAM){return TRUE;}
BOOL WINAPI DllMain(HINSTANCE h,DWORD reason,LPVOID){if(reason==DLL_PROCESS_ATTACH){instance=h;DisableThreadLibraryCalls(h);}return TRUE;}






