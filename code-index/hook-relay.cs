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
//   - 级联只管"中继被强杀"(2026-11-26):node **自行退出**后,中继先清掉 KILL_ON_JOB_CLOSE 再退出——
//     此时作业里只剩 node 有意守护化的后台进程(auto.mjs/embed.mjs/warm.mjs/memorix 捕获),必须放活。
//     此前无条件级联,钩子一返回就把它们全杀:ZCode 钩子恒内联执行(官方文档:async 无效,后台工作
//     靠脚本自己守护化),经本中继的守护化全部失效——提交后保鲜、后台嵌入、预热自愈自 11-13 起在
//     ZCode 下静默失效(embed.log 反复「接管过期嵌入锁」即其痕迹),仅手工 node auto.mjs 能跑完。
//     中继被强杀时走不到解除这一步,级联语义不变;
//   - 中继向 node 传出 TOKENSAVER_RELAY_DETACH_SAFE=1:钩子脚本据此判断"守护化的后台进程能活过本钩子",
//     旧版中继/无中继直启 node 时没有该变量(ZCode 直启无作业也能活,但脚本无从分辨新旧中继,保守走同步)。
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
        // 构建标识:改本文件的行为语义时同步改它。init.mjs#hookRelayStale 以它为唯一真源——
        // exe 里找不到该字面量 = 源码改过而 exe 没重编 → 重编替换(r2 = 解除级联,见文件头)
        psi.EnvironmentVariables["TOKENSAVER_RELAY_BUILD"] = "r2-detach-safe";
        // 告知 node:本中继在 node 自行退出后会解除级联,守护化的后台进程可活过本钩子(见文件头)
        psi.EnvironmentVariables["TOKENSAVER_RELAY_DETACH_SAFE"] = "1";

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
                // node 已自行退出:解除级联,放活作业里剩下的守护化后台进程(中继被强杀时走不到这里)
                if (job != IntPtr.Zero)
                {
                    var off = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                    off.BasicLimitInformation.LimitFlags = 0;
                    SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref off,
                        Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
                }
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
