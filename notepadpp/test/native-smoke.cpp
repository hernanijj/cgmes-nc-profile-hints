#define UNICODE
#include <windows.h>
#include <commctrl.h>
#include <iostream>
#include <string>
#include <vector>
#include "../vendor/Scintilla.h"
#include "../vendor/Notepad_plus_msgs.h"
struct NppData{HWND a,b,c;};struct Key{bool a,b,c;UCHAR d;};struct Item{wchar_t name[64];void(*fn)();int id;bool checked;Key*key;};struct DockedWidgetData{HWND hClient;const wchar_t* name;int dlgID;UINT uMask;HICON hIconTab;const wchar_t* addInfo;RECT rcFloat;int iPrevCont;const wchar_t* moduleName;};
static std::vector<std::vector<std::string>> docs={{"<","unsaved sibling sentinel\xE9"},{"split view sentinel\xC3\x55"}};
static HWND pane=nullptr;static bool dockShown=false;static UINT dockMask=0;
static std::string calltip;static std::string suggestions;static int start=0,end=0,active=0,indices[2]={0,0},selectionStart=0,selectionEnd=1;static HWND mainEditor,secondEditor;
static std::wstring treeText(HWND tree,HTREEITEM item){wchar_t text[8192]{};TVITEM value{};value.mask=TVIF_TEXT;value.hItem=item;value.pszText=text;value.cchTextMax=8192;TreeView_GetItem(tree,&value);return text;}
static HTREEITEM treeRoot(HWND tree,const std::wstring& label){for(auto item=TreeView_GetRoot(tree);item;item=TreeView_GetNextSibling(tree,item))if(treeText(tree,item)==label)return item;return nullptr;}
static HTREEITEM treeGroup(HWND tree,HTREEITEM root,const std::wstring& prefix){for(auto item=root?TreeView_GetChild(tree,root):nullptr;item;item=TreeView_GetNextSibling(tree,item))if(treeText(tree,item).find(prefix)==0)return item;return nullptr;}
static void pump(DWORD duration){DWORD until=GetTickCount()+duration;while(GetTickCount()<until){MSG msg;while(PeekMessage(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessage(&msg);}Sleep(10);}}
static void readHint(){HWND tip=FindWindow(L"STATIC",L"CGMES Hover");if(!tip)return;HWND edit=GetDlgItem(tip,301);int n=GetWindowTextLengthA(edit);std::string value(n+1,0);GetWindowTextA(edit,value.data(),n+1);value.resize(n);calltip=value;}
LRESULT CALLBACK host(HWND h,UINT m,WPARAM w,LPARAM l){
 if(m==NPPM_DMMREGASDCKDLG){auto data=(DockedWidgetData*)l;pane=data->hClient;dockMask=data->uMask;return TRUE;}
 if(m==NPPM_DMMSHOW){dockShown=true;ShowWindow((HWND)l,SW_SHOW);return TRUE;}
 if(m==NPPM_DMMHIDE){ShowWindow((HWND)l,SW_HIDE);return TRUE;}
 if(m==NPPM_GETCURRENTSCINTILLA){*(int*)l=active;return TRUE;}
 if(m==NPPM_GETCURRENTDOCINDEX)return indices[l];if(m==NPPM_GETNBOPENFILES)return l==1?2:l==2?1:3;
 if(m==NPPM_ACTIVATEDOC){active=(int)w;indices[active]=(int)l;return TRUE;}
 if(m==NPPM_GETFULLCURRENTPATH){std::wstring name=L"C:\\cgmes-smoke-"+std::to_wstring(active)+L"-"+std::to_wstring(indices[active])+L".xml";wcscpy((wchar_t*)l,name.c_str());return TRUE;}
 int view=h==secondEditor?1:0;auto&document=docs[view][indices[view]];
 if(m==SCI_GETLENGTH)return document.size();if(m==SCI_GETTEXT){strcpy((char*)l,document.c_str());return document.size();}if(m==SCI_GETCURRENTPOS)return selectionEnd;
 if(m==SCI_SETSEL){selectionStart=(int)w;selectionEnd=(int)l;return 0;}
 if(m==SCI_CALLTIPSHOW){calltip=(char*)l;return 0;}
 if(m==SCI_AUTOCSHOW){suggestions=(char*)l;return 0;}
 if(m==SCI_SETTARGETSTART)start=(int)w;if(m==SCI_SETTARGETEND)end=(int)w;
 if(m==SCI_REPLACETARGET){document.replace(start,end-start,(char*)l,w);return w;}
 return DefWindowProc(h,m,w,l);
}
int main(){
 HMODULE dll=LoadLibraryW(L"dist\\CGMESNotepad\\CGMESNotepad.dll");if(!dll){std::cerr<<"LoadLibrary failed "<<GetLastError();return 1;}
 auto name=(const wchar_t*(*)())GetProcAddress(dll,"getName");auto unicode=(BOOL(*)())GetProcAddress(dll,"isUnicode");auto items=(Item*(*)(int*))GetProcAddress(dll,"getFuncsArray");auto set=(void(*)(NppData))GetProcAddress(dll,"setInfo");auto notify=(void(*)(SCNotification*))GetProcAddress(dll,"beNotified");
 if(!name||!unicode||!items||!set||!notify||!unicode())return 2;
 WNDCLASS wc{};wc.hInstance=GetModuleHandle(nullptr);wc.lpfnWndProc=host;wc.lpszClassName=L"CGMES_TEST_HOST";RegisterClass(&wc);HWND h=CreateWindow(wc.lpszClassName,L"",WS_OVERLAPPEDWINDOW,100,100,640,480,nullptr,nullptr,wc.hInstance,nullptr);
 mainEditor=CreateWindow(wc.lpszClassName,L"",0,0,0,0,0,nullptr,nullptr,wc.hInstance,nullptr);secondEditor=CreateWindow(wc.lpszClassName,L"",0,0,0,0,0,nullptr,nullptr,wc.hInstance,nullptr);
 INITCOMMONCONTROLSEX ic{sizeof(ic),ICC_BAR_CLASSES};InitCommonControlsEx(&ic);HWND status=CreateWindow(STATUSCLASSNAME,L"",WS_CHILD,0,0,600,24,h,nullptr,wc.hInstance,nullptr);int parts[]={400,-1};SendMessage(status,SB_SETPARTS,2,(LPARAM)parts);
 set({h,mainEditor,secondEditor});int n=0;auto cmds=items(&n);auto has=[&](const wchar_t* label){for(int i=0;i<n;++i)if(lstrcmpW(cmds[i].name,label)==0)return true;return false;};
 if(n!=15||!has(L"Go to definition by mRID...")||!has(L"Find references by mRID...")||has(L"Quick fixes at cursor")||has(L"New CIM/XML document")||has(L"Edit settings (save then Reload)"))return 3;cmds[0].fn();
 DWORD until=GetTickCount()+15000;while(suggestions.empty()&&GetTickCount()<until){MSG msg;while(PeekMessage(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessage(&msg);}Sleep(10);}
 int result=0;if(suggestions.empty()){std::cerr<<"No completion response";result=4;}else{
  std::string first=suggestions.substr(0,suggestions.find('\n'));SCNotification selection{};selection.nmhdr.code=SCN_AUTOCSELECTION;selection.nmhdr.hwndFrom=mainEditor;selection.text=first.c_str();notify(&selection);
  auto&document=docs[0][0];if(document.find("rdf:RDF")==std::string::npos||document.find("${")!=std::string::npos){std::cerr<<"Completion insertion failed";result=5;}
  int firstStart=selectionStart;SendMessage(mainEditor,WM_KEYDOWN,VK_TAB,0);SendMessage(mainEditor,WM_CHAR,'\t',0);
  if(selectionStart==firstStart){std::cerr<<"Tab did not select next snippet field";result=6;}
  if(active!=0||indices[0]!=0||indices[1]!=0||docs[0][1]!="unsaved sibling sentinel\xE9"||docs[1][0]!="split view sentinel\xC3\x55"){std::cerr<<"Buffer capture altered content or active tab";result=7;}
 }
 SendMessage(status,WM_LBUTTONUP,0,MAKELPARAM(20,10));DWORD choiceUntil=GetTickCount()+15000;bool choices=false;
 while(!choices&&GetTickCount()<choiceUntil){MSG msg;while(PeekMessage(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessage(&msg);}if(pane&&SendMessage(GetDlgItem(pane,101),LB_GETCOUNT,0,0)>1)choices=true;Sleep(10);}
 wchar_t firstChoice[512]{};if(pane)SendMessage(GetDlgItem(pane,101),LB_GETTEXT,0,(LPARAM)firstChoice);if(std::wstring(firstChoice)!=L"Automatic"){std::cerr<<"Automatic choice missing";return 16;}
 if(!choices||!dockShown||!(GetWindowLongPtr(pane,GWL_STYLE)&WS_CHILD)||(dockMask&0x00000008)==0){std::cerr<<"Bottom-docked profile menu failed";result=8;}
 docs[0][0]="<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:cim=\"http://iec.ch/TC57/2013/CIM-schema-cim16#\"><cim:ACLineSegment rdf:ID=\"_line\"><cim:ConductingEquipment.BaseVoltage rdf:resource=\"#_missing_target\"/></cim:ACLineSegment></rdf:RDF>";
 selectionEnd=(int)docs[0][0].find("cim:ACLineSegment")+6;
 SCNotification dwell{};dwell.nmhdr.code=SCN_DWELLSTART;dwell.nmhdr.hwndFrom=mainEditor;dwell.position=selectionEnd;notify(&dwell);readHint();
 DWORD hoverUntil=GetTickCount()+15000;while(calltip.empty()&&GetTickCount()<hoverUntil){readHint();MSG msg;while(PeekMessage(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessage(&msg);}Sleep(10);}
 if(calltip.find("ACLineSegment")==std::string::npos){std::cerr<<"Hover calltip failed";result=9;}
 cmds[2].fn();DWORD issuesUntil=GetTickCount()+15000;bool issueRows=false;
 while(!issueRows&&GetTickCount()<issuesUntil){MSG msg;while(PeekMessage(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessage(&msg);}if(pane&&TreeView_GetCount(GetDlgItem(pane,107))>0)issueRows=true;Sleep(10);}
 if(!issueRows){std::cerr<<"No issue rows";result=10;}else{
 SetWindowText(GetDlgItem(pane,102),L"Keep selection details");SendMessage(pane,WM_TIMER,2,0);
 DWORD refreshUntil=GetTickCount()+3500;while(GetTickCount()<refreshUntil){MSG msg;while(PeekMessage(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessage(&msg);}Sleep(10);}
 wchar_t detailsText[100]{};GetWindowText(GetDlgItem(pane,102),detailsText,100);if(std::wstring(detailsText)!=L"Keep selection details"){std::cerr<<"Unchanged poll rebuilt panel";result=11;}}
 calltip.clear();dwell.position=(int)docs[0][0].find("_line")+2;notify(&dwell);readHint();
 if(calltip.find("UUID")==std::string::npos){std::cerr<<"Diagnostic tooltip missing identifier error";result=12;}
 calltip.clear();dwell.position=(int)docs[0][0].find("#_missing_target")+3;notify(&dwell);readHint();
 if(calltip.empty()||calltip.find("missing_target")==std::string::npos){std::cerr<<"Reference diagnostic tooltip missing";result=14;}
 dwell.position=(int)docs[0][0].find("_line")+2;
 // Switching pane contents must not discard diagnostic hover data.
 cmds[6].fn();DWORD tipUntil=GetTickCount()+500;while(GetTickCount()<tipUntil){MSG msg;while(PeekMessage(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessage(&msg);}Sleep(10);}
 calltip.clear();notify(&dwell);readHint();if(calltip.find("UUID")==std::string::npos){std::cerr<<"Diagnostic tooltip lost after opening profile menu";result=13;}
 HWND tip=FindWindow(L"STATIC",L"CGMES Hover");RECT tr{},hr{};GetWindowRect(tip,&tr);GetClientRect(h,&hr);MapWindowPoints(h,nullptr,(POINT*)&hr,2);
 if(!tip||tr.left<hr.left||tr.top<hr.top||tr.right>hr.right||tr.bottom>hr.bottom){std::cerr<<"Hint exceeds host window";result=15;}
 cmds[2].fn();pump(500);
 HWND tree=GetDlgItem(pane,107);SendMessage(pane,WM_COMMAND,105,0);
 auto fileRoot=treeRoot(tree,L"File and identifiers");auto fileGroup=fileRoot?TreeView_GetChild(tree,fileRoot):nullptr;
 if(!fileGroup||treeText(tree,fileGroup).find(L"id-uuid")!=0){std::cerr<<"Check grouping missing";result=17;}
 if(fileRoot){TreeView_Expand(tree,fileRoot,TVE_COLLAPSE);if(TreeView_GetItemState(tree,fileRoot,TVIS_EXPANDED)&TVIS_EXPANDED){std::cerr<<"Tree did not collapse";result=21;}}
 auto insert=docs[0][0].find("</cim:ACLineSegment>");docs[0][0].insert(insert,"<cim:ACLineSegment.r>abc</cim:ACLineSegment.r>");
 SCNotification changed{};changed.nmhdr.code=SCN_MODIFIED;changed.nmhdr.hwndFrom=mainEditor;changed.modificationType=SC_MOD_INSERTTEXT;notify(&changed);SendMessage(pane,WM_TIMER,2,0);
 DWORD changedUntil=GetTickCount()+15000;bool refreshed=false;
 while(!refreshed&&GetTickCount()<changedUntil){pump(20);auto schema=treeRoot(tree,L"Schema (RDFS)");for(auto group=schema?TreeView_GetChild(tree,schema):nullptr;group;group=TreeView_GetNextSibling(tree,group))if(treeText(tree,group).find(L"datatype")==0)refreshed=true;}
 fileRoot=treeRoot(tree,L"File and identifiers");fileGroup=fileRoot?TreeView_GetChild(tree,fileRoot):nullptr;
 if(!refreshed||!fileGroup||treeText(tree,fileGroup).find(L"id-uuid")!=0||(TreeView_GetItemState(tree,fileRoot,TVIS_EXPANDED)&TVIS_EXPANDED)){std::cerr<<"Changed refresh lost grouping or collapsed state; refreshed="<<refreshed<<" fileGroup="<<(fileGroup!=nullptr)<<" expanded="<<(fileRoot?(TreeView_GetItemState(tree,fileRoot,TVIS_EXPANDED)&TVIS_EXPANDED):0);result=18;}
 docs[0][0]="<?xml version=\"1.0\"?><rdf:RDF xmlns:cim=\"http://iec.ch/TC57/2013/CIM-schema-cim16#\" xmlns:md=\"http://iec.ch/TC57/61970-552/ModelDescription/1#\" xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><md:FullModel rdf:about=\"urn:uuid:2bfc1c0e-6b39-4e5c-9a7e-3f3b0d2c6a12\"><md:Model.profile>http://entsoe.eu/CIM/EquipmentCore/3/1</md:Model.profile></md:FullModel><cim:TransformerEnd rdf:ID=\"_e1\"/><cim:RatioTapChanger rdf:ID=\"_r1\"><cim:RatioTapChanger.TransformerEnd rdf:resource=\"#_e1\"/><cim:TapChanger.highStep>abc</cim:TapChanger.highStep></cim:RatioTapChanger></rdf:RDF>";
 notify(&changed);SendMessage(pane,WM_TIMER,2,0);DWORD sourcesUntil=GetTickCount()+15000;bool sources=false;
 while(!sources&&GetTickCount()<sourcesUntil){pump(20);sources=treeRoot(tree,L"Schema (RDFS)")&&treeRoot(tree,L"SHACL");}
 if(!sources){std::cerr<<"Schema and SHACL categories missing";result=19;}
 auto schema=treeRoot(tree,L"Schema (RDFS)");auto shacl=treeRoot(tree,L"SHACL");
 if(!treeGroup(tree,schema,L"datatype")||!treeGroup(tree,shacl,L"datatype")){std::cerr<<"Shared schema/SHACL diagnostic missing";result=22;}
 SendMessage(pane,WM_COMMAND,104,0);schema=treeRoot(tree,L"Schema (RDFS)");if(!treeGroup(tree,schema,L"error")){std::cerr<<"Severity grouping missing";result=23;}
 SendMessage(pane,WM_COMMAND,105,0);schema=treeRoot(tree,L"Schema (RDFS)");auto branch=schema?TreeView_GetChild(tree,schema):nullptr;auto leaf=branch?TreeView_GetChild(tree,branch):nullptr;
 if(leaf){TreeView_SelectItem(tree,leaf);selectionStart=selectionEnd=0;SendMessage(pane,WM_COMMAND,103,0);if(selectionEnd<=selectionStart){std::cerr<<"Issue navigation failed";result=20;}}else{std::cerr<<"Issue leaf missing";result=20;}
 SCNotification shutdown{};shutdown.nmhdr.code=NPPN_SHUTDOWN;notify(&shutdown);DestroyWindow(h);FreeLibrary(dll);
 if(!result)std::cout<<"PASS: DLL ABI, worker IPC, completion, buffer capture, issue tree categories, grouping and collapse across refresh, issue navigation, diagnostic hover, docking and shutdown\n";return result;
}

