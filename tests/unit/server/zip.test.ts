import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { extractZip } from '../../../server/services/zip'
import { withTestTempDir } from '../../helpers/temp-dir'

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

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface TestEntry {
  name: string
  data?: Buffer | string
  method?: 0 | 8
  flags?: number
  crc?: number
  compressedSize?: number
  uncompressedSize?: number
  externalAttributes?: number
}

interface TestZipOptions {
  disk?: number
  directoryOffset?: number
}

function makeZip(entries: TestEntry[], options: TestZipOptions = {}): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8')
    const data = Buffer.isBuffer(item.data)
      ? item.data
      : Buffer.from(item.data ?? '', 'utf8')
    const method = item.method ?? 8
    const flags = item.flags ?? 0x0800
    const compressed = method === 8 ? deflateRawSync(data) : data
    const declaredCompressed = item.compressedSize ?? compressed.length
    const declaredUncompressed = item.uncompressedSize ?? data.length
    const declaredCrc = item.crc ?? crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(declaredCrc, 14)
    local.writeUInt32LE(declaredCompressed, 18)
    local.writeUInt32LE(declaredUncompressed, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(declaredCrc, 16)
    central.writeUInt32LE(declaredCompressed, 20)
    central.writeUInt32LE(declaredUncompressed, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(item.externalAttributes ?? (item.name.endsWith('/') ? 0x41ed0010 : 0x81a40000), 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const directory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(options.disk ?? 0, 4)
  eocd.writeUInt16LE(options.disk ?? 0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(options.directoryOffset ?? offset, 16)
  return Buffer.concat([...localParts, directory, eocd])
}

async function expectRejected(zip: Buffer, pattern: RegExp): Promise<void> {
  await withTestTempDir(async (root) => {
    const archive = join(root, 'test.zip')
    const output = join(root, 'output')
    writeFileSync(archive, zip)
    await expect(extractZip(archive, output)).rejects.toThrow(pattern)
    expect(existsSync(output)).toBe(false)
  }, 'zip-reject')
}

describe('safe ZIP extraction', () => {
  it('streams stored and deflated files with exact size and CRC checks', async () => {
    await withTestTempDir(async (root) => {
      const archive = join(root, 'valid.zip')
      const output = join(root, 'output')
      writeFileSync(
        archive,
        makeZip([
          { name: 'folder/', method: 0 },
          { name: 'folder/stored.txt', data: 'stored', method: 0 },
          { name: 'folder/deflated.txt', data: 'deflated', method: 8 }
        ])
      )
      await extractZip(archive, output)
      expect(readFileSync(join(output, 'folder', 'stored.txt'), 'utf8')).toBe('stored')
      expect(readFileSync(join(output, 'folder', 'deflated.txt'), 'utf8')).toBe('deflated')
    }, 'zip-valid')
  })

  it('rejects forged or truncated ranges before allocation or extraction', async () => {
    await expectRejected(
      makeZip([{ name: 'file.txt', data: 'small', compressedSize: 100_000 }]),
      /outside|overlaps/
    )
    const wrongOffset = makeZip([{ name: 'file.txt', data: 'small' }], {
      directoryOffset: 0xfffffff0
    })
    await expectRejected(wrongOffset, /central-directory offset|outside/)
  })

  it('caps declared and actual expansion and compression ratio', async () => {
    const archive = makeZip([{ name: 'bomb.txt', data: Buffer.alloc(64 * 1024, 65) }])
    await withTestTempDir(async (root) => {
      const zipPath = join(root, 'bomb.zip')
      const output = join(root, 'output')
      writeFileSync(zipPath, archive)
      await expect(
        extractZip(zipPath, output, {
          limits: { maxCompressionRatio: 2, maxUncompressedBytesPerEntry: 128 * 1024 }
        })
      ).rejects.toThrow(/compression-ratio/)
      expect(existsSync(output)).toBe(false)
    }, 'zip-bomb')

    await withTestTempDir(async (root) => {
      const zipPath = join(root, 'actual-cap.zip')
      const output = join(root, 'output')
      writeFileSync(zipPath, makeZip([{ name: 'large.txt', data: '123456', uncompressedSize: 3 }]))
      await expect(extractZip(zipPath, output)).rejects.toThrow(/more bytes|wrong uncompressed/)
      expect(existsSync(output)).toBe(false)
    }, 'zip-actual-cap')
  })

  it('rejects CRC mismatches and removes partial output', async () => {
    await expectRejected(
      makeZip([{ name: 'bad.txt', data: 'content', crc: 0x12345678 }]),
      /CRC32/
    )
  })

  it.each(['../escape', '/absolute', 'C:/drive', '\\\\server\\share', 'a/./b', 'a//b'])(
    'rejects unsafe path %s',
    async (name) => {
      await expectRejected(makeZip([{ name, data: 'x' }]), /absolute|unsafe|backslash/)
    }
  )

  it('rejects duplicate normalized paths and file/directory collisions', async () => {
    await expectRejected(
      makeZip([
        { name: 'Folder/file', data: 'a' },
        { name: 'folder/FILE', data: 'b' }
      ]),
      /duplicate/
    )
    await expectRejected(
      makeZip([
        { name: 'parent', data: 'a' },
        { name: 'parent/child', data: 'b' }
      ]),
      /below a file|both a file/
    )
  })

  it('rejects symlink and special-file modes', async () => {
    await expectRejected(
      makeZip([{ name: 'link', data: 'target', externalAttributes: 0xa1ff0000 }]),
      /symlink or special-file/
    )
  })

  it('rejects encryption, ZIP64 sentinels, and multi-disk archives', async () => {
    await expectRejected(
      makeZip([{ name: 'secret', data: 'x', flags: 0x0801 }]),
      /encrypted/
    )
    await expectRejected(
      makeZip([{ name: 'huge', compressedSize: 0xffffffff, uncompressedSize: 0xffffffff }]),
      /ZIP64/
    )
    await expectRejected(makeZip([{ name: 'file', data: 'x' }], { disk: 1 }), /multi-disk/)
  })
})
