// Inline SVG icon set matching the prototype's icon names.
// 14×14 default size; stroke-currentColor so they inherit the surrounding text color.
// Naming matches `shell.jsx` and `mobile-shell.jsx`: home, eye, users, mountain,
// video, book, school, file, cycle, pdf, table, shield, lock, settings, upload,
// chat, plus, download, chev, chevd, check, play, whatsapp.

type IconProps = {
  name: string;
  size?: number;
  stroke?: number;
  className?: string;
};

const PATHS: Record<string, string> = {
  home: "M3 11l9-8 9 8M5 9.5V20h5v-6h4v6h5V9.5",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 100 6 3 3 0 000-6z",
  users: "M9 11a4 4 0 100-8 4 4 0 000 8zM1 21v-1a6 6 0 0112 0v1M17 11a3 3 0 100-6 3 3 0 000 6zM21 21v-1a4 4 0 00-4-4",
  mountain: "M2 20l7-12 4 7 3-5 6 10z",
  video: "M3 5h12v14H3zM15 9l5-3v12l-5-3z",
  book: "M4 4h11a3 3 0 013 3v13H7a3 3 0 01-3-3V4zM4 4v13",
  school: "M3 10l9-5 9 5-9 5-9-5zM5 12v5l7 4 7-4v-5",
  file: "M6 3h9l4 4v14H6zM15 3v5h4",
  cycle: "M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5",
  pdf: "M6 3h9l4 4v14H6zM9 13h2a2 2 0 010 4H9zm0 0v-3m6 3h-3v-3m3 3v3",
  table: "M3 5h18v14H3zM3 10h18M9 5v14",
  shield: "M12 2l9 3v6c0 5-4 9-9 11-5-2-9-6-9-11V5z",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 018 0v4",
  settings: "M12 8a4 4 0 100 8 4 4 0 000-8zM3 12h2m14 0h2M12 3v2m0 14v2m-7-7l-2-2m16 2l2-2M5 19l2-2m12 2l-2-2",
  upload: "M12 16V4M6 10l6-6 6 6M4 20h16",
  chat: "M3 4h18v12H8l-5 5z",
  plus: "M5 12h14M12 5v14",
  menu: "M4 6h16M4 12h16M4 18h16",
  download: "M12 4v12M6 14l6 6 6-6M4 20h16",
  chev: "M9 6l6 6-6 6",
  chevd: "M6 9l6 6 6-6",
  check: "M5 12l5 5L20 6",
  play: "M6 4l14 8-14 8z",
  whatsapp: "M12 3a9 9 0 00-7.7 13.6L3 21l4.6-1.2A9 9 0 1012 3zM8 9c0-1 1-2 2-2h1l1 3-2 1c.5 1.5 2 3 3.5 3.5l1-2 3 1v1c0 1-1 2-2 2-4 0-7-3-7-7z",
};

export function Icon({ name, size = 14, stroke = 1.5, className }: IconProps) {
  const d = PATHS[name];
  if (!d) {
    return <span aria-hidden className={className} style={{ width: size, height: size, display: "inline-block" }} />;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}
