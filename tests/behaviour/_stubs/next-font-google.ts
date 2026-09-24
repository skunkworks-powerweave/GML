// Stands in for `next/font/google` (see ../_ui.ts). The real module is a
// build-time transform. Each loader returns the shape the app reads, with the
// CSS variable name it was asked for so a test can see which fonts the root
// layout wires onto <html>.

type FontOptions = { variable?: string };
type FontResult = { className: string; variable: string; style: { fontFamily: string } };

function loader(family: string) {
  return (opts: FontOptions = {}): FontResult => ({
    className: `font-${family}`,
    variable: opts.variable ? `fontvar${opts.variable}` : `font-${family}`,
    style: { fontFamily: family },
  });
}

export const Geist = loader("Geist");
export const Geist_Mono = loader("Geist_Mono");
export const Noto_Sans_Devanagari = loader("Noto_Sans_Devanagari");
export const Noto_Serif_Tibetan = loader("Noto_Serif_Tibetan");
