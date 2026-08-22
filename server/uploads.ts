import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  createWriteStream,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream'
import type { Request, RequestHandler } from 'express'
import multer from 'multer'

export const UPLOAD_DIRECTORY_PREFIX = 'bored-manager-upload-'
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000

function privateMode(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch {
    // Windows and some mounted filesystems do not expose POSIX modes.
  }
}

export function cleanupStaleUploadDirs(
  baseDir = tmpdir(),
  now = Date.now(),
  maxAgeMs = STALE_UPLOAD_MS
): void {
  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(UPLOAD_DIRECTORY_PREFIX)) continue
      const path = join(baseDir, entry.name)
      try {
        if (now - statSync(path).mtimeMs >= maxAgeMs) {
          rmSync(path, { recursive: true, force: true })
        }
      } catch {
        // A concurrently removed or unreadable stale folder is harmless.
      }
    }
  } catch {
    // Temp cleanup is best effort; upload creation still reports real errors.
  }
}

export class PrivateUploadStaging {
  readonly root: string
  private readonly requestDirs = new WeakMap<Request, string>()
  private active = 0
  private disposed = false
  private readonly storage: multer.StorageEngine

  constructor(
    private readonly maxConcurrent = 4,
    baseDir = tmpdir()
  ) {
    cleanupStaleUploadDirs(baseDir)
    this.root = mkdtempSync(join(baseDir, UPLOAD_DIRECTORY_PREFIX))
    privateMode(this.root, 0o700)
    this.storage = {
      _handleFile: (req, file, callback) => {
        let dir: string
        try {
          dir = this.requestDir(req)
        } catch (error) {
          callback(error)
          return
        }

        const filename = randomBytes(24).toString('hex')
        const path = join(dir, filename)
        const output = createWriteStream(path, { flags: 'wx', mode: 0o600 })
        let size = 0
        file.stream.on('data', (chunk: Buffer | string) => {
          size += Buffer.byteLength(chunk)
        })
        pipeline(file.stream, output, (error) => {
          if (error) {
            rmSync(path, { force: true })
            callback(error)
            return
          }
          privateMode(path, 0o600)
          callback(null, { destination: dir, filename, path, size })
        })
      },
      _removeFile: (_req, file, callback) => {
        try {
          if (typeof file.path === 'string') rmSync(file.path, { force: true })
          callback(null)
        } catch (error) {
          callback(error as Error)
        }
      }
    }
  }

  get activeUploads(): number {
    return this.active
  }

  singleFile(maxBytes: number): RequestHandler {
    const parse = multer({
      storage: this.storage,
      limits: {
        fileSize: maxBytes,
        files: 1,
        fields: 0,
        // Busboy counts the closing boundary when deciding to emit partsLimit,
        // so two is the strict setting that permits exactly one file part.
        parts: 2,
        fieldNameSize: 32,
        headerPairs: 64
      }
    }).single('file')

    return (req, res, next) => {
      if (this.disposed) {
        res.status(503).json({
          ok: false,
          code: 'SERVER_SHUTTING_DOWN',
          error: 'Server is shutting down'
        })
        return
      }
      if (!req.is('multipart/form-data')) {
        res.status(415).json({
          ok: false,
          code: 'UNSUPPORTED_MEDIA_TYPE',
          error: 'Upload requires multipart/form-data'
        })
        return
      }
      if (this.active >= this.maxConcurrent) {
        res.status(429).json({
          ok: false,
          code: 'UPLOAD_BUSY',
          error: 'Too many uploads are in progress'
        })
        return
      }

      this.active++
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        this.active--
        this.cleanupRequest(req)
      }
      res.once('finish', release)
      res.once('close', release)

      parse(req, res, (error?: unknown) => {
        if (!error) {
          next()
          return
        }
        if (!(error instanceof multer.MulterError)) {
          next(error)
          return
        }
        const tooBig = error.code === 'LIMIT_FILE_SIZE'
        res.status(tooBig ? 413 : 400).json({
          ok: false,
          code: tooBig ? 'UPLOAD_TOO_LARGE' : 'INVALID_UPLOAD',
          error: tooBig ? 'The file is larger than the limit' : 'The upload is not valid'
        })
      })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    rmSync(this.root, { recursive: true, force: true })
  }

  private requestDir(req: Request): string {
    const existing = this.requestDirs.get(req)
    if (existing) return existing
    const dir = mkdtempSync(join(this.root, 'request-'))
    privateMode(dir, 0o700)
    this.requestDirs.set(req, dir)
    return dir
  }

  private cleanupRequest(req: Request): void {
    const dir = this.requestDirs.get(req)
    if (!dir) return
    this.requestDirs.delete(req)
    rmSync(dir, { recursive: true, force: true })
  }
}
