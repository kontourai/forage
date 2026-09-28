/**
 * Charset-aware decoding of a textual response body.
 *
 * A snapshot keeps the exact bytes it received (`Snapshot.bytes`) and the
 * charset its `Content-Type` declared (`Snapshot.declaredCharset`). The text a
 * consumer reads (`Snapshot.body`) is derived from those two values by
 * `decodeTextBody`, and only by it, so a stored record can always re-derive
 * the same text from its bytes.
 */

/** A charset label worth recording: a bounded RFC 9110 token. */
const CHARSET_TOKEN = /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

export interface DeclaredCharset {
  /** The lower-cased `charset` parameter, or `null` when none was usable. */
  charset: string | null;
  warnings: string[];
}

/** Read the `charset` parameter of a `Content-Type` value. */
export function parseDeclaredCharset(contentType: string | null | undefined): DeclaredCharset {
  if (!contentType) return { charset: null, warnings: [] };
  for (const parameter of contentType.split(";").slice(1)) {
    const separator = parameter.indexOf("=");
    if (separator === -1) continue;
    if (parameter.slice(0, separator).trim().toLowerCase() !== "charset") continue;
    let value = parameter.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1).trim();
    }
    value = value.toLowerCase();
    if (CHARSET_TOKEN.test(value)) return { charset: value, warnings: [] };
    return {
      charset: null,
      warnings: ["content-type declares a malformed charset parameter; decoded as utf-8"],
    };
  }
  return { charset: null, warnings: [] };
}

export function isRecordableCharset(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && CHARSET_TOKEN.test(value));
}

export interface DecodedTextBody {
  text: string;
  /** The WHATWG encoding actually used, e.g. `windows-1252` for `latin1`. */
  encoding: string;
  warnings: string[];
}

/**
 * Decode `bytes` with the declared charset, or UTF-8 when none is declared.
 *
 * - An unknown label falls back to UTF-8 and reports a warning.
 * - Bytes that are invalid in the chosen encoding become U+FFFD and report a
 *   warning. The raw bytes are unaffected.
 * - A leading byte-order mark that matches the chosen encoding is removed from
 *   the text (WHATWG `TextDecoder` default). A BOM never overrides the
 *   declared charset. The raw bytes always keep the BOM.
 */
export function decodeTextBody(bytes: Uint8Array, declaredCharset: string | null): DecodedTextBody {
  const warnings: string[] = [];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(declaredCharset ?? "utf-8", { fatal: false, ignoreBOM: false });
  } catch {
    warnings.push(`unknown charset "${declaredCharset}"; decoded as utf-8`);
    decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  }
  const text = decoder.decode(bytes);
  try {
    new TextDecoder(decoder.encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    warnings.push(`body is not valid ${decoder.encoding}; invalid bytes were replaced with U+FFFD`);
  }
  return { text, encoding: decoder.encoding, warnings };
}
