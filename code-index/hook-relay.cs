// hook-relay.cs — ZCode 钩子 GUI 子系统中继(闪窗方案 C' 本地等效,2026-11-13 审查落地)
//
// 背景:ZCode 对 type:'process' 钩子的 spawn 未传 windowsHide(C 本体,已提反馈);Windows 下
// 控制台子系统 exe(node)被 spawn 时必分配可见 conhost ⇒ 每条钩子入口闪一窗。B 方案(wscript/VBS)
// 死因是 GUI 宿主没有 std 句柄——本中继与之本质不同:**GUI 子系统 ≠ 无 std**:ZCode 用管道创建进程时
// std 句柄由父进程显式传入,GUI 子系统 exe 拿到的就是这些管道句柄,原样继承给 node 即可。
//
// 语义:hook-relay.exe <script.mjs> [args…] → node <script.mjs> [args…]
//   - 入口零闪:GUI 子系统(WinExe)永不分配控制台(Windows 语义,与重定向无关);
//   - 子进程零闲:node 以 CREATE_NO_WINDOW 启动(UseShellExecute=false + CreateNoWindow);
//   - stdio 零改动:三路句柄全继承(node 直接对着 ZCode 的管道收发 JSON),中继不碰字节,无编码面;
//   - 超时级联:Job Object(REQ_LIMIT_KILL_ON_JOB_CLOSE)——ZCode 超时杀掉本中继时,
//     作业句柄随进程关闭,node 连同孙进程整树被系统回收,不留孤儿(auto.mjs 420s 场景);
//   - 退出码透传;异常输出到 stderr 并以 3 退出(hook 契约:失败不阻断会话由宿主裁决)。
// 编译(Windows 自带 .NET Framework csc,C# 5 语法子集):
//   csc /nologo /target:winexe /out:bin/hook-relay.exe hook-relay.cs
// 部署:code-index/bin/hook-relay.exe(本地编译产物,不入 git);init.mjs ensureHookRelay 按需重编。

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;

class HookRelay
{
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, IntPtr lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int cb);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("hook-relay: 用法 hook-relay.exe <script.mjs> [args...]");
            return 2;
        }

        var psi = new ProcessStartInfo();
        psi.FileName = "node";
        var sb = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            if (i > 0) sb.Append(' ');
            if (args[i].IndexOf(' ') >= 0 || args[i].IndexOf('"') >= 0)
                sb.Append('"').Append(args[i].Replace("\"", "\"\"")).Append('"');
            else
                sb.Append(args[i]);
        }
        psi.Arguments = sb.ToString();
        // 三路显式重定向 + 二进制流搬运(2026-11-14 T1 挂起修正):GUI 父进程 + CREATE_NO_WINDOW
        // 子进程时,.NET 默认不把父进程 std 句柄传给子进程(STARTF_USESTDHANDLES 未设,子进程
        // 无控制台 → 句柄无效)。改为:子进程三路重定向,中继用 BaseStream 原始字节搬运
        // (CopyTo 不做任何编码处理,CJK/二进制零失真),句柄链 = ZCode 管道 ↔ 中继 ↔ node。
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;

        try
        {
            using (Process p = Process.Start(psi))
            {
                // 级联杀:中继被宿主超时终止时,作业句柄关闭 → 整树回收
                IntPtr job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
                if (job != IntPtr.Zero)
                {
                    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info,
                        Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
                    AssignProcessToJobObject(job, p.Handle);
                }

                var tIn = new Thread(delegate()
                {
                    try { Console.OpenStandardInput().CopyTo(p.StandardInput.BaseStream); }
                    catch { /* 上游关了就结束 */ }
                    try { p.StandardInput.BaseStream.Dispose(); } catch { /* 子进程已退出 */ }
                });
                var tOut = new Thread(delegate()
                {
                    try { p.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()); }
                    catch { /* 下游关了就结束 */ }
                });
                var tErr = new Thread(delegate()
                {
                    try { p.StandardError.BaseStream.CopyTo(Console.OpenStandardError()); }
                    catch { /* 下游关了就结束 */ }
                });
                tIn.IsBackground = true; tOut.IsBackground = true; tErr.IsBackground = true;
                tIn.Start(); tOut.Start(); tErr.Start();

                p.WaitForExit();
                tOut.Join(2000); // stdout 冲完再退(退出码面),stderr 容忍丢尾
                return p.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("hook-relay: " + e.Message);
            return 3;
        }
    }
}
