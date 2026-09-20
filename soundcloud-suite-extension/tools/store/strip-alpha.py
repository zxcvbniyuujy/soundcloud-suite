#!/usr/bin/env python3
"""Rewrite an 8-bit RGBA PNG as a 24-bit RGB PNG (alpha composited over a solid colour).
The Chrome Web Store wants 'JPEG or 24-bit PNG (no alpha)' for screenshots and tiles."""
import struct, sys, zlib
def chunks(b):
    i = 8
    while i < len(b):
        n, = struct.unpack('>I', b[i:i+4]); t = b[i+4:i+8]; yield t, b[i+8:i+8+n]; i += 12 + n
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
def paeth(a, b, c):
    p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else (b if pb <= pc else c)
def convert(src, dst, bg=(255, 255, 255)):
    b = open(src, 'rb').read(); assert b[:8] == b'\x89PNG\r\n\x1a\n'
    w = h = 0; ct = 0; idat = b''
    for t, d in chunks(b):
        if t == b'IHDR': w, h, bd, ct = struct.unpack('>IIBB', d[:10]); assert bd == 8, 'need 8-bit'
        elif t == b'IDAT': idat += d
    bpp = {6: 4, 2: 3}[ct]
    raw = zlib.decompress(idat); stride = w * bpp; out = bytearray(); prev = bytearray(stride); pos = 0
    for y in range(h):
        f = raw[pos]; line = bytearray(raw[pos+1:pos+1+stride]); pos += 1 + stride
        for x in range(stride):
            a = line[x-bpp] if x >= bpp else 0; u = prev[x]; c = prev[x-bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + u) & 255
            elif f == 3: line[x] = (line[x] + ((a + u) >> 1)) & 255
            elif f == 4: line[x] = (line[x] + paeth(a, u, c)) & 255
        prev = line
        row = bytearray(b'\x00')
        if bpp == 3: row += line
        else:
            for x in range(0, stride, 4):
                al = line[x+3]
                if al == 255: row += line[x:x+3]
                else: row += bytes(((line[x+i] * al + bg[i] * (255 - al) + 127) // 255) for i in range(3))
        out += row
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    open(dst, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(out), 9)) + chunk(b'IEND', b''))
    return w, h
if __name__ == '__main__':
    for src in sys.argv[1:]:
        w, h = convert(src, src); print(f'{src}: {w}x{h} → 24-bit RGB')
