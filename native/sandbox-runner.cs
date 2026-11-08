// Runs one PowerShell command inside a Windows AppContainer and a Job Object.
//
// The AppContainer gives the command no access to the user's files, registry or network
// unless explicitly granted: only the workspace is granted here. The Job Object caps
// resources and kills the whole process tree when this runner exits for any reason.
//
// Known gap: ALL APPLICATION PACKAGES can read HKCUEnvironment, so anything stored with
// `setx` is visible here. A Less Privileged AppContainer would close that, but Windows
// PowerShell 5.1 cannot start inside one. API keys therefore belong in config.json.
//
// Usage: sandbox-runner <container-name> <workspace> <network|no-network> <powershell-command>
//
// Every failure aborts the run. There is deliberately no unsandboxed fallback.
// Compiled at runtime by the .NET Framework csc.exe, which only supports C# 5.
using System;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

internal static class SandboxRunner
{
    private const int SetupFailedExitCode = 125;
    private const int ErrorAlreadyExists = unchecked((int)0x800700B7);

    private const string InternetClientCapability = "internetClient";

    private const int ProcThreadAttributeHandleList = 0x00020002;
    private const int ProcThreadAttributeSecurityCapabilities = 0x00020009;

    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const int StartfUseStdHandles = 0x00000100;

    private const int JobObjectBasicUiRestrictions = 4;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobLimitKillOnClose = 0x00002000;
    private const uint JobLimitActiveProcess = 0x00000008;
    private const uint JobLimitJobMemory = 0x00000200;
    private const uint JobUiLimitAll = 0x000000FF;

    private const uint MaxActiveProcesses = 64;
    private const ulong MaxJobMemoryBytes = 4UL * 1024 * 1024 * 1024;

    private const uint GroupEnabled = 0x00000004;
    private const uint HandleFlagInherit = 0x00000001;
    private const uint WaitInfinite = 0xFFFFFFFF;

    private static int Main(string[] args)
    {
        if (args.Length != 4)
        {
            Console.Error.WriteLine("sandbox-runner: expected 4 arguments");
            return SetupFailedExitCode;
        }

        try
        {
            return Run(args[0], args[1], args[2] == "network", args[3]);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("sandbox-runner: " + error.Message);
            return SetupFailedExitCode;
        }
    }

