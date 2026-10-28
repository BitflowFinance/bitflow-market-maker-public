import qrcode from 'qrcode-generator';

/** A wallet address as a scannable code. Drawn dark-on-white in both themes, since that is what phone cameras read best. */
export function QrCode({ text, size = 148 }: { text: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2;
  const cells: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) cells.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
    }
  }
  const box = count + quiet * 2;
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${box} ${box}`} role="img" aria-label={`QR code for ${text}`} shapeRendering="crispEdges">
      <rect width={box} height={box} fill="#fff" />
      <path d={cells.join('')} fill="#0b0e0b" />
    </svg>
  );
}
