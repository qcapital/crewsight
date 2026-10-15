// CrewSight raw-input observer. READ-ONLY: registers for WM_INPUT with RIDEV_INPUTSINK so it
// receives relative mouse counts (pre-OS-acceleration) while another app has focus.
// It never injects, blocks, hooks or modifies input, and never touches other processes' memory.
// Output (stdout, one line each, ~100 Hz max):
//   M <dx> <dy>        aggregated relative mouse counts since last line
//   K <0|1>            state of the ONE key passed via --vk (e.g. free-look); no other keys reported
//   F <0|1>            whether the foreground window's process name contains --fg filter
//   G <0|1>            foreground app runs elevated (admin) while we don't: Windows then withholds its input
//   H                  heartbeat every second
// Build: scripts/build-native.ps1 (uses csc.exe from .NET Framework 4, present on Windows 10/11).
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class RawMouse
{
    [StructLayout(LayoutKind.Sequential)] struct RAWINPUTDEVICE { public ushort UsagePage, Usage; public uint Flags; public IntPtr Target; }
    [StructLayout(LayoutKind.Sequential)] struct RAWINPUTHEADER { public uint Type, Size; public IntPtr Device, wParam; }
    [StructLayout(LayoutKind.Sequential)] struct RAWMOUSE { public ushort Flags; public ushort Pad; public ushort ButtonFlags, ButtonData; public uint RawButtons; public int LastX, LastY; public uint Extra; }
    [StructLayout(LayoutKind.Sequential)] struct RAWKEYBOARD { public ushort MakeCode, Flags, Reserved, VKey; public uint Message, Extra; }

    [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] d, uint n, uint size);
    [DllImport("user32.dll")] static extern uint GetRawInputData(IntPtr h, uint cmd, IntPtr data, ref uint size, uint hdrSize);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr t, int cls, out int info, int len, out int ret);

    const int WM_INPUT = 0x00FF; const uint RID_INPUT = 0x10000003; const uint RIDEV_INPUTSINK = 0x100;
    const ushort MOUSE_MOVE_ABSOLUTE = 1; const ushort RI_KEY_BREAK = 1;

    static long dx, dy; static int vk = -1; static bool keyDown; static string fg = ""; static int lastFocus = -1; static int lastElev = -1;

    class Sink : NativeWindow
    {
        public Sink() { CreateHandle(new CreateParams()); }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_INPUT) Handle(m.LParam);
            base.WndProc(ref m);
        }
    }

    static void Handle(IntPtr hRaw)
    {
        uint hdr = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER)); uint size = 0;
        GetRawInputData(hRaw, RID_INPUT, IntPtr.Zero, ref size, hdr);
        if (size == 0 || size > 1024) return;
        IntPtr buf = Marshal.AllocHGlobal((int)size);
        try
        {
            if (GetRawInputData(hRaw, RID_INPUT, buf, ref size, hdr) != size) return;
            var h = (RAWINPUTHEADER)Marshal.PtrToStructure(buf, typeof(RAWINPUTHEADER));
            IntPtr body = IntPtr.Add(buf, (int)hdr);
            if (h.Type == 0)
            {
                var m = (RAWMOUSE)Marshal.PtrToStructure(body, typeof(RAWMOUSE));
                if ((m.Flags & MOUSE_MOVE_ABSOLUTE) == 0) { dx += m.LastX; dy += m.LastY; }
            }
            else if (h.Type == 1 && vk >= 0)
            {
                var k = (RAWKEYBOARD)Marshal.PtrToStructure(body, typeof(RAWKEYBOARD));
                int key = k.VKey;
                // Generic modifier codes: Alt=0x12 also matches L/R variants.
                bool match = key == vk || (vk == 0x12 && (key == 0xA4 || key == 0xA5));
                if (match)
                {
                    bool down = (k.Flags & RI_KEY_BREAK) == 0;
                    if (down != keyDown) { keyDown = down; Console.Out.WriteLine("K " + (down ? 1 : 0)); }
                }
            }
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    // 1 = process token says elevated, or we can't even open its token (protected/elevated); 0 = not elevated.
    static int Elevated(IntPtr proc)
    {
        IntPtr tok;
        if (proc == IntPtr.Zero || !OpenProcessToken(proc, 0x0008 /*TOKEN_QUERY*/, out tok)) return 1;
        int elev, ret; bool ok = GetTokenInformation(tok, 20 /*TokenElevation*/, out elev, 4, out ret);
        CloseHandle(tok);
        return ok && elev != 0 ? 1 : 0;
    }
    static int ForegroundElevatedVsUs()
    {
        uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        if (pid == 0) return 0;
        IntPtr h = OpenProcess(0x1000 /*PROCESS_QUERY_LIMITED_INFORMATION*/, false, pid);
        int fgElev = Elevated(h); if (h != IntPtr.Zero) CloseHandle(h);
        return fgElev == 1 && Elevated(GetCurrentProcess()) == 0 ? 1 : 0;
    }
    static int FocusMatches()
    {
        if (fg.Length == 0) return 1;
        try
        {
            uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            using (var p = Process.GetProcessById((int)pid))
                return p.ProcessName.IndexOf(fg, StringComparison.OrdinalIgnoreCase) >= 0 ? 1 : 0;
        }
        catch { return 0; }
    }

    [STAThread]
    static int Main(string[] args)
    {
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == "--vk") vk = Convert.ToInt32(args[i + 1], 16);
            if (args[i] == "--fg") fg = args[i + 1];
        }
        Console.Out.Flush();
        var sink = new Sink();
        var devs = new System.Collections.Generic.List<RAWINPUTDEVICE>();
        devs.Add(new RAWINPUTDEVICE { UsagePage = 1, Usage = 2, Flags = RIDEV_INPUTSINK, Target = sink.Handle });
        if (vk >= 0) devs.Add(new RAWINPUTDEVICE { UsagePage = 1, Usage = 6, Flags = RIDEV_INPUTSINK, Target = sink.Handle });
        if (!RegisterRawInputDevices(devs.ToArray(), (uint)devs.Count, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
        { Console.Out.WriteLine("E register " + Marshal.GetLastWin32Error()); return 2; }

        var flush = new Timer { Interval = 10 };
        int ticks = 0;
        flush.Tick += (s, e) =>
        {
            if (dx != 0 || dy != 0) { Console.Out.WriteLine("M " + dx + " " + dy); dx = 0; dy = 0; }
            if (++ticks % 10 == 0)
            {
                int f = FocusMatches();
                if (f != lastFocus) { lastFocus = f; Console.Out.WriteLine("F " + f); }
                int g = ForegroundElevatedVsUs();
                if (g != lastElev) { lastElev = g; Console.Out.WriteLine("G " + g); }
            }
            if (ticks % 100 == 0) Console.Out.WriteLine("H");
            Console.Out.Flush();
        };
        flush.Start();
        // Exit when the parent closes our stdin.
        new System.Threading.Thread(() => { try { while (Console.In.Read() >= 0) { } } catch { } Environment.Exit(0); }) { IsBackground = true }.Start();
        Application.Run();
        return 0;
    }
}
