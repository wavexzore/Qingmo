use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{LineEnding, TextEncoding, TextFormat};

#[derive(Debug)]
pub struct DecodedText {
    pub text: String,
    pub format: TextFormat,
    pub mixed_eol: bool,
}

/// Strictly decodes the supported P1 encodings.
///
/// UTF-32 and UTF-16 without a BOM are rejected. The returned text is always
/// LF-only; the original line ending is kept in `format.eol`.
pub fn decode(bytes: &[u8]) -> Result<DecodedText, AppError> {
    if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) || bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF])
    {
        return Err(unsupported("UTF-32 is not supported"));
    }

    let (encoding, bom_len) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (TextEncoding::Utf8, 3)
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        (TextEncoding::Utf16Le, 2)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        (TextEncoding::Utf16Be, 2)
    } else {
        (TextEncoding::Utf8, 0)
    };

    let body = &bytes[bom_len..];
    let raw_text = match encoding {
        TextEncoding::Utf8 => encoding_rs::UTF_8
            .decode_without_bom_handling_and_without_replacement(body)
            .map(|text| text.into_owned())
            .ok_or_else(|| unsupported("invalid UTF-8"))?,
        TextEncoding::Utf16Le => decode_utf16(body, true)?,
        TextEncoding::Utf16Be => decode_utf16(body, false)?,
    };

    if raw_text.contains('\0') {
        return Err(unsupported(
            "NUL bytes are not allowed; this is not a Markdown text file",
        ));
    }

    let (eol, mixed_eol) = detect_line_endings(&raw_text);
    let text = normalize_lf(&raw_text);

    Ok(DecodedText {
        text,
        format: TextFormat {
            encoding,
            has_bom: bom_len > 0,
            eol,
        },
        mixed_eol,
    })
}

pub fn detect_line_endings(text: &str) -> (LineEnding, bool) {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut cr = 0usize;
    let mut chars = text.chars().peekable();

    while let Some(character) = chars.next() {
        match character {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                    crlf += 1;
                } else {
                    cr += 1;
                }
            }
            '\n' => lf += 1,
            _ => {}
        }
    }

    let kinds = usize::from(crlf > 0) + usize::from(lf > 0) + usize::from(cr > 0);
    if kinds > 1 {
        (LineEnding::Lf, true)
    } else if crlf > 0 {
        (LineEnding::Crlf, false)
    } else if cr > 0 {
        (LineEnding::Cr, false)
    } else {
        (LineEnding::Lf, false)
    }
}

pub fn normalize_lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> Result<String, AppError> {
    if !bytes.len().is_multiple_of(2) {
        return Err(unsupported("UTF-16 byte length must be even"));
    }

    let units = bytes
        .chunks_exact(2)
        .map(|chunk| {
            if little_endian {
                u16::from_le_bytes([chunk[0], chunk[1]])
            } else {
                u16::from_be_bytes([chunk[0], chunk[1]])
            }
        })
        .collect::<Vec<_>>();

    String::from_utf16(&units).map_err(|_| unsupported("invalid UTF-16 surrogate pair"))
}

fn unsupported(message: &str) -> AppError {
    AppError::new(AppErrorCode::UnsupportedEncoding, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(result: Result<DecodedText, AppError>) -> AppErrorCode {
        result.expect_err("expected an error").code
    }

    #[test]
    fn decodes_plain_utf8() {
        let decoded = decode(b"# Title\n\nbody\n").expect("UTF-8 must decode");
        assert_eq!(decoded.format.encoding, TextEncoding::Utf8);
        assert!(!decoded.format.has_bom);
        assert_eq!(decoded.format.eol, LineEnding::Lf);
        assert_eq!(decoded.text, "# Title\n\nbody\n");
    }

    #[test]
    fn strips_utf8_bom() {
        let decoded = decode(b"\xEF\xBB\xBFhello").expect("UTF-8 BOM must decode");
        assert!(decoded.format.has_bom);
        assert_eq!(decoded.text, "hello");
    }

    #[test]
    fn decodes_utf16le_with_bom() {
        let decoded = decode(&[0xFF, 0xFE, b'h', 0, b'i', 0]).expect("UTF-16LE must decode");
        assert_eq!(decoded.format.encoding, TextEncoding::Utf16Le);
        assert!(decoded.format.has_bom);
        assert_eq!(decoded.text, "hi");
    }

    #[test]
    fn decodes_utf16be_with_bom() {
        let decoded = decode(&[0xFE, 0xFF, 0, b'h', 0, b'i']).expect("UTF-16BE must decode");
        assert_eq!(decoded.format.encoding, TextEncoding::Utf16Be);
        assert_eq!(decoded.text, "hi");
    }

    #[test]
    fn rejects_utf32_boms() {
        for bytes in [
            [0xFF, 0xFE, 0x00, 0x00].as_slice(),
            [0x00, 0x00, 0xFE, 0xFF].as_slice(),
        ] {
            assert_eq!(code(decode(bytes)), AppErrorCode::UnsupportedEncoding);
        }
    }

    #[test]
    fn rejects_utf16_without_bom() {
        assert_eq!(
            code(decode(&[b'h', 0, b'i', 0])),
            AppErrorCode::UnsupportedEncoding
        );
    }

    #[test]
    fn rejects_invalid_utf8_and_nul() {
        assert_eq!(code(decode(&[0xFF])), AppErrorCode::UnsupportedEncoding);
        assert_eq!(code(decode(b"a\0b")), AppErrorCode::UnsupportedEncoding);
        // A UTF-16 NUL code unit is also rejected: Markdown text must not
        // contain NUL, and accepting it would hide binary files.
        assert_eq!(
            code(decode(&[0xFF, 0xFE, b'a', 0, 0, 0, b'b', 0])),
            AppErrorCode::UnsupportedEncoding
        );
    }

    #[test]
    fn rejects_odd_utf16_and_unpaired_surrogates() {
        assert_eq!(
            code(decode(&[0xFF, 0xFE, b'h'])),
            AppErrorCode::UnsupportedEncoding
        );
        assert_eq!(
            code(decode(&[0xFF, 0xFE, 0x00, 0xD8])),
            AppErrorCode::UnsupportedEncoding
        );
    }

    #[test]
    fn detects_and_normalizes_line_endings() {
        let decoded = decode(b"a\r\nb\nc\rd").expect("mixed EOL must decode");
        assert!(decoded.format.eol == LineEnding::Lf);
        assert_eq!(decoded.text, "a\nb\nc\nd");

        let (eol, mixed) = detect_line_endings("a\r\nb\r\n");
        assert_eq!(eol, LineEnding::Crlf);
        assert!(!mixed);

        let (eol, mixed) = detect_line_endings("a\rb\r");
        assert_eq!(eol, LineEnding::Cr);
        assert!(!mixed);

        let (_, mixed) = detect_line_endings("a\r\nb\n");
        assert!(mixed);
    }

    #[test]
    fn counts_utf16_code_units() {
        let decoded = decode("a😀".as_bytes()).expect("UTF-8 must decode");
        assert_eq!(decoded.text.encode_utf16().count(), 3);
    }
}
