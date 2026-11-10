import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { z } from 'zod'

/** A YAML or JSON file that failed to parse or validate. */
export class InputFileError extends Error {
  readonly path: string

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`)
    this.name = 'InputFileError'
    this.path = path
  }
}

/**
 * Reads a YAML (or JSON) file and validates it against a schema.
 * @param path - file to read.
 * @param schema - schema the parsed document must satisfy.
 * @returns the validated document.
 */
export async function readDocument<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
  const text = await readFile(path, 'utf8')
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    throw new InputFileError(path, `not valid YAML: ${(error as Error).message}`)
  }
  const result = schema.safeParse(raw)
  if (!result.success) throw new InputFileError(path, z.prettifyError(result.error))
  return result.data
}
