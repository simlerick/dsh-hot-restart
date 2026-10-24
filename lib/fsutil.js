/**
 * Durable filesystem helpers.
 *
 * Every write in this plugin goes through {@link writeFileAtomic} so a crash
 * mid-write can never leave a truncated ledger — the ledger is the only place
 * that remembers which conversation a restart owes a wake to.
 *
 * @module dsh-hot-restart/fsutil
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Create a directory tree.
 * @param dir - absolute directory path.
 * @param mode - permission bits applied when creating.
 */
export function ensureDir(dir, mode = 0o700) {
  mkdirSync(dir, { recursive: true, mode })
}

/**
 * Restrict a file to its owner. Best effort: Windows ignores POSIX modes.
 * @param file - absolute file path.
 * @param mode - permission bits.
 */
export function restrictPermissions(file, mode = 0o600) {
  try {
    chmodSync(file, mode)
  } catch {}
}

/**
 * Read a UTF-8 text file.
 * @param file - absolute file path.
 * @returns file content, or undefined when it does not exist.
 */
export function readTextFile(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Read and parse a JSON file.
 * @param file - absolute file path.
 * @param fallback - value returned when the file is missing or unparsable.
 * @returns parsed value or the fallback.
 */
export function readJsonFile(file, fallback) {
  const text = readTextFile(file)
  if (text === undefined) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * Replace a file's contents atomically (same-directory temp file + rename).
 * @param file - absolute file path.
 * @param text - complete new contents.
 * @param mode - permission bits.
 */
export function writeFileAtomic(file, text, mode = 0o600) {
  ensureDir(dirname(file))
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temporary, text, { mode })
  restrictPermissions(temporary, mode)
  try {
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }
}

/**
 * Serialize a value and replace a file atomically.
 * @param file - absolute file path.
 * @param value - JSON-serializable value.
 * @param mode - permission bits.
 */
export function writeJsonAtomic(file, value, mode = 0o600) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode)
}

/**
 * Delete a file, ignoring absence.
 * @param file - absolute file path.
 */
export function removeFile(file) {
  try {
    unlinkSync(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/**
 * File size in bytes.
 * @param file - absolute file path.
 * @returns size, or undefined when the file does not exist.
 */
export function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return undefined
  }
}
