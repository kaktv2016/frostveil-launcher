/** Fixed Windows metadata observer. Path data travels separately as JSON on stdin. */
export const inspectCacheScript = String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class FrostveilCacheCensus {
    const uint ReadAttributes = 0x80;
    const uint ReadDataAndAttributes = 0x81;
    const uint ShareRead = 1;
    const uint OpenExisting = 3;
    const uint BackupSemantics = 0x02000000;
    const uint OpenReparsePoint = 0x00200000;
    const int DirectoryAttribute = 0x10;
    const int ReparsePointAttribute = 0x400;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string file, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int infoClass, byte[] bytes, uint length);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder result, uint length, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern bool GetDiskFreeSpaceExW(string root, out ulong available, out ulong capacity, out ulong totalFree);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern bool GetDiskFreeSpaceW(string root, out uint sectorsPerCluster, out uint bytesPerSector,
        out uint freeClusters, out uint totalClusters);

    public class Entry {
        public string path, volumeId, fileId, generation, logicalBytes, allocatedBytes;
        public uint linkCount;
        public bool directory;
    }

    public class Root {
        public string path, state, volumeId, fileId, generation, ancestorPath, ancestorFileId, ancestorGeneration;
    }

    public class Volume {
        public string volumeId, availableBytes, allocationUnitBytes;
    }

    public class Result {
        public Root root;
        public Volume volume;
        public string error;
        public List<Entry> files = new List<Entry>();
        public List<Entry> directories = new List<Entry>();
        public int entries;
    }

    static Exception NativeError() {
        return new Win32Exception(Marshal.GetLastWin32Error());
    }

    static byte[] Info(SafeFileHandle file, int infoClass, int length) {
        var bytes = new byte[length];
        if (!GetFileInformationByHandleEx(file, infoClass, bytes, (uint)length)) throw NativeError();
        return bytes;
    }

    static SafeFileHandle Open(string candidate, bool allowMissing, uint access = ReadAttributes) {
        // Deny concurrent write/delete handles while walking each component. Attribute reads
        // alone need no enumerate/read-data permission on ancestors outside the raw roots.
        var handle = CreateFileW(@"\\?\" + candidate, access, ShareRead,
            IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        int error = Marshal.GetLastWin32Error();
        handle.Dispose();
        if (allowMissing && error == 2) return null;
        throw new Win32Exception(error);
    }

    static string FinalPath(SafeFileHandle file, uint flags) {
        var output = new StringBuilder(1024);
        uint length = GetFinalPathNameByHandleW(file, output, (uint)output.Capacity, flags);
        if (length == 0) throw NativeError();
        if (length >= output.Capacity) {
            if (length > 32768) throw new InvalidDataException("INVALID_ENTRY");
            output = new StringBuilder((int)length + 1);
            length = GetFinalPathNameByHandleW(file, output, (uint)output.Capacity, flags);
            if (length == 0) throw NativeError();
            if (length >= output.Capacity) throw new InvalidDataException("INVALID_ENTRY");
        }
        return output.ToString();
    }

    static string VolumeRoot(SafeFileHandle file) {
        var finalPath = FinalPath(file, 1);
        var end = finalPath.IndexOf('}');
        if (!finalPath.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase) || end < 0 ||
            end + 1 >= finalPath.Length || finalPath[end + 1] != '\\')
            throw new InvalidDataException("UNSUPPORTED_VOLUME");
        return finalPath.Substring(0, end + 2);
    }

    static Entry Observe(SafeFileHandle file, string expected, string volumeRoot, bool comparePath) {
        var basic = Info(file, 0, 40);
        int attributes = BitConverter.ToInt32(basic, 32);
        if ((attributes & ReparsePointAttribute) != 0) throw new InvalidDataException("REDIRECTED_PATH");
        var standard = Info(file, 1, 24);
        if (standard[20] != 0) throw new InvalidDataException("UNSTABLE_ENTRY");
        var id = Info(file, 18, 24);
        string canonical = expected;
        if (comparePath) {
            var nativePath = FinalPath(file, 0);
            if (!nativePath.StartsWith(@"\\?\", StringComparison.Ordinal) ||
                !String.Equals(nativePath.Substring(4), expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("REDIRECTED_PATH");
            canonical = nativePath.Substring(4);
        }
        long created = BitConverter.ToInt64(basic, 0);
        long written = BitConverter.ToInt64(basic, 16);
        long changed = BitConverter.ToInt64(basic, 24);
        long logical = BitConverter.ToInt64(standard, 8);
        long allocated = BitConverter.ToInt64(standard, 0);
        bool directory = (attributes & DirectoryAttribute) != 0;
        if (created <= 0 || changed <= 0 || written <= 0 || allocated < 0 || logical < 0 ||
            directory != (standard[21] != 0)) throw new InvalidDataException("INVALID_ENTRY");
        return new Entry {
            path = canonical,
            volumeId = "VOL:" + volumeRoot.Substring(10).TrimEnd('\\').ToUpperInvariant() +
                ":" + BitConverter.ToString(id, 0, 8).Replace("-", ""),
            fileId = BitConverter.ToString(id, 8, 16).Replace("-", ""),
            generation = created.ToString("X16") + ":" + written.ToString("X16") + ":" + changed.ToString("X16"),
            logicalBytes = logical.ToString(CultureInfo.InvariantCulture),
            allocatedBytes = allocated.ToString(CultureInfo.InvariantCulture),
            linkCount = BitConverter.ToUInt32(standard, 16), directory = directory
        };
    }

    static Volume Measure(string volumeRoot, string volumeId) {
        ulong available, capacity, totalFree;
        uint sectors, bytes, freeClusters, clusters;
        if (!GetDiskFreeSpaceExW(volumeRoot, out available, out capacity, out totalFree) ||
            !GetDiskFreeSpaceW(volumeRoot, out sectors, out bytes, out freeClusters, out clusters)) throw NativeError();
        ulong unit = (ulong)sectors * bytes;
        if (unit == 0 || available > capacity) throw new InvalidDataException("UNSUPPORTED_VOLUME");
        return new Volume { volumeId = volumeId, availableBytes = available.ToString(CultureInfo.InvariantCulture),
            allocationUnitBytes = unit.ToString(CultureInfo.InvariantCulture) };
    }

    static bool Same(Entry before, Entry after) {
        return before.path == after.path && before.fileId == after.fileId && before.volumeId == after.volumeId &&
            before.generation == after.generation && before.logicalBytes == after.logicalBytes &&
            before.allocatedBytes == after.allocatedBytes && before.linkCount == after.linkCount &&
            before.directory == after.directory;
    }

    static void VerifyStreams(SafeFileHandle file, bool directory) {
        byte[] info;
        try { info = Info(file, 7, 4096); }
        catch (Win32Exception error) {
            if (directory && error.NativeErrorCode == 38) return; // A directory may have no data stream.
            if (error.NativeErrorCode == 234 || error.NativeErrorCode == 122)
                throw new InvalidDataException("UNSUPPORTED_STREAM");
            throw;
        }
        uint next = BitConverter.ToUInt32(info, 0);
        int nameBytes = BitConverter.ToInt32(info, 4);
        if (next != 0 || nameBytes != 14 || Encoding.Unicode.GetString(info, 24, nameBytes) != "::$DATA")
            throw new InvalidDataException("UNSUPPORTED_STREAM");
    }

    static void Walk(SafeFileHandle directory, Entry before, string volumeRoot, Result result, int limit, int depth,
        bool childrenOnly) {
        if (depth > 64) throw new InvalidDataException("ENTRY_LIMIT");
        VerifyStreams(directory, true);
        result.directories.Add(before);
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var childPath in Directory.EnumerateFileSystemEntries(before.path)) {
            if (++result.entries > limit) throw new InvalidDataException("ENTRY_LIMIT");
            if (!names.Add(childPath)) throw new InvalidDataException("UNSTABLE_ENTRY");
            using (var child = Open(childPath, false, ReadDataAndAttributes)) {
                var observed = Observe(child, childPath, volumeRoot, true);
                if (observed.volumeId != before.volumeId) throw new InvalidDataException("REDIRECTED_PATH");
                if (childrenOnly) {
                    if (!observed.directory) throw new InvalidDataException("INVALID_ENTRY");
                    result.directories.Add(observed);
                } else if (observed.directory) {
                    Walk(child, observed, volumeRoot, result, limit, depth + 1, false);
                } else {
                    if (observed.linkCount == 0) throw new InvalidDataException("INVALID_ENTRY");
                    VerifyStreams(child, false);
                    if (!Same(observed, Observe(child, childPath, volumeRoot, false)))
                        throw new InvalidDataException("UNSTABLE_ENTRY");
                    result.files.Add(observed);
                }
            }
        }
        if (!Same(before, Observe(directory, before.path, volumeRoot, false)))
            throw new InvalidDataException("UNSTABLE_ENTRY");
    }

    public static Result Scan(string candidate, string mode, int limit) {
        var result = new Result();
        var chain = new List<SafeFileHandle>();
        try {
            string current = Path.GetPathRoot(candidate);
            string suffix = candidate.Substring(current.Length);
            string[] parts = suffix.Length == 0 ? new string[0] : suffix.Split('\\');
            string volumeRoot = null;
            for (int index = 0; index <= parts.Length; index++) {
                if (index > 0) current = Path.Combine(current, parts[index - 1]);
                bool leaf = index == parts.Length;
                var access = leaf && mode != "volume" ? ReadDataAndAttributes : ReadAttributes;
                var handle = Open(current, index > 0, access);
                if (handle == null) {
                    if (mode == "file") throw new InvalidDataException("INVALID_ENTRY");
                    var parent = Observe(chain[chain.Count - 1], result.root.ancestorPath, volumeRoot, true);
                    if (parent.fileId != result.root.ancestorFileId || parent.generation != result.root.ancestorGeneration)
                        throw new InvalidDataException("UNSTABLE_ENTRY");
                    result.root.path = Path.Combine(result.root.ancestorPath,
                        String.Join("\\", parts, index - 1, parts.Length - index + 1));
                    result.root.state = "ABSENT";
                    result.root.fileId = null;
                    result.root.generation = null;
                    return result;
                }
                chain.Add(handle);
                if (volumeRoot == null) volumeRoot = VolumeRoot(handle);
                var entry = Observe(handle, current, volumeRoot, true);
                if (result.root != null && result.root.volumeId != entry.volumeId)
                    throw new InvalidDataException("REDIRECTED_PATH");
                if (leaf && mode == "file") {
                    if (entry.directory || entry.linkCount == 0) throw new InvalidDataException("INVALID_ENTRY");
                    VerifyStreams(handle, false);
                    if (!Same(entry, Observe(handle, current, volumeRoot, true)))
                        throw new InvalidDataException("UNSTABLE_ENTRY");
                    result.files.Add(entry);
                    return result;
                }
                if (!entry.directory) throw new InvalidDataException("INVALID_ENTRY");
                result.root = new Root {
                    path = entry.path, state = "PRESENT", volumeId = entry.volumeId,
                    fileId = entry.fileId, generation = entry.generation, ancestorPath = entry.path,
                    ancestorFileId = entry.fileId, ancestorGeneration = entry.generation
                };
                if (result.volume == null) result.volume = Measure(volumeRoot, entry.volumeId);
                current = entry.path;
                if (leaf && (mode == "census" || mode == "children"))
                    Walk(handle, entry, volumeRoot, result, limit, 0, mode == "children");
            }
            result.volume = Measure(volumeRoot, result.root.volumeId);
        } catch (InvalidDataException error) {
            result.error = error.Message;
        } catch (Win32Exception error) {
            result.error = error.NativeErrorCode == 32 || error.NativeErrorCode == 2 || error.NativeErrorCode == 3
                ? "UNSTABLE_ENTRY" : "MEASUREMENT_FAILED";
        } catch (IOException) {
            result.error = "MEASUREMENT_FAILED";
        } catch (UnauthorizedAccessException) {
            result.error = "MEASUREMENT_FAILED";
        } finally {
            foreach (var handle in chain) handle.Dispose();
        }
        return result;
    }

    static bool SameEntries(List<Entry> before, List<Entry> after) {
        if (before.Count != after.Count) return false;
        before.Sort((first, second) => StringComparer.Ordinal.Compare(first.path, second.path));
        after.Sort((first, second) => StringComparer.Ordinal.Compare(first.path, second.path));
        for (int index = 0; index < before.Count; index++)
            if (!Same(before[index], after[index])) return false;
        return true;
    }

    public static void Verify(Result before, Result after) {
        if (after.error != null || before.root.path != after.root.path || before.root.state != after.root.state ||
            before.root.volumeId != after.root.volumeId || before.root.fileId != after.root.fileId ||
            before.root.generation != after.root.generation || before.root.ancestorPath != after.root.ancestorPath ||
            before.root.ancestorFileId != after.root.ancestorFileId ||
            before.root.ancestorGeneration != after.root.ancestorGeneration ||
            before.volume.allocationUnitBytes != after.volume.allocationUnitBytes ||
            !SameEntries(before.files, after.files) || !SameEntries(before.directories, after.directories)) {
            before.error = after.error ?? "UNSTABLE_ENTRY";
        } else if (UInt64.Parse(after.volume.availableBytes) < UInt64.Parse(before.volume.availableBytes)) {
            before.volume.availableBytes = after.volume.availableBytes;
        }
    }
}
'@
$results = [Collections.Generic.List[object]]::new()
$remaining = [int]$request.limit
foreach ($root in $request.roots) {
    $result = [FrostveilCacheCensus]::Scan([string]$root, [string]$request.mode, $remaining)
    $remaining -= $result.entries
    $results.Add($result)
    if ($remaining -lt 0) { break }
}
if ($request.mode -eq 'census' -and $results.Count -eq @($request.roots).Count) {
    $remaining = [int]$request.limit
    for ($index = 0; $index -lt $results.Count; $index++) {
        if ($null -ne $results[$index].error) { continue }
        $observed = [FrostveilCacheCensus]::Scan([string]$request.roots[$index], 'census', $remaining)
        $remaining -= $observed.entries
        [FrostveilCacheCensus]::Verify($results[$index], $observed)
        if ($remaining -lt 0) { break }
    }
}
if ($request.mode -ne 'children') {
    foreach ($result in $results) { $result.directories.Clear() }
}
[Console]::Write((ConvertTo-Json -InputObject @($results.ToArray()) -Depth 7 -Compress))
`;
