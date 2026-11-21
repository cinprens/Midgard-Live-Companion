param(
  [Parameter(Mandatory)][uint32]$AppProcess,
  [string]$OutputPng,
  [switch]$BehindFixture,
  [switch]$FocusMain,
  [switch]$AllowUnfocused
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class VisibleClient {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] struct Pt { public int X,Y; }
  delegate bool Visitor(IntPtr hwnd, IntPtr args);
  [DllImport("user32")] static extern bool EnumWindows(Visitor visitor,IntPtr args);
  [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32")] static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32")] static extern bool ClientToScreen(IntPtr hwnd,ref Pt point);
  [DllImport("user32")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
  [DllImport("kernel32")] static extern uint GetCurrentThreadId();
  [DllImport("user32")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
  [DllImport("user32")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32")] static extern IntPtr MonitorFromPoint(Pt point,uint flags);
  [DllImport("dwmapi")] static extern int DwmGetWindowAttribute(IntPtr hwnd,uint attr,out int value,int size);
  [DllImport("dwmapi")] static extern int DwmFlush();

  static IntPtr UniqueVisibleHost(uint pid,bool mainOnly) {
    var hosts = new List<IntPtr>();
    EnumWindows(delegate(IntPtr w,IntPtr _) {
      uint owner; GetWindowThreadProcessId(w,out owner);
      if(owner!=pid || !IsWindowVisible(w) || IsIconic(w))return true;
      int cloaked;
      if(DwmGetWindowAttribute(w,14,out cloaked,4)==0 && cloaked!=0)return true;
      var title = new StringBuilder(160);
      GetWindowText(w,title,title.Capacity);
      if(mainOnly ? title.ToString()!="MIDGARD LIVE" :
           !(title.ToString()=="MIDGARD LIVE" || title.ToString()=="MIDGARD LIVE \u2014 Av Ekibi")) return true;
      Rect r;
      if(GetClientRect(w,out r) && r.R-r.L>=150 && r.B-r.T>=60)hosts.Add(w);
      return true;
    },IntPtr.Zero);
    if(hosts.Count!=1)throw new InvalidOperationException("No unique visible test host, count "+hosts.Count);
    return hosts[0];
  }
  public static bool FocusMainOnly(uint pid) {
    var target=UniqueVisibleHost(pid,true);
    if(GetForegroundWindow()!=target) SetForegroundWindow(target);
    DwmFlush(); Thread.Sleep(120);
    return GetForegroundWindow()==target;
  }

  static string OwnedClient(uint target,IntPtr expected,IntPtr foreground,out IntPtr hwnd,out Rectangle client) {
    var actualForeground = GetForegroundWindow();
    hwnd = expected==IntPtr.Zero ? actualForeground : expected;
    uint owner;
    client = Rectangle.Empty;
    if (foreground!=IntPtr.Zero && foreground!=actualForeground) return "secondary test window is not in foreground";
    GetWindowThreadProcessId(hwnd,out owner);
    if (owner != target || !IsWindowVisible(hwnd) || IsIconic(hwnd)) return "fixture is not in foreground";
    Rect r;
    Pt origin = new Pt();
    if (!GetClientRect(hwnd,out r) || !ClientToScreen(hwnd,ref origin)) return "missing client rectangle";
    client = new Rectangle(origin.X,origin.Y,r.R-r.L,r.B-r.T);
    if (client.Width < 150 || client.Height < 60) return "client size is not ready";
    return null;
  }

  // Enumerate from top to bottom. Reject the capture if any visible higher
  // window intersects it, even when the test window still owns keyboard focus.
  static bool Unobscured(IntPtr target,Rectangle area) {
    bool seen = false;
    EnumWindows(delegate(IntPtr w,IntPtr _) {
      if (w == target) { seen = true; return false; }
      int cloaked;
      if (!IsWindowVisible(w) || IsIconic(w) ||
          (DwmGetWindowAttribute(w,14,out cloaked,4)==0 && cloaked!=0)) return true;
      Rect r;
      return !GetWindowRect(w,out r) || !area.IntersectsWith(Rectangle.FromLTRB(r.L,r.T,r.R,r.B));
    },IntPtr.Zero);
    return seen;
  }

  public static string Capture(uint pid,string file,bool background,bool allowUnfocused) {
    // Use physical client coordinates even on mixed-DPI desktops.
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    Form helper=null;
    try {
      IntPtr expected=allowUnfocused?UniqueVisibleHost(pid,false):IntPtr.Zero, foreground=IntPtr.Zero;
      if (background) {
        Rectangle client; IntPtr owned;
        string unavailable=OwnedClient(pid,expected,IntPtr.Zero,out owned,out client);
        if(unavailable!=null) throw new InvalidOperationException(unavailable);
        var work=Screen.FromRectangle(client).WorkingArea;
        var box=new Rectangle(work.Left+16,work.Top+16,200,82);
        if(box.IntersectsWith(client)) box.Y=work.Bottom-box.Height-16;
        if(box.IntersectsWith(client)) throw new InvalidOperationException("No safe area for second test window");
        helper=new Form {Text="MIDGARD QA",StartPosition=FormStartPosition.Manual,Bounds=box,
                        ShowInTaskbar=false,FormBorderStyle=FormBorderStyle.FixedToolWindow};
        // Activation can be restricted for a recently spawned process. Temporarily
        // share input only with the previously verified foreground fixture thread.
        uint verifiedPid;
        uint thread=GetWindowThreadProcessId(owned,out verifiedPid);
        uint self=GetCurrentThreadId();
        bool joined=verifiedPid==pid && GetForegroundWindow()==owned && AttachThreadInput(self,thread,true);
        try { helper.Show(); helper.Activate(); SetForegroundWindow(helper.Handle); }
        finally { if(joined) AttachThreadInput(self,thread,false); }
        expected=owned; foreground=helper.Handle;
        Application.DoEvents(); DwmFlush(); Thread.Sleep(350);
      }
      var deadline = DateTime.UtcNow.AddSeconds(6);
      string reason;
      do {
        IntPtr hwnd;
        Rectangle client;
        if(helper!=null) Application.DoEvents();
        reason = OwnedClient(pid,expected,foreground,out hwnd,out client);
        if (reason==null) {
          // Inset excludes the rounded corners of Windows 11's normal main window.
          var area = Rectangle.Inflate(client,-10,-10);
          var start = new Pt { X=area.Left,Y=area.Top };
          var end = new Pt { X=area.Right-1,Y=area.Bottom-1 };
          var monitor = MonitorFromPoint(start,0);
          if (monitor==IntPtr.Zero || MonitorFromPoint(end,0)!=monitor) reason="fixture is not wholly on one display";
          else if (!Unobscured(hwnd,area)) reason = "fixture is covered by another window";
          else {
            DwmFlush();
            using (var bitmap=new Bitmap(area.Width,area.Height,PixelFormat.Format24bppRgb)) {
              using (var paint=Graphics.FromImage(bitmap))
                paint.CopyFromScreen(area.Location,Point.Empty,area.Size,CopyPixelOperation.SourceCopy);
              Rectangle after;
              IntPtr owner;
              if (OwnedClient(pid,expected,foreground,out owner,out after)==null && owner==hwnd && client==after && Unobscured(hwnd,area)) {
                bitmap.Save(file,ImageFormat.Png);
                return String.Format("{{\"width\":{0},\"height\":{1},\"inset\":10,\"hwnd\":\"{2}\"}}",
                                     client.Width,client.Height,hwnd.ToInt64());
              }
              reason = "fixture moved during capture";
            }
          }
        }
        Thread.Sleep(100);
      } while(DateTime.UtcNow<deadline);
      throw new InvalidOperationException("No safe capture of test window: "+reason);
    } finally {
      if(helper!=null) { helper.Close(); helper.Dispose(); }
      if(previous!=IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
    }
  }
}
'@
if($FocusMain) {
  [VisibleClient]::FocusMainOnly($AppProcess)
} else {
  if(!$OutputPng){ throw 'An output path is required for capture' }
  [VisibleClient]::Capture($AppProcess, $OutputPng, $BehindFixture.IsPresent, $AllowUnfocused.IsPresent)
}
