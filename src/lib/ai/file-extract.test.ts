import JSZip from 'jszip'
import { crc32, deflateRawSync, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXTRACT_LIMITS, detectFileKind, extractFileText, FILE_MAX_BYTES, FILE_TEXT_MAX_CHARS, FileExtractError, normalizeExtractedText } from './file-extract'
import { openDocxZip } from './file-extract-worker'

/** A one-page PDF with the given text, xref offsets computed so pdf.js reads it cleanly. */
function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}

async function makeDocx(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
    paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof FileExtractError ? e.code : String(e)))

describe('detectFileKind', () => {
  it('trusts the bytes over the name', () => {
    expect(detectFileKind(makePdf('x'), 'notes.txt', 'text/plain')).toBe('pdf')
    expect(detectFileKind(new Uint8Array([0x50, 0x4b, 3, 4, 0]), 'a.docx', '')).toBe('docx')
    expect(detectFileKind(new Uint8Array([0x50, 0x4b, 3, 4, 0]), 'a.zip', 'application/zip')).toBeNull()
    expect(detectFileKind(Buffer.from('hello'), 'a.md', '')).toBe('text')
    expect(detectFileKind(Buffer.from('MZ\0\0'), 'a.txt', 'text/plain')).toBeNull()
    expect(detectFileKind(Buffer.from('<svg/>'), 'a.svg', 'image/svg+xml')).toBeNull()
  })
})

describe('extractFileText', () => {
  it('reads a PDF', async () => {
    const out = await extractFileText(makePdf('Refunds take five days'), { name: 'policy.pdf', contentType: 'application/pdf' })
    expect(out.kind).toBe('pdf')
    expect(out.pages).toBe(1)
    expect(out.text).toContain('Refunds take five days')
  })

  it('reads a DOCX as paragraphs', async () => {
    const out = await extractFileText(await makeDocx(['Opening hours', 'Monday to Friday']), { name: 'faq.docx', contentType: DOCX })
    expect(out.kind).toBe('docx')
    expect(out.text).toContain('Opening hours')
    expect(out.text).toContain('Monday to Friday')
  })

  it('reads UTF-8 text and caps its length', async () => {
    const out = await extractFileText(Buffer.from('a'.repeat(FILE_TEXT_MAX_CHARS + 10)), { name: 'big.txt', contentType: 'text/plain' })
    expect(out.text).toHaveLength(FILE_TEXT_MAX_CHARS)
    expect(out.truncated).toBe(true)
  })

  it('refuses empty, oversized, unsupported and corrupt files', async () => {
    expect(await code(extractFileText(new Uint8Array(0), { name: 'a.txt', contentType: 'text/plain' }))).toBe('empty')
    expect(await code(extractFileText(Buffer.from('   \n  '), { name: 'a.txt', contentType: 'text/plain' }))).toBe('empty')
    expect(await code(extractFileText(new Uint8Array(FILE_MAX_BYTES + 1), { name: 'a.txt', contentType: 'text/plain' }))).toBe('too_large')
    expect(await code(extractFileText(Buffer.from('GIF89a'), { name: 'a.gif', contentType: 'image/gif' }))).toBe('unsupported_type')
    expect(await code(extractFileText(Buffer.from([0xff, 0xfe, 0x41]), { name: 'a.txt', contentType: 'text/plain' }))).toBe('unreadable')
    expect(await code(extractFileText(Buffer.from('%PDF-1.4 garbage'), { name: 'a.pdf', contentType: 'application/pdf' }))).toBe('unreadable')
    expect(await code(extractFileText(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]), { name: 'a.docx', contentType: DOCX }))).toBe('unreadable')
  })

  it('leaves the caller buffer intact and runs several extractions at once', async () => {
    const pdf = makePdf('Shared buffer')
    const outs = await Promise.all([1, 2, 3, 4].map(() => extractFileText(pdf, { name: 'a.pdf', contentType: 'application/pdf' })))
    expect(outs.every((o) => o.text.includes('Shared buffer'))).toBe(true)
    expect(pdf.byteLength).toBeGreaterThan(0)
  })
})

/** A deflated zip built by hand so a test can lie about the uncompressed sizes. */
function makeZip(entries: Array<[string, Buffer]>, declaredSize?: number, flags = 0): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, data] of entries) {
    const packed = deflateRawSync(data)
    const nameBytes = Buffer.from(name)
    const size = declaredSize ?? data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, packed)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + packed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'

/** A DOCX whose document.xml really inflates to `bytes`, while the zip directory claims 1 KB. */
function makeDocxBomb(bytes: number): Buffer {
  const head = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'
  const tail = '</w:t></w:r></w:p></w:body></w:document>'
  const xml = Buffer.alloc(bytes, 'a')
  xml.write(head, 0)
  xml.write(tail, bytes - tail.length)
  return makeZip([['_rels/.rels', Buffer.from(RELS)], ['word/document.xml', xml]], 1024)
}