    private static int Run(string containerName, string workspace, bool network, string command)
    {
        IntPtr containerSid = GetContainerSid(containerName);
        string containerSidText = SidToString(containerSid);

        GrantWorkspaceAccess(workspace, containerSidText);
        PrepareEnvironment(containerSidText);

        IntPtr job = CreateLimitedJob();
        ProcessInformation process = StartSuspended(containerSid, workspace, network, command);

        // Assigned while suspended, so the command cannot start anything outside the job.
        Check(AssignProcessToJobObject(job, process.Process), "AssignProcessToJobObject");
        if (ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception();

        WaitForSingleObject(process.Process, WaitInfinite);
        uint exitCode;
        Check(GetExitCodeProcess(process.Process, out exitCode), "GetExitCodeProcess");

        // Exiting closes the job handle, which kills anything the command left running.
        return (int)exitCode;
    }

    private static IntPtr GetContainerSid(string name)
    {
        IntPtr sid;
        int result = CreateAppContainerProfile(name, name, "Personal Agent command sandbox", IntPtr.Zero, 0, out sid);
        if (result == ErrorAlreadyExists) result = DeriveAppContainerSidFromAppContainerName(name, out sid);
        if (result != 0) throw new Win32Exception(result, "AppContainer profile failed: 0x" + result.ToString("X8"));
        return sid;
    }

    private static string SidToString(IntPtr sid)
    {
        IntPtr text;
        Check(ConvertSidToStringSid(sid, out text), "ConvertSidToStringSid");
        return Marshal.PtrToStringUni(text);
    }

    private static void GrantWorkspaceAccess(string workspace, string containerSidText)
    {
        SecurityIdentifier container = new SecurityIdentifier(containerSidText);
        DirectoryInfo directory = new DirectoryInfo(workspace);
        DirectorySecurity security = directory.GetAccessControl(AccessControlSections.Access);

        bool alreadyGranted = security
            .GetAccessRules(true, false, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .Any(rule => rule.IdentityReference.Equals(container)
                && rule.AccessControlType == AccessControlType.Allow
                && (rule.FileSystemRights & FileSystemRights.Modify) == FileSystemRights.Modify);
        if (alreadyGranted) return;

        security.AddAccessRule(new FileSystemAccessRule(
            container,
            FileSystemRights.Modify,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
        directory.SetAccessControl(security);
    }

    private static void PrepareEnvironment(string containerSidText)
    {
        IntPtr folderText;
        int result = GetAppContainerFolderPath(containerSidText, out folderText);
        if (result != 0) throw new Win32Exception(result, "GetAppContainerFolderPath failed");
        string folder = Marshal.PtrToStringUni(folderText);

        // CreateProcess requires the real LOCALAPPDATA and derives the container's own
        // LOCALAPPDATA and TEMP from it, so those two must not be pointed at the folder here.
        Environment.SetEnvironmentVariable(
            "LOCALAPPDATA",
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        Environment.SetEnvironmentVariable("USERPROFILE", folder);
        Environment.SetEnvironmentVariable("HOME", folder);
        Environment.SetEnvironmentVariable("APPDATA", Path.Combine(folder, "Roaming"));
    }

    private static IntPtr CreateLimitedJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();

        JobObjectExtendedLimit limits = new JobObjectExtendedLimit();
        limits.Basic.LimitFlags = JobLimitKillOnClose | JobLimitActiveProcess | JobLimitJobMemory;
        limits.Basic.ActiveProcessLimit = MaxActiveProcesses;
        limits.JobMemoryLimit = new UIntPtr(MaxJobMemoryBytes);
        Check(
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(limits)),
            "SetInformationJobObject (limits)");

        uint uiRestrictions = JobUiLimitAll;
        Check(
            SetInformationJobObject(job, JobObjectBasicUiRestrictions, ref uiRestrictions, sizeof(uint)),
            "SetInformationJobObject (UI)");
        return job;
    }

    private static ProcessInformation StartSuspended(
        IntPtr containerSid,
        string workspace,
        bool network,
        string command)
    {
        IntPtr[] capabilities = network ? new[] { CapabilitySid(InternetClientCapability) } : new IntPtr[0];

        int capabilitySize = Marshal.SizeOf(typeof(SidAndAttributes));
        IntPtr capabilityArray = capabilities.Length == 0
            ? IntPtr.Zero
            : Marshal.AllocHGlobal(capabilitySize * capabilities.Length);
        for (int index = 0; index < capabilities.Length; index++)
        {
            SidAndAttributes capability = new SidAndAttributes { Sid = capabilities[index], Attributes = GroupEnabled };
            Marshal.StructureToPtr(capability, IntPtr.Add(capabilityArray, capabilitySize * index), false);
        }

        SecurityCapabilities security = new SecurityCapabilities
        {
            AppContainerSid = containerSid,
            Capabilities = capabilityArray,
            CapabilityCount = (uint)capabilities.Length,
        };
        IntPtr securityPointer = Marshal.AllocHGlobal(Marshal.SizeOf(security));
        Marshal.StructureToPtr(security, securityPointer, false);

        // Only the stdio handles reach the command, nothing else this process holds.
        IntPtr[] handles = new[] { GetStdHandle(-10), GetStdHandle(-11), GetStdHandle(-12) }
            .Where(handle => handle != IntPtr.Zero && handle != new IntPtr(-1))
            .Distinct()
            .ToArray();
        foreach (IntPtr handle in handles)
        {
            Check(SetHandleInformation(handle, HandleFlagInherit, HandleFlagInherit), "SetHandleInformation");
        }
        IntPtr handleListPointer = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
        Marshal.Copy(handles, 0, handleListPointer, handles.Length);

        IntPtr listSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref listSize);
        IntPtr attributeList = Marshal.AllocHGlobal(listSize);
        Check(InitializeProcThreadAttributeList(attributeList, 2, 0, ref listSize), "InitializeProcThreadAttributeList");
        Check(
            UpdateProcThreadAttribute(
                attributeList, 0, new IntPtr(ProcThreadAttributeSecurityCapabilities), securityPointer,
                new IntPtr(Marshal.SizeOf(security)), IntPtr.Zero, IntPtr.Zero),
            "UpdateProcThreadAttribute (security)");
        Check(
            UpdateProcThreadAttribute(
                attributeList, 0, new IntPtr(ProcThreadAttributeHandleList), handleListPointer,
                new IntPtr(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero),
            "UpdateProcThreadAttribute (handles)");

        StartupInfoEx startup = new StartupInfoEx();
        startup.StartupInfo.Size = Marshal.SizeOf(startup);
        startup.StartupInfo.Flags = StartfUseStdHandles;
        startup.StartupInfo.StdInput = GetStdHandle(-10);
        startup.StartupInfo.StdOutput = GetStdHandle(-11);
        startup.StartupInfo.StdError = GetStdHandle(-12);
        startup.AttributeList = attributeList;

        string powershell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe");
        StringBuilder commandLine = new StringBuilder(
            "\"" + powershell + "\" -NoLogo -NoProfile -NonInteractive -OutputFormat Text -Command \"" + command + "\"");

        ProcessInformation process;
        Check(
            CreateProcess(
                powershell, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                ExtendedStartupInfoPresent | CreateSuspended | CreateNoWindow | CreateUnicodeEnvironment,
                IntPtr.Zero, workspace, ref startup, out process),
            "CreateProcess");
        return process;
    }

    private static IntPtr CapabilitySid(string name)
    {
        IntPtr groupSids;
        uint groupCount;
        IntPtr capabilitySids;
        uint capabilityCount;
        Check(
            DeriveCapabilitySidsFromName(name, out groupSids, out groupCount, out capabilitySids, out capabilityCount),
            "DeriveCapabilitySidsFromName");
        if (capabilityCount == 0) throw new InvalidOperationException("No SID for capability " + name);
        return Marshal.ReadIntPtr(capabilitySids);
    }

    private static void Check(bool succeeded, string operation)
    {
        if (succeeded) return;
        int code = Marshal.GetLastWin32Error();
        throw new Win32Exception(code, operation + " failed with error " + code);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityCapabilities
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimit
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
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimit
    {
        public JobObjectBasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved;
        public string Desktop;
        public string Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public int Flags;
        public short ShowWindow;
        public short Reserved2;
        public IntPtr Reserved3;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public int ProcessId;
        public int ThreadId;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(
        string name, string displayName, string description, IntPtr capabilities, uint capabilityCount, out IntPtr sid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int GetAppContainerFolderPath(string sid, out IntPtr path);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr text);

    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool DeriveCapabilitySidsFromName(
        string name,
        out IntPtr groupSids,
        out uint groupSidCount,
        out IntPtr capabilitySids,
        out uint capabilitySidCount);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateJobObjectW")]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int infoClass, ref JobObjectExtendedLimit info, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref uint info, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr list, int attributeCount, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
    private static extern bool CreateProcess(
        string application,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);
}
