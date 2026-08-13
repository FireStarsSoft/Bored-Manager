import { mkdir, open, writeFile } from 'fs/promises'
import { dirname, resolve, sep } from 'path'
import { inflateRaw } from 'zlib'
import { promisify } from 'util'

/**
 * Minimal ZIP reader for update archives.
 *
 * Node has no built-in unzip, and `extract-zip` - the obvious choice - hangs
 * (no error, no resolve) inside Electron's main process on archives that
 * contain symlink entries, which GitHub source archives regularly do. An
 * update that silently never finishes is the worst possible failure, so the
 * few hundred lines of the format we actually need are implemented here:
 * central directory, stored and deflated entries, nothing else.
 *
 * Symlink entries are written as plain files containing their target path.
 * Update archives are source trees that never rely on symlinks, and this
 * avoids needing privileges Windows only grants in developer mode.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** Largest possible end-of-central-directory record (22 bytes + comment). */
const MAX_EOCD_SIZE = 22 + 0xffff
const MAX_TOTAL_UNCOMPRESSED = 2 * 1024 * 1024 * 1024

const inflate = promisify(inflateRaw)

interface CentralEntry {
  fileName: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

type FileHandle = Awaited<ReturnType<typeof open>>

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) throw new Error('the archive ends earlier than its index claims')
    filled += bytesRead
  }
  return buffer
}

/** Reject entries whose name would write outside the destination folder. */
function resolveEntryPath(destDir: string, entryName: string): string {
  const root = resolve(destDir)
  const target = resolve(root, entryName.replace(/\\/g, '/'))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`archive entry would be written outside the target folder: ${entryName}`)
  }
  return target
}

async function readCentralDirectory(handle: FileHandle, size: number): Promise<CentralEntry[]> {
  const tailLength = Math.min(size, MAX_EOCD_SIZE)
  const tail = await readAt(handle, size - tailLength, tailLength)

  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('this is not a zip archive (no end-of-central-directory record)')

  const entryCount = tail.readUInt16LE(eocd + 10)
  const directorySize = tail.readUInt32LE(eocd + 12)
  const directoryOffset = tail.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('zip64 archives are not supported')
  }

  const directory = await readAt(handle, directoryOffset, directorySize)
  const entries: CentralEntry[] = []
  let cursor = 0
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('the archive index is corrupt')
    }
    const nameLength = directory.readUInt16LE(cursor + 28)
    const extraLength = directory.readUInt16LE(cursor + 30)
    const commentLength = directory.readUInt16LE(cursor + 32)
    entries.push({
      fileName: directory.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      method: directory.readUInt16LE(cursor + 10),
      compressedSize: directory.readUInt32LE(cursor + 20),
      uncompressedSize: directory.readUInt32LE(cursor + 24),
      localHeaderOffset: directory.readUInt32LE(cursor + 42)
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const handle = await open(zipPath, 'r')
  try {
    const { size } = await handle.stat()
    const entries = await readCentralDirectory(handle, size)

    const total = entries.reduce((sum, e) => sum + e.uncompressedSize, 0)
    if (total > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error('the archive expands to an implausible size')
    }

    await mkdir(destDir, { recursive: true })
    for (const entry of entries) {
      if (entry.fileName.startsWith('__MACOSX/')) continue
      const target = resolveEntryPath(destDir, entry.fileName)
      if (entry.fileName.endsWith('/')) {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(dirname(target), { recursive: true })

      // The local header repeats the name and carries its own extra field,
      // which is often a different length than the central directory's.
      const header = await readAt(handle, entry.localHeaderOffset, 30)
      if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
        throw new Error(`the archive entry "${entry.fileName}" is corrupt`)
      }
      const dataStart =
        entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)

      let content: Buffer
      if (entry.compressedSize === 0) {
        content = Buffer.alloc(0)
      } else {
        const raw = await readAt(handle, dataStart, entry.compressedSize)
        if (entry.method === 0) content = raw
        else if (entry.method === 8) content = await inflate(raw)
        else {
          throw new Error(
            `"${entry.fileName}" uses unsupported compression method ${entry.method}`
          )
        }
      }
      await writeFile(target, content)
    }
  } finally {
    await handle.close()
  }
}