/** A one-page PDF whose content stream is `content`, FlateDecoded. */
function makeFlatePdf(content: Buffer): Uint8Array {
  const packed = deflateSync(content, { level: 9 })
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets: number[] = []
  const length = () => parts.reduce((n, p) => n + p.length, 0)
  const add = (body: Buffer | string) => {
    offsets.push(length())
    parts.push(Buffer.from(`${offsets.length} 0 obj\n`, 'latin1'), typeof body === 'string' ? Buffer.from(body, 'latin1') : body, Buffer.from('\nendobj\n', 'latin1'))
  }
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>')
  add(Buffer.concat([Buffer.from(`<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), packed, Buffer.from('\nendstream', 'latin1')]))
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const xref = length()
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'))
  return new Uint8Array(Buffer.concat(parts))
}

/** A PDF whose only content stream FlateDecodes to `bytes` of spaces. */
const makePdfBomb = (bytes: number) => makeFlatePdf(Buffer.alloc(bytes, ' '))

describe('extraction bounds', () => {
  it('refuses a DOCX that inflates past the cap although its directory claims 1 KB, quickly', async () => {
    const bomb = makeDocxBomb(DEFAULT_EXTRACT_LIMITS.maxUnpackedBytes + 40 * 1024 * 1024)
    expect(bomb.length).toBeLessThan(FILE_MAX_BYTES)
    const started = Date.now()
    expect(await code(extractFileText(bomb, { name: 'bomb.docx', contentType: DOCX }))).toBe('too_large')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('reads a DOCX built by hand with honest sizes', async () => {
    const xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hand made</w:t></w:r></w:p></w:body></w:document>'
    const out = await extractFileText(makeZip([['_rels/.rels', Buffer.from(RELS)], ['word/document.xml', Buffer.from(xml)]]), { name: 'a.docx', contentType: DOCX })
    expect(out.text).toBe('Hand made')
  })

  it('refuses a PDF whose content stream is a decompression bomb, quickly', async () => {
    const bomb = makePdfBomb(200 * 1024 * 1024)
    const started = Date.now()
    expect(await code(extractFileText(bomb, { name: 'bomb.pdf', contentType: 'application/pdf' }, { ...DEFAULT_EXTRACT_LIMITS, allocBudgetBytes: 32 * 1024 * 1024 }))).toBe('too_large')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('stops a parse that overruns the wall-clock limit', async () => {
    const started = Date.now()
    expect(await code(extractFileText(makePdf('slow'), { name: 'a.pdf', contentType: 'application/pdf' }, { ...DEFAULT_EXTRACT_LIMITS, timeoutMs: 1 }))).toBe('too_large')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('maps a worker heap overrun to too_large', async () => {
    // Hundreds of thousands of separately placed text runs become JS objects on the worker heap.
    const runs = Buffer.from(Array.from({ length: 150_000 }, (_, i) => `BT /F1 1 Tf ${(i * 7) % 600} ${Math.floor(i / 600) % 780} Td (w${i % 10}) Tj ET`).join(' '), 'latin1')
    const pdf = makeFlatePdf(runs)
    expect(await code(extractFileText(pdf, { name: 'a.pdf', contentType: 'application/pdf' }, { ...DEFAULT_EXTRACT_LIMITS, heapMb: 16 }))).toBe('too_large')
    // The same file passes with the normal heap, so the refusal above came from the cap.
    expect(await code(extractFileText(pdf, { name: 'a.pdf', contentType: 'application/pdf' }))).toBe('ok')
  }, 30_000)
})

describe('openDocxZip', () => {
  it('ignores the declared sizes and caps the real output', async () => {
    const zip = openDocxZip(makeZip([['big.xml', Buffer.alloc(4096, 'a')]], 10), 1000)
    await expect(zip.read('big.xml', 'utf-8')).rejects.toMatchObject({ code: 'too_large' })
    expect(zip.overCap()).toBe(true)
  })

  it('shares one cap across every part read', async () => {
    const zip = openDocxZip(makeZip([['a.xml', Buffer.alloc(600, 'a')], ['b.xml', Buffer.alloc(600, 'b')]]), 1000)
    expect(await zip.read('a.xml', 'utf-8')).toHaveLength(600)
    await expect(zip.read('b.xml', 'utf-8')).rejects.toMatchObject({ code: 'too_large' })
  })

  it('refuses encrypted, truncated and non-zip input', () => {
    expect(() => openDocxZip(makeZip([['a.xml', Buffer.from('x')]], undefined, 1), 1000)).toThrow(expect.objectContaining({ code: 'unreadable' }))
    const zip = makeZip([['a.xml', Buffer.from('x'.repeat(100))]])
    expect(() => openDocxZip(Buffer.concat([zip.subarray(0, 40), zip.subarray(zip.length - 22)]), 1000)).toThrow(expect.objectContaining({ code: 'unreadable' }))
    expect(() => openDocxZip(Buffer.from('not a zip'), 1000)).toThrow(expect.objectContaining({ code: 'unreadable' }))
    expect(openDocxZip(zip, 1000).exists('a.xml')).toBe(true)
  })
})

describe('normalizeExtractedText', () => {
  it('strips control characters and collapses blank lines', () => {
    expect(normalizeExtractedText('a\u0000b\r\n\r\n\r\n\r\n  c\t d ')).toBe('ab\n\nc d')
  })
})
