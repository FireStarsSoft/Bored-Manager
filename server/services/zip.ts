import { createReadStream, createWriteStream } from 'fs'
import { chmod, mkdir, open, rm } from 'fs/promises'
import { dirname, resolve, sep } from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { createInflateRaw } from 'zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_EXTRA_ID = 0x0001
const AES_EXTRA_ID = 0x9901
const MAX_EOCD_SIZE = 22 + 0xffff
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024
const UTF8_FLAG = 1 << 11
const ENCRYPTED_FLAGS = (1 << 0) | (1 << 6)
const DATA_DESCRIPTOR_FLAG = 1 << 3
const ALLOWED_FLAGS = UTF8_FLAG | (1 << 1) | (1 << 2)
const UNIX_FILE_TYPE_MASK = 0xf000
const UNIX_REGULAR_FILE = 0x8000
const UNIX_DIRECTORY = 0x4000

export interface ZipLimits {
  maxEntries: number
  maxNameBytes: number
  maxTotalNameBytes: number
  maxCompressedBytesPerEntry: number
  maxTotalCompressedBytes: number
  maxUncompressedBytesPerEntry: number
  maxTotalUncompressedBytes: number
  maxCompressionRatio: number
}

export interface ExtractZipOptions {
  limits?: Partial<ZipLimits>
  signal?: AbortSignal
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxNameBytes: 4 * 1024,
  maxTotalNameBytes: 8 * 1024 * 1024,
  maxCompressedBytesPerEntry: 512 * 1024 * 1024,
  maxTotalCompressedBytes: 512 * 1024 * 1024,
  maxUncompressedBytesPerEntry: 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxCompressionRatio: 200
}

interface CentralEntry {
  fileName: string
  nameBytes: Buffer
  normalizedPath: string
  directory: boolean
  flags: number
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  dataStart: number
  dataEnd: number
}

type FileHandle = Awaited<ReturnType<typeof open>>

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let value = n
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[n] = value >>> 0
  }
  return table
})()

function updateCrc32(current: number, chunk: Buffer): number {
  let crc = current
  for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return crc >>> 0
}

function boundedInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`)
  return value
}

function addWithinFile(offset: number, length: number, fileSize: number, label: string): number {
  boundedInteger(offset, `${label} offset`)
  boundedInteger(length, `${label} length`)
  const end = offset + length
  if (!Number.isSafeInteger(end) || end > fileSize) {
    throw new Error(`${label} lies outside the archive`)
  }
  return end
}

async function readAt(
  handle: FileHandle,
  fileSize: number,
  position: number,
  length: number,
  label: string
): Promise<Buffer> {
  addWithinFile(position, length, fileSize, label)
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) throw new Error(`${label} is truncated`)
    filled += bytesRead
  }
  return buffer
}

function extraFieldProblem(extra: Buffer): string | null {
  let cursor = 0
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) return 'an extra field is truncated'
    const id = extra.readUInt16LE(cursor)
    const length = extra.readUInt16LE(cursor + 2)
    cursor += 4
    if (cursor + length > extra.length) return 'an extra field extends past its record'
    if (id === ZIP64_EXTRA_ID) return 'ZIP64 extra fields are not supported'
    if (id === AES_EXTRA_ID) return 'AES-encrypted entries are not supported'
    cursor += length
  }
  return null
}

function decodeName(bytes: Buffer, flags: number): string {
  if (bytes.length === 0) throw new Error('an archive entry has an empty name')
  let name: string
  if ((flags & UTF8_FLAG) !== 0) {
    name = bytes.toString('utf8')
    if (!Buffer.from(name, 'utf8').equals(bytes)) {
      throw new Error('an archive entry name is not valid UTF-8')
    }
  } else {
    if (bytes.some((byte) => byte >= 0x80)) {
      throw new Error('non-ASCII entry names must use the ZIP UTF-8 flag')
    }
    name = bytes.toString('ascii')
  }
  if (name.includes('\0')) throw new Error('an archive entry name contains a NUL byte')
  return name
}

function normalizeEntryPath(name: string): { path: string; directory: boolean } {
  if (
    name.startsWith('/') ||
    name.startsWith('\\') ||
    name.startsWith('//') ||
    name.startsWith('\\\\') ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new Error(`archive entry has an absolute path: ${name}`)
  }
  if (name.includes('\\')) throw new Error(`archive entry uses a backslash path: ${name}`)
  const directory = name.endsWith('/')
  const withoutSlash = directory ? name.slice(0, -1) : name
  const segments = withoutSlash.split('/')
  if (
    withoutSlash.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`archive entry has an unsafe path: ${name}`)
  }
  return { path: segments.join('/').normalize('NFC'), directory }
}

function validateMode(versionMadeBy: number, externalAttributes: number, directory: boolean): void {
  const creator = versionMadeBy >>> 8
  const unixMode = externalAttributes >>> 16
  const fileType = unixMode & UNIX_FILE_TYPE_MASK
  if (
    creator === 3 &&
    fileType !== 0 &&
    fileType !== UNIX_REGULAR_FILE &&
    fileType !== UNIX_DIRECTORY
  ) {
    throw new Error('archive contains a symlink or special-file entry')
  }
  const modeDirectory = fileType === UNIX_DIRECTORY
  const dosDirectory = (externalAttributes & 0x10) !== 0
  if ((modeDirectory || dosDirectory) && !directory) {
    throw new Error('archive entry file/directory mode disagrees with its name')
  }
  if (fileType === UNIX_REGULAR_FILE && directory) {
    throw new Error('archive entry file/directory mode disagrees with its name')
  }
}

function registerPath(
  path: string,
  directory: boolean,
  seenEntries: Set<string>,
  pathTypes: Map<string, 'file' | 'directory'>
): void {
  const key = path.toLocaleLowerCase('en-US')
  if (seenEntries.has(key)) throw new Error(`archive contains a duplicate path: ${path}`)
  seenEntries.add(key)

  const segments = path.split('/')
  for (let index = 1; index < segments.length; index++) {
    const ancestor = segments.slice(0, index).join('/').toLocaleLowerCase('en-US')
    if (pathTypes.get(ancestor) === 'file') {
      throw new Error(`archive path is below a file entry: ${path}`)
    }
    pathTypes.set(ancestor, 'directory')
  }
  const existing = pathTypes.get(key)
  if (directory) {
    if (existing === 'file') throw new Error(`archive path is both a file and directory: ${path}`)
    pathTypes.set(key, 'directory')
  } else {
    if (existing === 'directory') {
      throw new Error(`archive path is both a file and directory: ${path}`)
    }
    for (const existingPath of pathTypes.keys()) {
      if (existingPath.startsWith(`${key}/`)) {
        throw new Error(`archive path is both a file and directory: ${path}`)
      }
    }
    pathTypes.set(key, 'file')
  }
}

function mergedLimits(overrides: Partial<ZipLimits> | undefined): ZipLimits {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`ZIP limit ${name} is invalid`)
  }
  return limits
}

async function locateEocd(
  handle: FileHandle,
  fileSize: number
): Promise<{ offset: number; record: Buffer }> {
  if (fileSize < 22) throw new Error('this is not a zip archive')
  const tailLength = Math.min(fileSize, MAX_EOCD_SIZE)
  const tailOffset = fileSize - tailLength
  const tail = await readAt(handle, fileSize, tailOffset, tailLength, 'archive tail')
  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) !== EOCD_SIGNATURE) continue
    const commentLength = tail.readUInt16LE(index + 20)
    if (index + 22 + commentLength !== tail.length) continue
    return {
      offset: tailOffset + index,
      record: tail.subarray(index, index + 22)
    }
  }
  throw new Error('this is not a zip archive (no valid end-of-central-directory record)')
}

async function readCentralDirectory(
  handle: FileHandle,
  fileSize: number,
  limits: ZipLimits
): Promise<CentralEntry[]> {
  const { offset: eocdOffset, record: eocd } = await locateEocd(handle, fileSize)
  const disk = eocd.readUInt16LE(4)
  const directoryDisk = eocd.readUInt16LE(6)
  const entriesOnDisk = eocd.readUInt16LE(8)
  const entryCount = eocd.readUInt16LE(10)
  const directorySize = eocd.readUInt32LE(12)
  const directoryOffset = eocd.readUInt32LE(16)
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('multi-disk ZIP archives are not supported')
  }
  if (
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 archives are not supported')
  }
  if (entryCount > limits.maxEntries) throw new Error('the archive contains too many entries')
  if (directorySize > MAX_CENTRAL_DIRECTORY) {
    throw new Error('the archive central directory is too large')
  }
  const directoryEnd = addWithinFile(
    directoryOffset,
    directorySize,
    fileSize,
    'central directory'
  )
  if (directoryEnd !== eocdOffset) {
    throw new Error('the archive central-directory offset or length is inconsistent')
  }
  const directory = await readAt(
    handle,
    fileSize,
    directoryOffset,
    directorySize,
    'central directory'
  )

  const entries: CentralEntry[] = []
  const seenEntries = new Set<string>()
  const pathTypes = new Map<string, 'file' | 'directory'>()
  let cursor = 0
  let totalNameBytes = 0
  let totalCompressed = 0
  let totalDeclaredUncompressed = 0
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > directory.length) throw new Error('the archive index is truncated')
    if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('the archive index has an invalid entry signature')
    }
    const versionMadeBy = directory.readUInt16LE(cursor + 4)
    const versionNeeded = directory.readUInt16LE(cursor + 6)
    const flags = directory.readUInt16LE(cursor + 8)
    const method = directory.readUInt16LE(cursor + 10)
    const crc32 = directory.readUInt32LE(cursor + 16)
    const compressedSize = directory.readUInt32LE(cursor + 20)
    const uncompressedSize = directory.readUInt32LE(cursor + 24)
    const nameLength = directory.readUInt16LE(cursor + 28)
    const extraLength = directory.readUInt16LE(cursor + 30)
    const commentLength = directory.readUInt16LE(cursor + 32)
    const diskStart = directory.readUInt16LE(cursor + 34)
    const externalAttributes = directory.readUInt32LE(cursor + 38)
    const localHeaderOffset = directory.readUInt32LE(cursor + 42)
    const recordLength = 46 + nameLength + extraLength + commentLength
    if (cursor + recordLength > directory.length) {
      throw new Error('the archive index entry extends past the central directory')
    }
    if (versionNeeded >= 45 || diskStart !== 0) throw new Error('ZIP64 or multi-disk entries are not supported')
    if ((flags & ENCRYPTED_FLAGS) !== 0) throw new Error('encrypted ZIP entries are not supported')
    if ((flags & DATA_DESCRIPTOR_FLAG) !== 0) {
      throw new Error('ZIP data-descriptor entries are not supported')
    }
    if ((flags & ~ALLOWED_FLAGS) !== 0) throw new Error('archive entry uses unsupported ZIP flags')
    if (method !== 0 && method !== 8) {
      throw new Error(`archive entry uses unsupported compression method ${method}`)
    }
    if (nameLength > limits.maxNameBytes) throw new Error('an archive entry name is too long')
    totalNameBytes += nameLength
    if (totalNameBytes > limits.maxTotalNameBytes) {
      throw new Error('archive entry names exceed the total name limit')
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new Error('ZIP64 entries are not supported')
    }
    if (compressedSize > limits.maxCompressedBytesPerEntry) {
      throw new Error('an archive entry is too large while compressed')
    }
    if (uncompressedSize > limits.maxUncompressedBytesPerEntry) {
      throw new Error('an archive entry expands beyond the per-entry limit')
    }
    totalCompressed += compressedSize
    totalDeclaredUncompressed += uncompressedSize
    if (totalCompressed > limits.maxTotalCompressedBytes) {
      throw new Error('archive compressed data exceeds the total limit')
    }
    if (totalDeclaredUncompressed > limits.maxTotalUncompressedBytes) {
      throw new Error('archive declared output exceeds the total limit')
    }
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxCompressionRatio)
    ) {
      throw new Error('an archive entry exceeds the compression-ratio limit')
    }

    const nameStart = cursor + 46
    const nameBytes = Buffer.from(directory.subarray(nameStart, nameStart + nameLength))
    const extra = directory.subarray(
      nameStart + nameLength,
      nameStart + nameLength + extraLength
    )
    const extraProblem = extraFieldProblem(extra)
    if (extraProblem) throw new Error(extraProblem)
    const fileName = decodeName(nameBytes, flags)
    const normalized = normalizeEntryPath(fileName)
    validateMode(versionMadeBy, externalAttributes, normalized.directory)
    registerPath(normalized.path, normalized.directory, seenEntries, pathTypes)
    if (normalized.directory && (compressedSize !== 0 || uncompressedSize !== 0 || crc32 !== 0)) {
      throw new Error('a directory entry contains file data')
    }

    entries.push({
      fileName,
      nameBytes,
      normalizedPath: normalized.path,
      directory: normalized.directory,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataStart: 0,
      dataEnd: 0
    })
    cursor += recordLength
  }
  if (cursor !== directory.length) {
    throw new Error('the central directory contains unindexed trailing data')
  }

  const ranges: Array<{ start: number; end: number; name: string }> = []
  for (const entry of entries) {
    const header = await readAt(
      handle,
      fileSize,
      entry.localHeaderOffset,
      30,
      `local header for "${entry.fileName}"`
    )
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new Error(`local header signature is invalid for "${entry.fileName}"`)
    }
    const versionNeeded = header.readUInt16LE(4)
    const flags = header.readUInt16LE(6)
    const method = header.readUInt16LE(8)
    const crc32 = header.readUInt32LE(14)
    const compressedSize = header.readUInt32LE(18)
    const uncompressedSize = header.readUInt32LE(22)
    const nameLength = header.readUInt16LE(26)
    const extraLength = header.readUInt16LE(28)
    if (
      versionNeeded >= 45 ||
      flags !== entry.flags ||
      method !== entry.method ||
      crc32 !== entry.crc32 ||
      compressedSize !== entry.compressedSize ||
      uncompressedSize !== entry.uncompressedSize
    ) {
      throw new Error(`local and central metadata disagree for "${entry.fileName}"`)
    }
    const variableLength = nameLength + extraLength
    const variable = await readAt(
      handle,
      fileSize,
      entry.localHeaderOffset + 30,
      variableLength,
      `local header fields for "${entry.fileName}"`
    )
    const localName = variable.subarray(0, nameLength)
    if (!localName.equals(entry.nameBytes)) {
      throw new Error(`local and central names disagree for "${entry.fileName}"`)
    }
    const extraProblem = extraFieldProblem(variable.subarray(nameLength))
    if (extraProblem) throw new Error(extraProblem)
    const dataStart = entry.localHeaderOffset + 30 + variableLength
    const dataEnd = addWithinFile(
      dataStart,
      entry.compressedSize,
      fileSize,
      `compressed data for "${entry.fileName}"`
    )
    if (dataEnd > directoryOffset) {
      throw new Error(`compressed data overlaps the central directory for "${entry.fileName}"`)
    }
    entry.dataStart = dataStart
    entry.dataEnd = dataEnd
    ranges.push({ start: entry.localHeaderOffset, end: dataEnd, name: entry.fileName })
  }
  ranges.sort((left, right) => left.start - right.start)
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index]!.start < ranges[index - 1]!.end) {
      throw new Error(
        `archive entries overlap: "${ranges[index - 1]!.name}" and "${ranges[index]!.name}"`
      )
    }
  }
  return entries
}

class OutputVerifier extends Transform {
  bytes = 0
  private crc = 0xffffffff

  constructor(
    private readonly entryLimit: number,
    private readonly total: { bytes: number },
    private readonly totalLimit: number
  ) {
    super()
  }

  get crc32(): number {
    return (this.crc ^ 0xffffffff) >>> 0
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.bytes += chunk.length
    this.total.bytes += chunk.length
    if (this.bytes > this.entryLimit) {
      callback(new Error('archive entry produced more bytes than allowed'))
      return
    }
    if (this.total.bytes > this.totalLimit) {
      callback(new Error('archive produced more total bytes than allowed'))
      return
    }
    this.crc = updateCrc32(this.crc, chunk)
    callback(null, chunk)
  }
}

function destinationPath(root: string, normalizedPath: string): string {
  const target = resolve(root, ...normalizedPath.split('/'))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('archive path escaped the extraction destination')
  }
  return target
}

async function makePrivate(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode)
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}

/**
 * Extract stored/deflated regular files only. All metadata and data ranges are
 * validated before the destination is created, and every file is streamed
 * through actual-byte and CRC checks into an exclusive output.
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
  options: ExtractZipOptions = {}
): Promise<void> {
  const limits = mergedLimits(options.limits)
  const handle = await open(zipPath, 'r')
  let destinationCreated = false
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('the ZIP source is not a regular file')
    const entries = await readCentralDirectory(handle, stat.size, limits)
    if (options.signal?.aborted) throw new Error('archive extraction was cancelled')

    await mkdir(destDir, { recursive: false, mode: 0o700 })
    destinationCreated = true
    await makePrivate(destDir, 0o700)
    const total = { bytes: 0 }
    for (const entry of entries) {
      if (options.signal?.aborted) throw new Error('archive extraction was cancelled')
      const target = destinationPath(destDir, entry.normalizedPath)
      if (entry.directory) {
        await mkdir(target, { recursive: true, mode: 0o700 })
        await makePrivate(target, 0o700)
        continue
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      const verifier = new OutputVerifier(
        Math.min(entry.uncompressedSize, limits.maxUncompressedBytesPerEntry),
        total,
        limits.maxTotalUncompressedBytes
      )
      const output = createWriteStream(target, { flags: 'wx', mode: 0o600 })
      try {
        if (entry.compressedSize === 0) {
          output.end()
          await new Promise<void>((resolvePromise, reject) => {
            output.once('finish', resolvePromise)
            output.once('error', reject)
          })
        } else {
          const input = createReadStream(zipPath, {
            fd: handle.fd,
            autoClose: false,
            start: entry.dataStart,
            end: entry.dataEnd - 1
          })
          if (entry.method === 8) {
            await pipeline(input, createInflateRaw(), verifier, output, {
              signal: options.signal
            })
          } else {
            await pipeline(input, verifier, output, { signal: options.signal })
          }
        }
        if (verifier.bytes !== entry.uncompressedSize) {
          throw new Error(`archive entry "${entry.fileName}" has the wrong uncompressed size`)
        }
        if (verifier.crc32 !== entry.crc32) {
          throw new Error(`archive entry "${entry.fileName}" failed its CRC32 check`)
        }
        await makePrivate(target, 0o600)
      } catch (error) {
        output.destroy()
        await rm(target, { force: true }).catch(() => undefined)
        throw error
      }
    }
  } catch (error) {
    if (destinationCreated) {
      try {
        await rm(destDir, { recursive: true, force: true })
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'archive extraction failed and partial output could not be removed'
        )
      }
    }
    throw error
  } finally {
    await handle.close()
  }
}
