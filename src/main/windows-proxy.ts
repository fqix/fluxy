// WinINet per-connection options preserve manual, PAC and auto-detect settings.
// https://learn.microsoft.com/windows/win32/wininet/setting-and-retrieving-internet-options
// The helper runs as the current user; it does not change WinHTTP or require elevation.
const interop = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class FluxyInternetOptions {
    [DllImport("wininet.dll", EntryPoint="InternetQueryOptionW", SetLastError=true)]
    static extern bool Query(IntPtr handle, int option, IntPtr buffer, ref int size);
    [DllImport("wininet.dll", EntryPoint="InternetSetOptionW", SetLastError=true)]
    static extern bool Set(IntPtr handle, int option, IntPtr buffer, int size);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr value);
    static int OptionSize = IntPtr.Size == 8 ? 16 : 12;
    static int ValueOffset = IntPtr.Size == 8 ? 8 : 4;
    static int ListSize = IntPtr.Size == 8 ? 32 : 20;
    static IntPtr Allocate(int size) {
        IntPtr p = Marshal.AllocHGlobal(size);
        Marshal.Copy(new byte[size], 0, p, size);
        return p;
    }
    static IntPtr List(IntPtr options) {
        IntPtr p = Allocate(ListSize);
        Marshal.WriteInt32(p, ListSize);
        // A null connection selects the current user's LAN settings.
        Marshal.WriteInt32(p, IntPtr.Size == 8 ? 16 : 8, 4);
        Marshal.WriteIntPtr(p, IntPtr.Size == 8 ? 24 : 16, options);
        return p;
    }
    static void Check(bool success) {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static string[] Read() {
        IntPtr options = Allocate(OptionSize * 4);
        IntPtr list = List(options);
        // FLAGS_UI includes the saved auto-detect flag even when detection failed.
        int[] keys = { 10, 2, 3, 4 };
        try {
            for (int i = 0; i < 4; i++) Marshal.WriteInt32(options, i * OptionSize, keys[i]);
            int size = ListSize;
            Check(Query(IntPtr.Zero, 75, list, ref size));
            string[] result = new string[4];
            result[0] = Marshal.ReadInt32(options, ValueOffset).ToString();
            for (int i = 1; i < 4; i++) {
                IntPtr p = Marshal.ReadIntPtr(options, i * OptionSize + ValueOffset);
                result[i] = p == IntPtr.Zero ? "" : Marshal.PtrToStringUni(p);
            }
            return result;
        } finally {
            for (int i = 1; i < 4; i++) {
                IntPtr p = Marshal.ReadIntPtr(options, i * OptionSize + ValueOffset);
                if (p != IntPtr.Zero) GlobalFree(p);
            }
            Marshal.FreeHGlobal(list);
            Marshal.FreeHGlobal(options);
        }
    }
    public static void Write(int flags, string server, string bypass, string pac) {
        IntPtr options = Allocate(OptionSize * 4);
        IntPtr list = List(options);
        string[] strings = { server, bypass, pac };
        try {
            for (int i = 0; i < 4; i++) Marshal.WriteInt32(options, i * OptionSize, i + 1);
            Marshal.WriteInt32(options, ValueOffset, flags);
            for (int i = 1; i < 4; i++)
                Marshal.WriteIntPtr(options, i * OptionSize + ValueOffset, Marshal.StringToHGlobalUni(strings[i - 1]));
            Check(Set(IntPtr.Zero, 75, list, ListSize));
            Check(Set(IntPtr.Zero, 95, IntPtr.Zero, 0));
            Check(Set(IntPtr.Zero, 37, IntPtr.Zero, 0));
        } finally {
            for (int i = 1; i < 4; i++) {
                IntPtr p = Marshal.ReadIntPtr(options, i * OptionSize + ValueOffset);
                if (p != IntPtr.Zero) Marshal.FreeHGlobal(p);
            }
            Marshal.FreeHGlobal(list);
            Marshal.FreeHGlobal(options);
        }
    }
}
`

export function windowsProxyScript(state?: Record<string, string>) {
    // Encode data separately: saved proxy URLs can contain quotes or PowerShell syntax.
    const payload = Buffer.from(JSON.stringify(state ?? null)).toString('base64')
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -TypeDefinition @'
${interop}
'@
$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
if ($null -ne $value) {
    [FluxyInternetOptions]::Write([int]$value.flags, [string]$value.server, [string]$value.bypass, [string]$value.pac)
} else {
    $result = [FluxyInternetOptions]::Read()
    @{ flags=$result[0]; server=$result[1]; bypass=$result[2]; pac=$result[3] } | ConvertTo-Json -Compress
}
`
    return Buffer.from(script, 'utf16le').toString('base64')
}
